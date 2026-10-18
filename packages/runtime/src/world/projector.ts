/**
 * World projector (plan §4.3): turns the run events of sessions bound to an
 * agent into coarse world commands. It only observes and proposes; the world
 * host validates and decides. The run log stays the source of truth.
 *
 * Per housed agent it keeps the world showing the newest open bound run:
 * - `agent.session` started / ended (ids `sess:<runId>:start:1`, `sess:<runId>:end`);
 * - `agent.activity` at most once per wall second per run (id `act:<runId>:<seqTo>`),
 *   citing the run so far ([1, seqTo]) so its counts equal that range's tool calls (P4);
 * - `agent.connection` (system) when health or attention changes.
 *
 * Session and activity commands are `external-agent` (the host marks them
 * observed: Claude Code ran the tools, even for dispatched runs), or
 * `inferred` when what they cite anew is Runloop's own reconstruction: the
 * idle sweep or restart closing a run, or events that are all inferred.
 *
 * Never imports dispatch (P11). Never touches residents.
 */
import { SequenceGapError, foldExecution, reduceExecution, selectOpenIncidents, type ExecState } from '@runloop-world/core';
import type {
  AgentExecState,
  CommandEnvelope,
  ConnectionHealth,
  RunCause,
  RunEvent,
  RunOutcome,
  ToolCategory,
  ToolCounts,
  WorldCommand,
  WorldCommandResponse,
  WorldSnapshot,
} from '@runloop-world/events';
import { deriveAttention } from '../agents/health';
import type { Recorder } from '../recorder';
import type { Unsubscribe } from '../bus';

/** What the projector needs from the world host (WorldHost implements it). */
export interface WorldCommandSink {
  submit(env: CommandEnvelope): Promise<WorldCommandResponse>;
  snapshot(): WorldSnapshot;
}

/** What the projector needs to know about agents (the agent service implements it). */
export interface ProjectorDirectory {
  /** The agent a session is bound to; null when unbound. */
  agentOfSession(sessionId: string): string | null;
  isHoused(agentId: string): boolean;
  housedAgentIds(): string[];
  /** The agent's open bound runs, oldest first. */
  openRunIdsOf(agentId: string): string[];
  healthOf(agentId: string, now: number): ConnectionHealth;
  /** A bound run of the agent recorded an event. */
  noteRunEvent(agentId: string): void;
}

export interface ProjectorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ProjectorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface ProjectorOptions {
  recorder: Pick<Recorder, 'subscribeAll' | 'getRun' | 'listAll'>;
  sink: WorldCommandSink;
  directory: ProjectorDirectory;
  clock?: ProjectorClock;
  /** Minimum wall time between two activity commands of one run (default 1000 ms). */
  activityIntervalMs?: number;
  /** How often health is re-derived without events (live → idle after 5 quiet minutes). Default 5000 ms. */
  healthCheckMs?: number;
  /** A command the world rejected (logged, never retried with the same id). */
  onRejected?: (env: CommandEnvelope, code: string) => void;
  onError?: (err: unknown) => void;
}

/** The activity a run shows (the agent.activity command fields). */
export interface Activity {
  counts: ToolCounts;
  execState: AgentExecState;
  helpers: number;
  openIncidents: number;
}

interface RunView {
  runId: string;
  agentId: string;
  exec: ExecState;
  /** tool.call_started events by category, over the whole run so far. */
  counts: Partial<Record<ToolCategory, number>>;
  /** Provenance of the latest folded event, and of run.started. */
  lastProvenance: string | null;
  startedInferred: boolean;
  completed: { seq: number; outcome: RunOutcome; inferred: boolean } | null;
  /** A start was sent for it by this process (the next one is a resume). */
  startSent: boolean;
  /** Activity last sent: its key, seqTo and wall time. */
  sentKey: string | null;
  sentSeq: number;
  sentAt: number | null;
  /** What happened since the last activity sent: all inferred, or Runloop closed the run. */
  delta: { events: number; allInferred: boolean; closure: boolean };
}

interface Mirror {
  /** The run the world shows for the agent. */
  activeRunId: string | null;
  /** seqTo of the last cause the world holds for activeRunId (after a restart). */
  hintSeq: number;
  connection: { health: ConnectionHealth; attention: string };
}

const freshDelta = () => ({ events: 0, allInferred: true, closure: false });

/** Permission requests of a run still waiting for an answer. */
export function pendingPermissionsOf(exec: ExecState): number {
  return Object.values(exec.permissions).filter((p) => p.status === 'pending').length;
}

