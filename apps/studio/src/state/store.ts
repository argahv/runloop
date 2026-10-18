import {
  invalidEnvelopeEvent,
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
import { setApiBaseOverride } from '../lib/config';
import type { CameraMode, Quality, SceneFrame } from '../scene/types';
import { EMPTY_FILTER, type TraceFilter } from './filters';
import { EMPTY_ONBOARDING, type OnboardingProgress } from './onboarding';
import { advancePlayback } from './playback';
import type { MotionPref, ThemePref } from './prefs';
import { agentOfEvent, latestEventOf, type InspectorTab } from './selection';

export type Speed = 0.5 | 1 | 2 | 4;
export const SPEEDS: readonly Speed[] = [0.5, 1, 2, 4];

/**
 * Where the playhead is. Live follows the run in (estimated) server time.
 * Replay is a time since run start plus the exact event shown (`seq`): events
 * can share a millisecond, so the event is kept, not derived from the time.
 * Only the user (or playback) moves a replay cursor; events arriving later
 * never change what it shows.
 */
export type Cursor = { mode: 'live' } | { mode: 'replay'; tMs: number; seq: number; playing: boolean; speed: Speed };

export type Tab = 'timeline' | 'logs' | 'metrics' | 'state' | 'metadata';
export type ConnStatus = 'idle' | 'loading' | 'streaming' | 'reconnecting' | 'complete' | 'error';
export type RuntimeStatus = 'unknown' | 'online' | 'offline';
/** Live World main view: the 3D world, or the 2D Network view (agent graph or agents table). */
export type WorldView = 'world' | 'graph';

/** Claude Code ingest as reported by /api/health (absent on runtimes without the tracer). */
export interface IngestStatus {
  claudeCode: { protocol: number } | null;
}

/** A deep-link target waiting for its events to arrive. */
export interface PendingFocus {
  /** The event the inspector shows (the playhead moves there unless `at` says otherwise). */
  seq: number | null;
  /** The agent whose card the inspector shows (when no event is named). */
  agentId: string | null;
  /** The paused playhead (event sequence); null keeps the cursor where it is (live). */
  at?: number | null;
}

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
  runtime: {
    status: RuntimeStatus;
    version: string | null;
    activeRunId: string | null;
    /** null = this runtime does not report ingest (older runtime). */
    ingest: IngestStatus | null;
    tracedRunIds: string[];
  };
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

  // ── selection (one state shared by world, timeline, logs and inspector) ──
  /** Selected event (sequence). */
  selectedSeq: number | null;
  selectedAgentId: string | null;
  selectedStationId: string | null;
  inspectorTab: InspectorTab;
  /** Deep-link target applied once its events have arrived. */
  pendingFocus: PendingFocus | null;

  // ── view options ─────────────────────────────────────────────────
  tab: Tab;
  worldView: WorldView;
  filter: TraceFilter;
  themePref: ThemePref;
  motionPref: MotionPref;
  /** Viewer's runtime URL override (null = build default). */
  apiBaseOverride: string | null;
  /** Bumped to reconnect the open run (retry after an error). */
  connectNonce: number;
  cameraMode: CameraMode;
  follow: boolean;
  quality: Quality;
  reducedMotion: boolean;
  /** Artifact open in the viewer. */
  viewArtifactId: string | null;
  /** What this viewer has done (Overview checklist; kept in this browser only). */
  onboarding: OnboardingProgress;

  // ── actions ──────────────────────────────────────────────────────
  setRuntime(r: Partial<StudioState['runtime']>): void;
  setRuns(runs: RunSummary[]): void;
  /** Replace one run's summary (e.g. after pinning it) in the list and, if it is open, in `run`. */
  updateRun(run: RunSummary): void;
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

  /**
   * Select an event: its agent and that agent's station follow, and the
   * inspector shows the event. `seek` also moves the playhead to it.
   */
  selectEvent(seq: number | null, opts?: { seek?: boolean }): void;
  /** Select an agent: its station follows, its latest event at the playhead is highlighted, the inspector shows its card. */
  selectAgent(agentId: string | null): void;
  selectStation(stationId: string | null): void;
  clearSelection(): void;
  setInspectorTab(tab: InspectorTab): void;
  /** Focus a deep-link target now, or as soon as its events arrive. */
  focusDeepLink(target: PendingFocus): void;
  cycleAgent(dir: 1 | -1): void;
  setTab(tab: Tab): void;
  setWorldView(view: WorldView): void;
  setFilter(filter: TraceFilter): void;
  setThemePref(theme: ThemePref): void;
  setMotionPref(motion: MotionPref): void;
  /** Point the Studio at another runtime URL (null = build default); starts over with that runtime. */
  setApiBase(url: string | null): void;
  retryConnection(): void;
  setCameraMode(mode: CameraMode): void;
  toggleFollow(): void;
  setQuality(q: Quality): void;
  setReducedMotion(on: boolean): void;
  openArtifact(artifactId: string | null): void;
  setOnboarding(patch: Partial<OnboardingProgress>): void;

  /** A world view mounted (characters walk; a finished run settles over time). Returns the unmount. */
  mountWorld(): () => void;

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
  /** Latest valid event timestamp seen (stand-in time for invalid envelopes). */
  let lastTimestamp: string | null = null;
  let gapSince: number | null = null;
  let frameMemo: { seq: number; state: RunState } | null = null;
  /** Live events arrived before the run ended (else it was already over when opened: no settle animation). */
  let sawLive = false;
  /** World views mounted; without one there is nothing to settle. */
  let worldsMounted = 0;
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
    lastTimestamp = null;
    gapSince = null;
    frameMemo = null;
    sawLive = false;
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
    // A run that was over when opened, or with no world on screen, shows its end at once.
    if (s.ended && (!sawLive || worldsMounted === 0)) return s.settleMs;
    const serverNow = now() - (clockOffsetMs ?? 0);
    const t = Math.max(index.durationMs, serverNow - index.runStartMs);
    return s.ended ? Math.min(t, s.settleMs) : t;
  };

  /**
   * Right end of the scrubber. A finished run ends once its characters settle;
   * a running run ends at its live playhead (never at a predicted future).
   */
  const endMsOf = (s: StudioState): number => (s.ended ? s.settleMs : livePlayheadMs(s));

  const seqAt = (cursor: Cursor): number => {
    if (!index) return 0;
    return cursor.mode === 'live' ? index.lastSequence : Math.min(cursor.seq, index.lastSequence);
  };

  /** Character's station after event `seq` (default: the playhead), for selection. */
  const stationOf = (agentId: string | null, seq?: number): string | null => {
    if (!agentId || !index) return null;
    return index.stateAt(seq ?? store.getState().playheadSeq).world.characters[agentId]?.stationId ?? null;
  };

  /** Apply a deep-link target whose events have arrived; drop it once it can never apply. */
  const applyPendingFocus = () => {
    const s = store.getState();
    const p = s.pendingFocus;
    if (!p || !index) return;
    const at = p.at ?? null;
    const seqReady = (p.seq === null || index.lastSequence >= p.seq) && (at === null || index.lastSequence >= at);
    const agentReady = p.agentId === null || index.latest().exec.agents[p.agentId] !== undefined;
    if (!seqReady || !agentReady) {
      if (s.ended) store.setState({ pendingFocus: null }); // the run is complete: what is missing never comes
      return;
    }
    store.setState({ pendingFocus: null });
    // The playhead first: an explicit one, else the named event. With neither, a live run stays live.
    const playhead = at ?? p.seq;
    if (playhead !== null) s.seekToSeq(playhead);
    // Then what the inspector shows: the event (its own agent), else the agent's card.
    if (p.seq !== null) s.selectEvent(p.seq);
    else if (p.agentId !== null) s.selectAgent(p.agentId);
  };

  /** A replay cursor at `tMs`, showing event `seq` (default: the last event at that time). */
  const toReplay = (s: StudioState, tMs: number, opts: { playing?: boolean; seq?: number } = {}): Cursor => {
    const prev = s.cursor.mode === 'replay' ? s.cursor : null;
    const clamped = Math.max(0, Math.min(endMsOf(s), tMs));
    const seq = opts.seq ?? (index ? index.seqAtTime(clamped) : 0);
    return { mode: 'replay', tMs: clamped, seq, playing: opts.playing ?? prev?.playing ?? false, speed: s.speed };
  };

  /** Pause on event `seq` exactly (0 = before the first event). */
  const cursorAtSeq = (s: StudioState, seq: number): Cursor | null => {
    if (!index) return null;
    const n = Math.max(0, Math.min(index.lastSequence, Math.floor(seq)));
    return toReplay(s, index.timeOfSeq(n), { playing: false, seq: n });
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
    runtime: { status: 'unknown', version: null, activeRunId: null, ingest: null, tracedRunIds: [] },
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

    selectedSeq: null,
    selectedAgentId: null,
    selectedStationId: null,
    inspectorTab: 'run',
    pendingFocus: null,
    tab: 'timeline',
    worldView: 'world',
    filter: EMPTY_FILTER,
    themePref: 'system',
    motionPref: 'system',
    apiBaseOverride: null,
    connectNonce: 0,
    cameraMode: 'iso',
    follow: false,
    quality: 'auto',
    reducedMotion: false,
    viewArtifactId: null,
    onboarding: EMPTY_ONBOARDING,

    setRuntime: (r) => set((s) => ({ runtime: { ...s.runtime, ...r } })),

    setRuns: (runs) => {
      const s = get();
      const mine = s.runId ? runs.find((r) => r.runId === s.runId) : undefined;
      const ended = s.ended || (mine !== undefined && TERMINAL.has(mine.status) && s.lastSequence >= mine.lastSequence);
      set({ runs, ...(mine ? { run: mine, ended } : {}) });
    },

    updateRun: (run) =>
      set((s) => ({
        runs: s.runs.some((r) => r.runId === run.runId) ? s.runs.map((r) => (r.runId === run.runId ? run : r)) : s.runs,
        ...(s.runId === run.runId ? { run } : {}),
      })),

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
        selectedSeq: null,
        selectedAgentId: null,
        selectedStationId: null,
        inspectorTab: 'run',
        pendingFocus: null,
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
          // Still names its sequence: fold a placeholder (an anomaly) so later events are not held forever.
          const fallback = { runId: s.runId ?? '', timestamp: lastTimestamp ?? new Date(t).toISOString() };
          const placeholder = invalidEnvelopeEvent(raw, parsed.error, fallback);
          if (placeholder && (!s.runId || placeholder.runId === s.runId)) {
            if (!rawById.has(placeholder.eventId)) rawById.set(placeholder.eventId, raw);
            released.push(...buffer.push(placeholder));
            continue;
          }
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
        if (Number.isFinite(ts)) {
          clockOffsetMs = Math.min(clockOffsetMs ?? Infinity, t - ts);
          if (lastTimestamp === null || ts > Date.parse(lastTimestamp)) lastTimestamp = e.timestamp;
        }
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
      if (source === 'live' && released.length > 0 && !get().ended) sawLive = true;
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
      const c = cursorAtSeq(get(), seq);
      if (c) setCursor(c);
    },

    play: () => {
      const s = get();
      const end = endMsOf(s);
      const t = s.cursor.mode === 'replay' ? s.cursor.tMs : livePlayheadMs(s);
      // At the end of a finished run, play restarts from the beginning.
      if (t >= end - 1 && s.ended) setCursor(toReplay(s, 0, { playing: true }));
      else setCursor(toReplay(s, t, { playing: true, seq: s.playheadSeq }));
    },

    pause: () => {
      const s = get();
      setCursor(toReplay(s, s.cursor.mode === 'replay' ? s.cursor.tMs : livePlayheadMs(s), { playing: false, seq: s.playheadSeq }));
    },

    togglePlay: () => {
      const s = get();
      // Live counts as playing, except at the very end of a finished run.
      const playing = s.cursor.mode === 'live' ? !(s.ended && livePlayheadMs(s) >= s.settleMs) : s.cursor.playing;
      if (playing) s.pause();
      else s.play();
    },

    // One event at a time (events can share a millisecond).
    stepNext: () => {
      if (!index) return;
      const s = get();
      const before = s.playheadSeq;
      if (before >= index.lastSequence) return;
      setCursor(cursorAtSeq(s, before + 1)!);
      emitEffects(index.events.slice(before, before + 1));
    },

    stepPrev: () => {
      if (!index) return;
      const s = get();
      setCursor(cursorAtSeq(s, s.playheadSeq - 1)!);
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
      // Playback only moves forward, from the event shown (which may be early in its millisecond).
      const seq = Math.max(before, index.seqAtTime(next.tMs));
      // Caught up with a run that is still going: hand over to live.
      setCursor(!next.playing && !s.ended ? { mode: 'live' } : { ...next, seq });
      const after = get().playheadSeq;
      if (after > before) emitEffects(index.events.slice(before, after));
    },

    selectEvent: (seq, opts) => {
      if (seq === null) {
        set({ selectedSeq: null, inspectorTab: get().selectedAgentId ? 'agent' : 'run' });
        return;
      }
      if (!index || seq < 1 || seq > index.lastSequence) return;
      const e = index.events[seq - 1]!;
      const agentId = agentOfEvent(e, index.latest().exec);
      set({ selectedSeq: seq, selectedAgentId: agentId, selectedStationId: stationOf(agentId, seq), inspectorTab: 'event' });
      if (opts?.seek) get().seekToSeq(seq);
    },

    selectAgent: (agentId) => {
      if (agentId === null) {
        set((s) => ({ selectedAgentId: null, selectedStationId: null, inspectorTab: s.selectedSeq !== null ? 'event' : 'run' }));
        return;
      }
      const s = get();
      const latest = index ? latestEventOf(index.events, index.latest().exec, agentId, s.playheadSeq) : null;
      set({ selectedAgentId: agentId, selectedStationId: stationOf(agentId), selectedSeq: latest, inspectorTab: 'agent' });
    },

    selectStation: (stationId) => set({ selectedStationId: stationId }),

    clearSelection: () => set({ selectedSeq: null, selectedAgentId: null, selectedStationId: null, inspectorTab: 'run' }),

    setInspectorTab: (inspectorTab) => set({ inspectorTab }),

    focusDeepLink: (target) => {
      if (target.seq === null && target.agentId === null) return;
      set({ pendingFocus: target });
      applyPendingFocus();
    },

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
    setWorldView: (worldView) => set({ worldView }),
    setFilter: (filter) => set({ filter }),
    setThemePref: (themePref) => set({ themePref }),
    setMotionPref: (motionPref) => set({ motionPref }),
    setApiBase: (url) => {
      setApiBaseOverride(url);
      get().openRun(null);
      set({ apiBaseOverride: url, runs: [], runtime: { status: 'unknown', version: null, activeRunId: null, ingest: null, tracedRunIds: [] } });
    },
    retryConnection: () => {
      const runId = get().runId;
      get().openRun(runId);
      set((s) => ({ connectNonce: s.connectNonce + 1 }));
    },
    setCameraMode: (cameraMode) => set({ cameraMode }),
    toggleFollow: () => set((s) => ({ follow: !s.follow })),
    setQuality: (quality) => set({ quality }),
    setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    openArtifact: (viewArtifactId) => set({ viewArtifactId }),
    setOnboarding: (patch) => {
      const cur = get().onboarding;
      if (Object.entries(patch).every(([k, v]) => cur[k as keyof OnboardingProgress] === v)) return;
      set({ onboarding: { ...cur, ...patch } });
    },

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

    mountWorld: () => {
      worldsMounted += 1;
      let mounted = true;
      return () => {
        if (mounted) worldsMounted -= 1;
        mounted = false;
      };
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
    applyPendingFocus();
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
