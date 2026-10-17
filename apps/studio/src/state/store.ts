import {
  parseEvent,
  SequenceBuffer,
  type AnyEvent,
  type RunDetailResponse,
  type RunStatus,
  type RunSummary,
} from '@runloop-world/events';
import { initialRunState, ReplayIndex, type RunState } from '@runloop-world/replay';
import { arrivalTick, loadWorld, type CompiledWorld } from '@runloop-world/world-engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CameraMode, Quality, SceneFrame } from '../scene/types';
import { advancePlayback, nextEventTime, prevEventTime } from './playback';

export type Speed = 0.5 | 1 | 2 | 4;
export const SPEEDS: readonly Speed[] = [0.5, 1, 2, 4];

/**
 * Where the playhead is. Live follows the run in (estimated) server time;
 * replay is a fixed time since run start that only the user (or playback) moves.
 */
export type Cursor = { mode: 'live' } | { mode: 'replay'; tMs: number; playing: boolean; speed: Speed };

export type Tab = 'timeline' | 'logs' | 'state' | 'metadata';
export type ConnStatus = 'idle' | 'loading' | 'streaming' | 'reconnecting' | 'complete' | 'error';
export type RuntimeStatus = 'unknown' | 'online' | 'offline';

/** Something received that is not a valid event envelope (kept so the Logs tab can show it). */
export interface RawEntry {
  id: number;
  receivedAt: number;
  raw: unknown;
  error: string;
  sequence: number | null;
}

export interface StudioState {
  // ── runtime + runs list ───────────────────────────────────────────
  runtime: { status: RuntimeStatus; version: string | null; activeRunId: string | null };
  runs: RunSummary[];

  // ── the open run ─────────────────────────────────────────────────
  runId: string | null;
  run: RunSummary | null;
  world: CompiledWorld | null;
  loadError: string | null;
  conn: ConnStatus;
  /** Data-integrity problems worth showing (sequence conflicts, fold errors). */
  warnings: string[];
  /** Highest contiguous sequence received (the replay index holds 1..lastSequence). */
  lastSequence: number;
  /** Time of the last event since run start. */
  durationMs: number;
  /** End of the scrubbable range once characters finished walking (≥ durationMs). */
  settleMs: number;
  /** The run reached a terminal status. */
  ended: boolean;
  raw: RawEntry[];
  /** Missing sequences blocking release, if any. */
  gap: { from: number; to: number } | null;

  // ── playhead ─────────────────────────────────────────────────────
  cursor: Cursor;
  /** Sequence at the playhead (live → lastSequence; replay → seqAtTime(tMs)). */
  playheadSeq: number;
  /** Events that arrived while the cursor was in replay. */
  newSinceReplay: number;
  /** Replay speed preference (also used when a replay starts from live). */
  speed: Speed;

  // ── selection + view options ─────────────────────────────────────
  selectedAgentId: string | null;
  selectedStationId: string | null;
  tab: Tab;
  cameraMode: CameraMode;
  follow: boolean;
  quality: Quality;
  reducedMotion: boolean;
  /** Artifact open in the viewer. */
  viewArtifactId: string | null;

  // ── actions ──────────────────────────────────────────────────────
  setRuntime(r: Partial<StudioState['runtime']>): void;
  setRuns(runs: RunSummary[]): void;
  /** Forget the current run and start loading `runId` (null = nothing open). */
  openRun(runId: string | null): void;
  loadRun(detail: RunDetailResponse): void;
  setLoadError(message: string): void;
  setConn(conn: ConnStatus): void;
  /** Parse and add raw events. `live` = pushed by the stream (may fire effects). */
  ingest(raws: readonly unknown[], source: 'backlog' | 'live'): void;
  /** The server said the run is terminal (SSE `end`). */
  markEnded(status: RunStatus, lastSequence: number): void;
  /** Gap that has stayed open long enough to backfill (re-armed after each call). */
  gapToBackfill(): { from: number; to: number } | null;

  goLive(): void;
  seek(tMs: number): void;
  seekToSeq(seq: number): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  stepNext(): void;
  stepPrev(): void;
  setSpeed(speed: Speed): void;
  /** Advance replay playback by wall-clock `dtMs` (called every animation frame). */
  advance(dtMs: number): void;