/** The agent.activity fields of a folded run (`counts`: its tool.call_started events by category). */
export function activityOf(exec: ExecState, counts: Partial<Record<ToolCategory, number>>, closed: boolean): Activity {
  const pendingPermissions = pendingPermissionsOf(exec);
  const agents = Object.values(exec.agents);
  const working = agents.some((a) => a.activeCallId !== null || a.state === 'working');
  const execState: AgentExecState = closed
    ? 'idle'
    : pendingPermissions > 0
      ? 'awaiting_approval'
      : working
        ? 'working'
        : exec.agents.main?.state === 'waiting'
          ? 'waiting'
          : 'idle';
  const sorted: Partial<Record<ToolCategory, number>> = {};
  for (const k of Object.keys(counts).sort() as ToolCategory[]) if (counts[k]) sorted[k] = counts[k];
  return {
    counts: sorted,
    execState,
    helpers: exec.agentOrder.filter((id) => id.startsWith('sa-')).length,
    openIncidents: selectOpenIncidents(exec).length,
  };
}

export class WorldProjector {
  private readonly recorder: ProjectorOptions['recorder'];
  private readonly sink: WorldCommandSink;
  private readonly dir: ProjectorDirectory;
  private readonly clock: ProjectorClock;
  private readonly interval: number;
  private readonly healthCheckMs: number;
  private readonly onRejected: (env: CommandEnvelope, code: string) => void;
  private readonly onError: (err: unknown) => void;

  /** Bound runs being followed. */
  private readonly runs = new Map<string, RunView>();
  /** runId → bound agent (null = not a bound Claude Code run). */
  private readonly agentOfRunCache = new Map<string, string | null>();
  private readonly mirrors = new Map<string, Mirror>();
  private readonly dirty = new Set<string>();
  private readonly wakeAt = new Map<string, { at: number; handle: unknown }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private flushHandle: unknown = null;
  private healthHandle: unknown = null;
  private unsubscribe: Unsubscribe | null = null;
  private stopped = true;

  constructor(opts: ProjectorOptions) {
    this.recorder = opts.recorder;
    this.sink = opts.sink;
    this.dir = opts.directory;
    this.clock = opts.clock ?? realClock;
    this.interval = opts.activityIntervalMs ?? 1000;
    this.healthCheckMs = opts.healthCheckMs ?? 5000;
    this.onRejected = opts.onRejected ?? ((env, code) => console.warn(`[world] command ${env.id} rejected: ${code}`));
    this.onError = opts.onError ?? ((err) => console.error('[projector]', err));
  }

