/**
 * The town's client state (plan §5, UX draft §3): a vanilla zustand store,
 * separate from the StudioStore (sessions and replay), shared by the shell,
 * the panels and the town renderer.
 *
 * The engine owns truth. The snapshot is folded with the sim's own
 * `applyEvent` (the same function the host and replay use), so the client
 * can never disagree with the server. Commands are never optimistic: a sent
 * command shows as pending until its effect (or rejection) arrives.
 *
 * `applyEvent` mutates the snapshot in place, so `rev` bumps on every fold;
 * subscribe to `rev` (or a selector of it) to re-render.
 */
import {
  isAmbientWorldEvent,
  type AgentPresence,
  type AgentSummary,
  type ArrivalSummary,
  type EntityRef,
  type RejectCode,
  type WorldCommand,
  type WorldEvent,
  type WorldInfoResponse,
  type WorldSnapshot,
  type WorldSpeed,
} from '@runloop-world/events';
import { applyEvent } from '@runloop-world/sim';
import type { CompiledTown } from '@runloop-world/town';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { foldAttention, foldAttentionLog, type AttentionItem } from './attention';
import { nextClock, tickNow, type WorldClock } from './interpolate';
import type { Mode, WorldCam } from './link';

/** connecting → live; reconnecting after a drop; offline when the runtime is gone; disabled = RUNLOOP_WORLD=off. */
export type WorldStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline' | 'disabled';

/** The agents API: ok, not mounted in this runtime (404), or unreachable. */
export type AgentsApiStatus = 'unknown' | 'ok' | 'unavailable' | 'offline';

export interface PendingCommand {
  id: string;
  command: WorldCommand;
  /** What the chip says while it waits ("Pausing…"). */
  label: string;
  sentAt: number;
  state: 'sending' | 'rejected' | 'failed';
  /** Why it was rejected or failed. */
  reason?: RejectCode | string;
}

/** A request to the town camera (the renderer or the map acts on it). */
export interface CameraRequest {
  id: number;
  kind: 'focus' | 'enter' | 'exit' | 'overview';
  ref: EntityRef | null;
  /** quick: 400–700 ms; cinematic: ≤ 2.5 s (earned: the first intro, an arrival); cut: no animation (reduced motion). */
  motion: 'quick' | 'cinematic' | 'cut';
}

export type Overlay = 'none' | 'map' | 'list';

/** Recent events kept for the World Log and panels (older ones are paged from the API). */
export const LOG_LIMIT = 4000;

export interface WorldUiState {
  status: WorldStatus;
  error: string | null;
  info: WorldInfoResponse | null;
  /** The compiled town (names, lots, slots); null until loaded. */
  town: CompiledTown | null;
  snapshot: WorldSnapshot | null;
  /** Bumps on every change to `snapshot` (it is mutated in place). */
  rev: number;
  clock: WorldClock | null;
  /** The most recent events, oldest first (bounded by LOG_LIMIT). */
  log: WorldEvent[];
  /** Set when an event arrived after a gap; the connection resyncs. */
  gap: boolean;

  mode: Mode;
  /** The entity the context panel shows (top of the stack). */
  panelStack: EntityRef[];
  follow: EntityRef | null;
  /** The building whose interior is open, if any. */
  entered: string | null;
  camera: CameraRequest | null;
  /** The camera from the URL (`cam=`), and the latest one the renderer reports. */
  cam: WorldCam | null;
  overlay: Overlay;
  reducedMotion: boolean;
  /** What the World Log should show first: an event and/or one entity's events. */
  logFocus: { seq: number | null; actor: string | null } | null;
  /** The Add to World dialog, when open (optionally founded from an Arrival). */
  addToWorld: { fromSessionId: string | null } | null;

  pending: Record<string, PendingCommand>;
  attention: AttentionItem[];
  /** The seq the viewer last saw (localStorage), for the catch-up. */
  lastSeenSeq: number | null;

  agentsApi: AgentsApiStatus;
  agents: AgentSummary[];
  arrivals: ArrivalSummary[];
  agentsFetchedAt: number | null;

  // ── Engine data ──
  setStatus(status: WorldStatus, error?: string | null): void;
  setInfo(info: WorldInfoResponse): void;
  setTown(town: CompiledTown): void;
  /** Replace the state with a server snapshot. */
  applySnapshot(snap: WorldSnapshot, nowMs: number): void;
  /** Fold events in seq order (duplicates are skipped; a gap sets `gap`). */
  applyEvents(events: readonly WorldEvent[], nowMs: number): void;
  setClock(frame: { tick: number; speed: WorldSpeed; lagging: boolean }, nowMs: number): void;
  /**
   * Seed attention with recorded events from before the snapshot (so a
   * permission wait that started before the page opened still shows), then
   * refold what arrived live since.
   */
  primeAttention(history: readonly WorldEvent[]): void;