  selectAgent(agentId: string | null): void;
  selectStation(stationId: string | null): void;
  cycleAgent(dir: 1 | -1): void;
  setTab(tab: Tab): void;
  setCameraMode(mode: CameraMode): void;
  toggleFollow(): void;
  setQuality(q: Quality): void;
  setReducedMotion(on: boolean): void;
  openArtifact(artifactId: string | null): void;

  // ── reads (non-reactive; pair them with lastSequence / playheadSeq) ─
  events(): readonly AnyEvent[];
  /** Event JSON exactly as received, by sequence. */
  rawEvent(seq: number): unknown;
  stateAt(seq: number): RunState;
  timeOfSeq(seq: number): number;
  playheadMs(): number;
  /** Right end of the scrubber right now. */
  endMs(): number;
  getFrame(): SceneFrame;
  subscribeEffects(fn: (events: readonly AnyEvent[]) => void): () => void;
}

export type StudioStore = StoreApi<StudioState>;

export interface StudioStoreOptions {
  /** Wall clock (ms since epoch); injectable for tests. */
  now?: () => number;
  /** How long a gap may stay open before it is backfilled. */
  gapBackfillMs?: number;
}

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);
/** Larger forward steps than this are treated as jumps (no effects). */
const MAX_EFFECT_BATCH = 12;
/** Cap on how long characters may keep walking after the last event. */
const MAX_SETTLE_MS = 15_000;