  /** Mirror what the world shows, follow the recorder, and reconcile every housed agent (boot catches up here). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const p of this.sink.snapshot().agents) {
      this.mirrors.set(p.agentId, {
        activeRunId: p.activeRunId,
        hintSeq: p.lastCause && p.lastCause.runId === p.activeRunId ? p.lastCause.seqTo : 0,
        connection: { health: p.health, attention: p.attention },
      });
    }
    this.unsubscribe = this.recorder.subscribeAll((e) => this.onRunEvent(e));
    for (const agentId of this.dir.housedAgentIds()) this.markDirty(agentId);
    this.armHealthCheck();
  }

  /** Stop following and wait for commands already submitted. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushHandle !== null) this.clock.clearTimeout(this.flushHandle);
    if (this.healthHandle !== null) this.clock.clearTimeout(this.healthHandle);
    for (const w of this.wakeAt.values()) this.clock.clearTimeout(w.handle);
    this.flushHandle = this.healthHandle = null;
    this.wakeAt.clear();
    this.dirty.clear();
    await this.idle();
  }

  /** Resolves once every submitted command has an answer. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Reconcile pending agents now (tests; normally scheduled right after each batch of events). */
  flush(): void {
    if (this.flushHandle !== null) this.clock.clearTimeout(this.flushHandle);
    this.flushHandle = null;
    const agents = [...this.dirty];
    this.dirty.clear();
    for (const agentId of agents) {
      try {
        this.reconcile(agentId);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  /** An agent was housed (or its state changed outside the run log): bring the world up to date. */
  touch(agentId: string): void {
    this.markDirty(agentId);
  }

  /**
   * A session was just bound to `agentId`. Its recorded runs are projected:
   * closed ones replayed as started → activity → ended, an open one becomes
   * the run the world shows. Returns the number of runs projected.
   */
  sessionBound(sessionId: string, agentId: string, runIds: readonly string[]): number {
    for (const id of runIds) this.agentOfRunCache.delete(id);
    if (this.stopped || !this.dir.isHoused(agentId)) return 0;
    const m = this.mirror(agentId);
    this.retireIfClosed(agentId, m, true);
    let projected = 0;
    for (const runId of runIds) {
      const v = this.runs.get(runId) ?? this.load(runId, agentId, 0);
      if (!v) continue;
      projected++;
      if (!v.completed) continue; // reconcile shows it
      this.sendStarted(v, m);
      this.sendActivity(v, true);
      this.sendEnded(v, m);
    }
    this.markDirty(agentId);
    return projected;
  }

  // ── events ─────────────────────────────────────────────────────────

  private onRunEvent(e: RunEvent): void {
    if (this.stopped) return;
    try {
      let v = this.runs.get(e.runId);
      if (v) this.fold(v, e);
      else {
        const agentId = this.agentOfRun(e);
        if (!agentId) return;
        // The log already holds `e` (it is published after the commit).
        v = this.load(e.runId, agentId, 0) ?? undefined;
        if (!v) return;
      }
      if (e.type === 'run.completed') this.agentOfRunCache.delete(e.runId);
      this.dir.noteRunEvent(v.agentId);
      this.markDirty(v.agentId);
    } catch (err) {
      this.onError(err);
    }
  }

  private agentOfRun(e: RunEvent): string | null {
    const cached = this.agentOfRunCache.get(e.runId);
    if (cached !== undefined) return cached;
    const source = e.type === 'run.started' ? e.payload.source : this.recorder.getRun(e.runId)?.source;
    const agentId = source?.kind === 'claude-code' ? this.dir.agentOfSession(source.sessionId) : null;
    if (e.type !== 'run.completed') this.agentOfRunCache.set(e.runId, agentId);
    return agentId;
  }

  /** Fold a run from the log. `sentSeq` = what the world already holds (the delta starts after it). */
  private load(runId: string, agentId: string, sentSeq: number): RunView | null {
    const events = this.recorder.listAll(runId);
    if (events.length === 0) return null;
    const v: RunView = {
      runId,
      agentId,
      exec: foldExecution(events),
      counts: {},
      lastProvenance: null,
      startedInferred: events[0]!.provenance === 'inferred',
      completed: null,
      startSent: false,
      sentKey: null,
      sentSeq,
      sentAt: null,
      delta: freshDelta(),
    };
    for (const e of events) this.track(v, e, e.sequence > sentSeq);
    this.runs.set(runId, v);
    return v;
  }

  private fold(v: RunView, e: RunEvent): void {
    if (e.sequence <= v.exec.lastSequence) return;
    try {
      v.exec = reduceExecution(v.exec, e);
    } catch (err) {
      if (!(err instanceof SequenceGapError)) throw err;
      const fresh = this.load(v.runId, v.agentId, v.sentSeq);
      if (fresh) Object.assign(fresh, { startSent: v.startSent, sentKey: v.sentKey, sentAt: v.sentAt });
      return;
    }
    this.track(v, e, true);
  }

  private track(v: RunView, e: RunEvent, inDelta: boolean): void {
    if (e.type === 'tool.call_started') {
      const c = e.payload.category ?? 'other';
      v.counts[c] = (v.counts[c] ?? 0) + 1;
    }
    const inferred = e.provenance === 'inferred';
    if (e.type === 'run.completed') v.completed = { seq: e.sequence, outcome: e.payload.outcome, inferred };
    v.lastProvenance = e.provenance ?? null;
    if (inDelta) {
      v.delta.events++;
      v.delta.allInferred &&= inferred;
      if (e.type === 'run.completed' && inferred) v.delta.closure = true;
    }
  }

  // ── reconcile ──────────────────────────────────────────────────────

  private mirror(agentId: string): Mirror {
    let m = this.mirrors.get(agentId);
    // A freshly housed agent (agent.housed: not_connected, no run).
    if (!m) this.mirrors.set(agentId, (m = { activeRunId: null, hintSeq: 0, connection: { health: 'not_connected', attention: 'none' } }));
    return m;
  }

  private reconcile(agentId: string): void {
    if (this.stopped || !this.dir.isHoused(agentId)) return;
    const m = this.mirror(agentId);
    const openIds = this.dir.openRunIdsOf(agentId);
    const open: RunView[] = [];
    for (const id of openIds) {
      const v = this.runs.get(id) ?? this.load(id, agentId, 0);
      if (v && !v.completed) open.push(v);
    }
    const desired = open.at(-1) ?? null;

    // 1. Retire the run the world shows when another one (or none) should be shown.
    if (m.activeRunId && m.activeRunId !== desired?.runId) {
      if (!this.retireIfClosed(agentId, m, false)) return; // its final activity waits for the rate limit
      m.activeRunId = null;
    }
    // 2. Show the newest open run and its activity.
    if (desired) {
      if (m.activeRunId !== desired.runId) this.sendStarted(desired, m);
      this.sendActivity(desired, false);
    }
    // Forget closed runs nobody shows.
    for (const [id, v] of this.runs) if (v.agentId === agentId && v.completed && id !== m.activeRunId) this.runs.delete(id);

    // 3. Connection health and attention.
    const health = this.dir.healthOf(agentId, this.clock.now());
    const attention = deriveAttention({
      pendingPermissions: open.reduce((n, v) => n + pendingPermissionsOf(v.exec), 0),
      openIncidents: open.reduce((n, v) => n + selectOpenIncidents(v.exec).length, 0),
      dispatchAwaitingApproval: false,
    });
    if (m.connection.health !== health || m.connection.attention !== attention) {
      this.submit({
        id: `conn:${agentId}:${health}:${attention}:${this.clock.now()}`,
        source: 'system',
        command: { type: 'agent.connection', agentId, health, attention },
      });
      m.connection = { health, attention };
    }
  }

  /**
   * If the run the world shows has closed: send its final activity and its
   * end. Returns false when the final activity must wait for the rate limit
   * (unless `force`). A run that is still open is left as it is.
   */
  private retireIfClosed(agentId: string, m: Mirror, force: boolean): boolean {
    if (!m.activeRunId) return true;
    const prev = this.runs.get(m.activeRunId) ?? this.load(m.activeRunId, agentId, m.hintSeq);
    if (!prev?.completed) return true;
    if (!this.sendActivity(prev, force)) return false;
    this.sendEnded(prev, m);
    return true;
  }

  /** Show the run. A run shown again (after a newer one ended) cites its latest event and gets a fresh id. */
  private sendStarted(v: RunView, m: Mirror): void {
    const resume = v.startSent;
    const seqFrom = resume ? v.exec.lastSequence : 1;
    const id = resume ? `sess:${v.runId}:resume:${seqFrom}:${this.clock.now()}` : `sess:${v.runId}:start:1`;
    this.submitRun(v, id, resume ? v.lastProvenance === 'inferred' : v.startedInferred, seqFrom, seqFrom, {
      type: 'agent.session',
      agentId: v.agentId,
      runId: v.runId,
      phase: 'started',
    });
    v.startSent = true;
    v.sentKey = null; // the world reset the presence's activity
    m.activeRunId = v.runId;
    m.hintSeq = seqFrom;
  }

  private sendEnded(v: RunView, m: Mirror): void {
    const c = v.completed!;
    this.submitRun(v, `sess:${v.runId}:end`, c.inferred, c.seq, c.seq, {
      type: 'agent.session',
      agentId: v.agentId,
      runId: v.runId,
      phase: 'ended',
      outcome: c.outcome,
    });
    if (m.activeRunId === v.runId) m.activeRunId = null;
    this.runs.delete(v.runId);
  }

  /** Send the run's activity if it changed. Returns false when rate-limited (a wake-up is scheduled). */
  private sendActivity(v: RunView, force: boolean): boolean {
    const fields = activityOf(v.exec, v.counts, v.completed !== null);
    const key = JSON.stringify(fields);
    if (key === v.sentKey) return true;
    const now = this.clock.now();
    if (!force && v.sentAt !== null && now - v.sentAt < this.interval) {
      this.wake(v.agentId, v.sentAt + this.interval - now);
      return false;
    }
    const seqTo = v.exec.lastSequence;
    const inferred = v.delta.events > 0 && (v.delta.closure || v.delta.allInferred);
    this.submitRun(v, `act:${v.runId}:${seqTo}`, inferred, 1, seqTo, { type: 'agent.activity', agentId: v.agentId, runId: v.runId, ...fields });
    v.sentKey = key;
    v.sentSeq = seqTo;
    v.sentAt = now;
    v.delta = freshDelta();
    return true;
  }

  private submitRun(v: RunView, id: string, inferred: boolean, seqFrom: number, seqTo: number, command: WorldCommand): void {
    const cause: RunCause = { runId: v.runId, seqFrom, seqTo };
    this.submit({ id, source: 'external-agent', ...(inferred ? { inferred: true } : {}), cause, command });
  }

  private submit(env: CommandEnvelope): void {
    const p = this.sink.submit(env).then(
      (r) => {
        if (!r.ok) this.onRejected(env, r.code);
      },
      (err) => this.onError(err),
    );
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  // ── scheduling ─────────────────────────────────────────────────────

  private markDirty(agentId: string): void {
    this.dirty.add(agentId);
    if (this.flushHandle === null && !this.stopped) this.flushHandle = this.clock.setTimeout(() => this.flush(), 0);
  }

  private wake(agentId: string, ms: number): void {
    const at = this.clock.now() + ms;
    const pending = this.wakeAt.get(agentId);
    if (pending && pending.at <= at) return;
    if (pending) this.clock.clearTimeout(pending.handle);
    const handle = this.clock.setTimeout(() => {
      this.wakeAt.delete(agentId);
      this.markDirty(agentId);
    }, ms);
    this.wakeAt.set(agentId, { at, handle });
  }

  private armHealthCheck(): void {
    this.healthHandle = this.clock.setTimeout(() => {
      if (this.stopped) return;
      for (const agentId of this.dir.housedAgentIds()) this.markDirty(agentId);
      this.armHealthCheck();
    }, this.healthCheckMs);
  }
}