  // ── Navigation ──
  setMode(mode: Mode): void;
  /** Open an entity's panel (pushing it on the stack) and ask the camera to focus it. */
  focusEntity(ref: EntityRef, opts?: { camera?: boolean; replace?: boolean }): void;
  back(): void;
  closePanels(): void;
  setFollow(ref: EntityRef | null): void;
  enter(buildingId: string | null): void;
  requestCamera(kind: CameraRequest['kind'], ref: EntityRef | null, motion?: CameraRequest['motion']): void;
  setCam(cam: WorldCam | null): void;
  setOverlay(o: Overlay): void;
  setReducedMotion(v: boolean): void;
  /** Open the World Log (Intelligence) at an event or on one entity's events. */
  showInLog(focus: { seq?: number | null; actor?: string | null }): void;
  openAddToWorld(fromSessionId?: string | null): void;
  closeAddToWorld(): void;

  // ── Commands ──
  addPending(p: PendingCommand): void;
  resolvePending(id: string, result: { ok: true } | { ok: false; reason: string; state: 'rejected' | 'failed' }): void;
  dropPending(id: string): void;

  // ── Agents (from /api/agents) ──
  setAgents(status: AgentsApiStatus, agents?: AgentSummary[], arrivals?: ArrivalSummary[], nowMs?: number): void;
  setLastSeenSeq(seq: number | null): void;
}

export type WorldStore = StoreApi<WorldUiState>;

/** The agent's presence before an event changes it (for attention: "lost mid-task"). */
function presenceBefore(s: WorldSnapshot, e: WorldEvent): AgentPresence | null {
  if (!('agentId' in e.p)) return null;
  const id = (e.p as { agentId: string }).agentId;
  const a = s.agents.find((x) => x.agentId === id);
  return a ? { ...a } : null;
}