export function createStudioStore(opts: StudioStoreOptions = {}): StudioStore {
  const now = opts.now ?? Date.now;
  const gapBackfillMs = opts.gapBackfillMs ?? 2000;

  // Non-reactive internals, reset per run. React re-renders on lastSequence/playheadSeq instead.
  let buffer = new SequenceBuffer<AnyEvent>();
  let index: ReplayIndex | null = null;
  let held: AnyEvent[] = []; // released before the world was known
  /** Event JSON as received, by eventId (first delivery wins, like the buffer). */
  let rawById = new Map<string, unknown>();
  let rawSeen = new Set<string>();
  let rawId = 0;
  let conflictsSeen = 0;
  /** min(clientNow − eventTimestamp): client clock minus server clock, plus the smallest latency seen. */
  let clockOffsetMs: number | null = null;
  let gapSince: number | null = null;
  let frameMemo: { seq: number; state: RunState } | null = null;
  const effectListeners = new Set<(events: readonly AnyEvent[]) => void>();

  const emitEffects = (events: readonly AnyEvent[]) => {
    if (events.length === 0 || events.length > MAX_EFFECT_BATCH) return;
    for (const fn of effectListeners) {
      try {
        fn(events);
      } catch (err) {
        console.error('[studio] effect listener failed', err);
      }
    }
  };

  const resetInternals = () => {
    buffer = new SequenceBuffer<AnyEvent>();
    index = null;
    held = [];
    rawById = new Map();
    rawSeen = new Set();
    conflictsSeen = 0;
    clockOffsetMs = null;
    gapSince = null;
    frameMemo = null;
  };

  /**
   * When the characters finish their last walk (ms since run start, ≥ durationMs).
   * A finished run's playhead stops here instead of at the last event, so
   * characters are not frozen mid-step at the end of a replay.
   */
  const computeSettleMs = (world: CompiledWorld): number => {
    if (!index) return 0;
    const w = index.latest().world;
    let maxTick = 0;
    for (const id of w.characterOrder) {
      const c = w.characters[id];
      if (c) maxTick = Math.max(maxTick, arrivalTick(c.motion, world.def.ticksPerCell));
    }
    const duration = index.durationMs;
    return Math.min(duration + MAX_SETTLE_MS, Math.max(duration, (maxTick / world.def.tickHz) * 1000));
  };

  /**
   * Live playhead: estimated server time since run start (client clock corrected
   * by the offset seen on arrivals), never before the last event, and stopping
   * once a finished run's characters have settled.
   */
  const livePlayheadMs = (s: StudioState): number => {
    if (!index || index.runStartMs === null) return 0;
    const serverNow = now() - (clockOffsetMs ?? 0);
    const t = Math.max(index.durationMs, serverNow - index.runStartMs);
    return s.ended ? Math.min(t, s.settleMs) : t;
  };

  const endMsOf = (s: StudioState): number => (s.ended ? s.settleMs : Math.max(s.settleMs, livePlayheadMs(s)));

  const seqAt = (cursor: Cursor): number => {
    if (!index) return 0;
    return cursor.mode === 'live' ? index.lastSequence : index.seqAtTime(cursor.tMs);
  };

  /** Character's station at the current playhead, for selection. */
  const stationOf = (agentId: string | null): string | null => {
    if (!agentId || !index) return null;
    const s = store.getState();
    return index.stateAt(s.playheadSeq).world.characters[agentId]?.stationId ?? null;
  };

  const toReplay = (s: StudioState, tMs: number, playing?: boolean): Cursor => {
    const prev = s.cursor.mode === 'replay' ? s.cursor : null;
    const clamped = Math.max(0, Math.min(endMsOf(s), tMs));
    return { mode: 'replay', tMs: clamped, playing: playing ?? prev?.playing ?? false, speed: s.speed };
  };

  const setCursor = (cursor: Cursor) => {
    const s = store.getState();
    const leavingLive = s.cursor.mode === 'live' && cursor.mode === 'replay';
    store.setState({
      cursor,
      playheadSeq: seqAt(cursor),
      ...(cursor.mode === 'live' || leavingLive ? { newSinceReplay: 0 } : {}),
    });
  };

  const appendReleased = (released: AnyEvent[]) => {
    if (released.length === 0) return;
    if (!index) {
      held.push(...released);
      return;
    }
    try {
      index.append(released);
    } catch (err) {
      store.setState((s) => ({ warnings: [...s.warnings, `Could not fold events: ${String(err)}`] }));
    }
  };

  const store = createStore<StudioState>()((set, get) => ({
    runtime: { status: 'unknown', version: null, activeRunId: null },
    runs: [],

    runId: null,
    run: null,
    world: null,
    loadError: null,
    conn: 'idle',
    warnings: [],
    lastSequence: 0,
    durationMs: 0,
    settleMs: 0,
    ended: false,
    raw: [],
    gap: null,

    cursor: { mode: 'live' },
    playheadSeq: 0,
    newSinceReplay: 0,
    speed: 1,

    selectedAgentId: null,
    selectedStationId: null,
    tab: 'timeline',
    cameraMode: 'iso',
    follow: false,
    quality: 'high',
    reducedMotion: false,
    viewArtifactId: null,

    setRuntime: (r) => set((s) => ({ runtime: { ...s.runtime, ...r } })),

    setRuns: (runs) => {
      const s = get();
      const mine = s.runId ? runs.find((r) => r.runId === s.runId) : undefined;
      const ended = s.ended || (mine !== undefined && TERMINAL.has(mine.status) && s.lastSequence >= mine.lastSequence);
      set({ runs, ...(mine ? { run: mine, ended } : {}) });
    },

    openRun: (runId) => {
      resetInternals();
      set({
        runId,
        run: runId ? (get().runs.find((r) => r.runId === runId) ?? null) : null,
        world: null,
        loadError: null,
        conn: runId ? 'loading' : 'idle',
        warnings: [],
        lastSequence: 0,
        durationMs: 0,
        settleMs: 0,
        ended: false,
        raw: [],
        gap: null,
        cursor: { mode: 'live' },
        playheadSeq: 0,
        newSinceReplay: 0,
        selectedAgentId: null,
        selectedStationId: null,
        viewArtifactId: null,
      });
    },

    loadRun: (detail) => {
      if (detail.run.runId !== get().runId) return;
      if (index) {
        // Reconnect to the run already open: keep the events we have.
        set({ run: detail.run, loadError: null });
        return;
      }
      let world: CompiledWorld;
      try {
        world = loadWorld(detail.world);
      } catch (err) {
        set({ run: detail.run, loadError: `Invalid world definition: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      index = new ReplayIndex(world);
      set({ run: detail.run, world, loadError: null });
      const pending = held;
      held = [];
      appendReleased(pending);
      syncDerived();
    },

    setLoadError: (message) => set({ loadError: message, conn: 'error' }),
    setConn: (conn) => set({ conn }),

    ingest: (raws, source) => {
      const s = get();
      const t = now();
      const released: AnyEvent[] = [];
      const newRaw: RawEntry[] = [];
      for (const raw of raws) {
        const parsed = parseEvent(raw);
        if (!parsed.ok) {
          const key = safeJson(raw);
          if (rawSeen.has(key)) continue;
          rawSeen.add(key);
          const seq = (raw as { sequence?: unknown } | null)?.sequence;
          newRaw.push({ id: ++rawId, receivedAt: t, raw, error: parsed.error, sequence: typeof seq === 'number' ? seq : null });
          continue;
        }
        const e = parsed.event;
        if (s.runId && e.runId !== s.runId) continue; // stale delivery from a previous run
        const ts = Date.parse(e.timestamp);
        if (Number.isFinite(ts)) clockOffsetMs = Math.min(clockOffsetMs ?? Infinity, t - ts);
        if (!rawById.has(e.eventId)) rawById.set(e.eventId, raw);
        released.push(...buffer.push(e));
      }
      appendReleased(released);

      const conflicts = buffer.conflicts.slice(conflictsSeen).map(
        (c) => `Sequence #${c.sequence}: kept event ${c.keptEventId}, dropped conflicting ${c.droppedEventId}`,
      );
      conflictsSeen = buffer.conflicts.length;
      const missing = buffer.missing();
      if (missing === null) gapSince = null;
      else gapSince ??= t;
      // Keep references stable when nothing changed (fewer re-renders).
      const prevGap = get().gap;
      const gap = missing && prevGap && missing.from === prevGap.from && missing.to === prevGap.to ? prevGap : missing;

      const wasReplay = get().cursor.mode === 'replay';
      set({
        gap,
        ...(conflicts.length ? { warnings: [...get().warnings, ...conflicts] } : {}),
        ...(newRaw.length ? { raw: [...get().raw, ...newRaw] } : {}),
        ...(wasReplay && source === 'live' ? { newSinceReplay: get().newSinceReplay + released.length } : {}),
      });
      if (released.length) syncDerived();
      if (source === 'live' && !wasReplay && index) emitEffects(released);
    },

    markEnded: (status, lastSequence) => {
      const s = get();
      set({
        ended: true,
        ...(s.run ? { run: { ...s.run, status, lastSequence: Math.max(s.run.lastSequence, lastSequence) } } : {}),
      });
      syncDerived();
    },

    gapToBackfill: () => {
      const gap = get().gap;
      if (!gap || gapSince === null || now() - gapSince < gapBackfillMs) return null;
      gapSince = now(); // re-arm: try again after another interval if it is still open
      return gap;
    },

    goLive: () => setCursor({ mode: 'live' }),

    seek: (tMs) => setCursor(toReplay(get(), tMs)),

    seekToSeq: (seq) => {
      if (!index) return;
      setCursor(toReplay(get(), index.timeOfSeq(seq), false));
    },

    play: () => {
      const s = get();
      const end = endMsOf(s);
      const t = s.cursor.mode === 'replay' ? s.cursor.tMs : livePlayheadMs(s);
      // At the end of a finished run, play restarts from the beginning.
      setCursor(toReplay(s, t >= end - 1 && s.ended ? 0 : t, true));
    },

    pause: () => {
      const s = get();
      setCursor(toReplay(s, s.cursor.mode === 'replay' ? s.cursor.tMs : livePlayheadMs(s), false));
    },

    togglePlay: () => {
      const s = get();
      // Live counts as playing, except at the very end of a finished run.
      const playing = s.cursor.mode === 'live' ? !(s.ended && livePlayheadMs(s) >= s.settleMs) : s.cursor.playing;
      if (playing) s.pause();
      else s.play();
    },

    stepNext: () => {
      if (!index) return;
      const s = get();
      const from = s.cursor.mode === 'replay' ? s.cursor.tMs : livePlayheadMs(s);
      const t = nextEventTime(index, from);
      if (t === null) return;
      const before = s.playheadSeq;
      setCursor(toReplay(s, t, false));
      const after = get().playheadSeq;
      if (after > before) emitEffects(index.events.slice(before, after));
    },

    stepPrev: () => {
      if (!index) return;
      const s = get();
      const from = s.cursor.mode === 'replay' ? s.cursor.tMs : livePlayheadMs(s);
      setCursor(toReplay(s, prevEventTime(index, from), false));
    },

    setSpeed: (speed) => {
      const s = get();
      set({ speed, ...(s.cursor.mode === 'replay' ? { cursor: { ...s.cursor, speed } } : {}) });
    },

    advance: (dtMs) => {
      const s = get();
      if (s.cursor.mode !== 'replay' || !s.cursor.playing || !index) return;
      const end = endMsOf(s);
      const next = advancePlayback(s.cursor, dtMs, end);
      const before = s.playheadSeq;
      // Caught up with a run that is still going: hand over to live.
      setCursor(!next.playing && !s.ended ? { mode: 'live' } : next);
      const after = get().playheadSeq;
      if (after > before) emitEffects(index.events.slice(before, after));
    },

    selectAgent: (agentId) => set({ selectedAgentId: agentId, selectedStationId: stationOf(agentId) }),
    selectStation: (stationId) => set({ selectedStationId: stationId }),

    cycleAgent: (dir) => {
      if (!index) return;
      const exec = index.latest().exec;
      const ids = exec.agentOrder.filter((id) => exec.agents[id]?.embodied);
      if (ids.length === 0) return;
      const cur = get().selectedAgentId;
      const i = cur ? ids.indexOf(cur) : -1;
      const next = ids[(i + dir + ids.length) % ids.length] ?? ids[0]!;
      get().selectAgent(i === -1 && dir === -1 ? ids[ids.length - 1]! : next);
    },

    setTab: (tab) => set({ tab }),
    setCameraMode: (cameraMode) => set({ cameraMode }),
    toggleFollow: () => set((s) => ({ follow: !s.follow })),
    setQuality: (quality) => set({ quality }),
    setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    openArtifact: (viewArtifactId) => set({ viewArtifactId }),

    events: () => index?.events ?? [],
    rawEvent: (seq) => {
      const e = index?.events[seq - 1];
      return e ? rawById.get(e.eventId) : undefined;
    },
    stateAt: (seq) => index?.stateAt(seq) ?? initialRunState(),
    timeOfSeq: (seq) => index?.timeOfSeq(seq) ?? 0,
    playheadMs: () => {
      const s = get();
      return s.cursor.mode === 'live' ? livePlayheadMs(s) : s.cursor.tMs;
    },
    endMs: () => endMsOf(get()),

    getFrame: () => {
      const s = get();
      const seq = s.playheadSeq;
      if (!frameMemo || frameMemo.seq !== seq || !index) {
        frameMemo = { seq, state: index ? index.stateAt(seq) : initialRunState() };
      }
      const playheadMs = s.cursor.mode === 'live' ? livePlayheadMs(s) : s.cursor.tMs;
      const advancing = s.cursor.mode === 'live' ? !s.ended || playheadMs < s.settleMs : s.cursor.playing;
      return { state: frameMemo.state, tick: index ? index.tickAtMs(playheadMs) : 0, playheadMs, advancing };
    },

    subscribeEffects: (fn) => {
      effectListeners.add(fn);
      return () => {
        effectListeners.delete(fn);
      };
    },
  }));

  /** Recompute the derived fields after events or the end status changed. */
  function syncDerived() {
    const s = store.getState();
    if (!index || !s.world) return;
    const terminal = TERMINAL.has(index.latest().exec.run.status);
    store.setState({
      lastSequence: index.lastSequence,
      durationMs: index.durationMs,
      settleMs: computeSettleMs(s.world),
      ended: s.ended || terminal,
      playheadSeq: seqAt(s.cursor),
    });
  }

  return store;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