export function createWorldStore(init: Partial<Pick<WorldUiState, 'mode' | 'panelStack' | 'cam' | 'reducedMotion'>> = {}): WorldStore {
  let cameraId = 0;
  return createStore<WorldUiState>()((set, get) => ({
    status: 'idle',
    error: null,
    info: null,
    town: null,
    snapshot: null,
    rev: 0,
    clock: null,
    log: [],
    gap: false,
    mode: init.mode ?? 'explore',
    panelStack: init.panelStack ?? [],
    follow: null,
    entered: null,
    camera: null,
    cam: init.cam ?? null,
    overlay: 'none',
    reducedMotion: init.reducedMotion ?? false,
    logFocus: null,
    addToWorld: null,
    pending: {},
    attention: [],
    lastSeenSeq: null,
    agentsApi: 'unknown',
    agents: [],
    arrivals: [],
    agentsFetchedAt: null,

    setStatus: (status, error = null) => set({ status, error }),
    setInfo: (info) => set({ info }),
    setTown: (town) => set({ town }),

    applySnapshot: (snap, nowMs) =>
      set((s) => ({
        snapshot: snap,
        rev: s.rev + 1,
        gap: false,
        clock: nextClock(null, { tick: snap.tick, speed: snap.speed, lagging: s.clock?.lagging ?? false }, nowMs),
        // Acks may have arrived inside the snapshot: a pending command older than it is settled.
        pending: Object.fromEntries(Object.entries(s.pending).filter(([, p]) => p.state !== 'sending' || nowMs - p.sentAt < 10_000)),
      })),

    applyEvents: (events, nowMs) => {
      const s = get();
      const snap = s.snapshot;
      if (!snap || events.length === 0) return;
      const town = s.town ? { def: s.town.def } : undefined;
      let attention = s.attention;
      let pending = s.pending;
      const added: WorldEvent[] = [];
      let gap = false;
      let arrived: string | null = null;
      for (const e of events) {
        if (e.seq <= snap.seq) continue;
        if (e.seq !== snap.seq + 1) {
          gap = true;
          break;
        }
        const prev = presenceBefore(snap, e);
        // A real agent's first event: an earned, skippable arrival shot (UX §8).
        if (e.type === 'agent.connection_changed' && e.p.health === 'live' && (prev?.health === 'awaiting_first_event' || prev?.health === 'not_connected')) {
          arrived = e.p.agentId;
        }
        try {
          applyEvent(snap, e, town);
        } catch {
          // An event the state cannot take (e.g. world.created without the town): resync from a snapshot.
          gap = true;
          break;
        }
        added.push(e);
        if (!isAmbientWorldEvent(e.type)) attention = foldAttention(attention, e, prev);
        if (e.cmdId && pending[e.cmdId]) {
          const p = pending[e.cmdId]!;
          if (e.type === 'command.rejected') pending = { ...pending, [e.cmdId]: { ...p, state: 'rejected', reason: e.p.code } };
          else {
            const { [e.cmdId]: _done, ...rest } = pending;
            pending = rest;
          }
        }
      }
      if (added.length === 0 && !gap) return;
      const last = added[added.length - 1];
      let clock = s.clock;
      // Never show a decision "in the future" of the clock.
      if (last && clock && last.tick > tickNow(clock, nowMs)) clock = { ...clock, tick: last.tick, receivedAt: nowMs };
      const log = added.length ? [...s.log, ...added].slice(-LOG_LIMIT) : s.log;
      set({ rev: s.rev + (added.length ? 1 : 0), log, attention, pending, gap: gap || s.gap, clock });
      if (arrived) get().requestCamera('focus', { kind: 'agent', id: arrived }, 'cinematic');
    },

    setClock: (frame, nowMs) => set((s) => ({ clock: nextClock(s.clock, frame, nowMs) })),
    primeAttention: (history) =>
      set((s) => {
        const sorted = history.filter((e) => !isAmbientWorldEvent(e.type)).sort((a, b) => a.seq - b.seq);
        const last = sorted.length ? sorted[sorted.length - 1]!.seq : 0;
        const live = s.log.filter((e) => e.seq > last && !isAmbientWorldEvent(e.type));
        const past = foldAttentionLog([], sorted).map((it) => ({ ...it, history: true }));
        return { attention: foldAttentionLog(past, live) };
      }),

    setMode: (mode) => set({ mode }),
    focusEntity: (ref, opts = {}) => {
      const s = get();
      const top = s.panelStack[s.panelStack.length - 1];
      const same = top && top.kind === ref.kind && top.id === ref.id;
      const panelStack = same ? s.panelStack : opts.replace ? [...s.panelStack.slice(0, -1), ref] : [...s.panelStack, ref].slice(-8);
      set({ panelStack });
      if (opts.camera !== false) get().requestCamera('focus', ref);
    },
    back: () => set((s) => ({ panelStack: s.panelStack.slice(0, -1) })),
    closePanels: () => set({ panelStack: [], follow: null }),
    setFollow: (follow) => set({ follow }),
    enter: (entered) => {
      set({ entered });
      get().requestCamera(entered ? 'enter' : 'exit', entered ? { kind: 'building', id: entered } : null);
    },
    requestCamera: (kind, ref, motion = 'quick') =>
      set((s) => ({ camera: { id: ++cameraId, kind, ref, motion: s.reducedMotion ? 'cut' : motion } })),
    setCam: (cam) => set({ cam }),
    setOverlay: (overlay) => set({ overlay }),
    setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    openAddToWorld: (fromSessionId = null) => set({ addToWorld: { fromSessionId } }),
    closeAddToWorld: () => set({ addToWorld: null }),
    showInLog: (f) => set({ mode: 'intelligence', panelStack: [], logFocus: { seq: f.seq ?? null, actor: f.actor ?? null } }),

    addPending: (p) => set((s) => ({ pending: { ...s.pending, [p.id]: p } })),
    resolvePending: (id, result) =>
      set((s) => {
        const p = s.pending[id];
        if (!p) return {};
        if (result.ok) return {}; // the effect event clears it
        return { pending: { ...s.pending, [id]: { ...p, state: result.state, reason: result.reason } } };
      }),
    dropPending: (id) =>
      set((s) => {
        if (!s.pending[id]) return {};
        const { [id]: _gone, ...rest } = s.pending;
        return { pending: rest };
      }),

    setAgents: (agentsApi, agents, arrivals, nowMs) =>
      set((s) => ({
        agentsApi,
        agents: agents ?? (agentsApi === 'ok' ? s.agents : []),
        arrivals: arrivals ?? (agentsApi === 'ok' ? s.arrivals : []),
        agentsFetchedAt: nowMs ?? s.agentsFetchedAt,
      })),
    setLastSeenSeq: (lastSeenSeq) => set({ lastSeenSeq }),
  }));
}

/** The panel on top of the stack. */
export const focusOf = (s: Pick<WorldUiState, 'panelStack'>): EntityRef | null => s.panelStack[s.panelStack.length - 1] ?? null;
