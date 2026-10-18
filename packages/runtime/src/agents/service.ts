/**
 * Real agents in the town (plan §4.3, §4.5): Add to World, session binding,
 * Arrivals and claims, health, capabilities, and the projector that keeps
 * the world's agent presence in step with the run log.
 *
 * Wiring (runtime.ts): construct it with the world host, pass
 * `onSessionSeen` to the TraceSessionManager, mount http/agents.ts, then
 * `await start()` once the host runs, and `await stop()` before it stops.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentSessionSummary,
  type AgentSummary,
  type ArrivalSummary,
  type CommandEnvelope,
  type ConnectionHealth,
  type CreateAgentRequest,
  type RejectCode,
} from '@runloop-world/events';
import type { Recorder } from '../recorder';
import type { Db } from '../store/db';
import type { SessionSeen } from '../tracers/claude-code/session-manager';
import { WorldProjector, realClock, type ProjectorClock, type ProjectorDirectory, type WorldCommandSink } from '../world/projector';
import { Arrivals, resolveBinding } from './binding';
import { capabilitiesFor } from './capabilities';
import { deriveHealth } from './health';
import { LocalRoots, ROOT_PROBLEM_TEXT, labelOf, pathHintOf, realpathOrNull, type RootProblem } from './local-roots';
import { AgentRegistry, type AgentRecord } from './registry';

export interface AgentServiceOptions {
  db: Db;
  recorder: Pick<Recorder, 'subscribeAll' | 'getRun' | 'listAll'>;
  world: WorldCommandSink;
  /** Runloop's data dir (a workspace root may not sit inside it). */
  dataDir: string;
  /** Claude Code ingest is served (else every agent reads `unknown`). */
  ingestOn: boolean;
  clock?: ProjectorClock;
  platform?: NodeJS.Platform;
  /** Projector tuning (tests). */
  activityIntervalMs?: number;
  healthCheckMs?: number;
  onRejected?: (env: CommandEnvelope, code: string) => void;
  onError?: (err: unknown) => void;
}

/** A refused request: the HTTP status, a message (never containing a path) and a machine code. */
export interface AgentError {
  ok: false;
  status: 400 | 404 | 409 | 500;
  error: string;
  code: RootProblem | RejectCode | 'unknown_session' | 'session_bound' | 'cwd_unknown' | 'not_absolute' | 'unknown_agent' | 'world_error';
}

const fail = (status: AgentError['status'], code: AgentError['code'], error: string): AgentError => ({ ok: false, status, code, error });

/** What the dispatch manager (S4) reports for the submit_task capability. Absent = dispatch is off. */
export interface DispatchSignals {
  cli(): { state: 'unprobed' | 'missing' | 'ok'; reason: string | null };
}

/** Persist the last-envelope time at most this often per agent (it is also kept in memory). */
const PERSIST_ENVELOPE_MS = 10_000;

export class AgentService implements ProjectorDirectory {
  readonly registry: AgentRegistry;
  readonly roots: LocalRoots;
  readonly arrivals = new Arrivals();
  readonly projector: WorldProjector;
  private readonly world: WorldCommandSink;
  private readonly dataDir: string;
  private readonly ingestOn: boolean;
  private readonly clock: ProjectorClock;
  private readonly onError: (err: unknown) => void;
  /** Wall time of the last envelope of a bound session, per agent, and when it was last persisted. */
  private readonly lastEnvelope = new Map<string, { at: number; persistedAt: number }>();
  private readonly firstEventNoted = new Set<string>();
  private dispatch: DispatchSignals | null = null;

  constructor(opts: AgentServiceOptions) {
    this.clock = opts.clock ?? realClock;
    this.roots = new LocalRoots(opts.db, opts.platform);
    this.registry = new AgentRegistry(opts.db, this.roots, () => new Date(this.clock.now()));
    this.world = opts.world;
    this.dataDir = opts.dataDir;
    this.ingestOn = opts.ingestOn;
    this.onError = opts.onError ?? ((err) => console.error('[agents]', err));
    this.projector = new WorldProjector({
      recorder: opts.recorder,
      sink: opts.world,
      directory: this,
      clock: this.clock,
      ...(opts.activityIntervalMs !== undefined ? { activityIntervalMs: opts.activityIntervalMs } : {}),
      ...(opts.healthCheckMs !== undefined ? { healthCheckMs: opts.healthCheckMs } : {}),
      ...(opts.onRejected ? { onRejected: opts.onRejected } : {}),
      onError: this.onError,
    });
  }

  /**
   * Boot: house any agent still unhoused (and any the world does not know,
   * e.g. after a world reset), then let the projector catch the world up
   * (runs closed by the restart end, health reads offline).
   */
  async start(): Promise<void> {
    const present = new Set(this.world.snapshot().agents.map((a) => a.agentId));
    for (const a of this.registry.list()) {
      if (a.housed && present.has(a.agentId)) continue;
      if (!a.lotId) continue;
      const r = await this.house(a, 'system');
      if (r.ok) this.registry.markHoused(a.agentId);
      else this.onError(new Error(`Could not house agent ${a.agentId} at boot: ${r.code}`));
    }
    this.projector.start();
  }

  /** The dispatch manager attaches itself here (S4); until then submit_task reads "dispatch is off". */
  setDispatchSignals(signals: DispatchSignals | null): void {
    this.dispatch = signals;
  }

  async stop(): Promise<void> {
    await this.projector.stop();
    for (const [agentId, e] of this.lastEnvelope) {
      if (e.at > e.persistedAt) this.registry.persistLastEnvelope(agentId, new Date(e.at).toISOString());
    }
  }

  // ── sessions ───────────────────────────────────────────────────────

  /** TraceSessionManager hook: bind the session (or note it as an Arrival) before its events are recorded. */
  onSessionSeen(seen: SessionSeen): void {
    const at = this.clock.now();
    const decision = resolveBinding(seen, {
      existing: (id) => this.registry.bindingOf(id),
      dispatchAgent: (id) => this.registry.dispatchAgentFor(id),
      pathAgent: (cwd) => {
        const m = this.roots.match(cwd);
        return m ? this.registry.agentOfWorkspace(m.workspaceId) : null;
      },
    });
    if (decision.kind === 'arrival') {
      this.arrivals.note(seen.sessionId, seen.runId, seen.cwd, new Date(at).toISOString());
      return;
    }
    if (decision.isNew && this.registry.bind(seen.sessionId, decision.agentId, decision.method)) {
      this.arrivals.remove(seen.sessionId);
      // Earlier runs of this session (seen before the root existed) are projected now.
      this.projector.sessionBound(seen.sessionId, decision.agentId, this.registry.runIdsOfSession(seen.sessionId));
    }
    this.noteEnvelope(decision.agentId, at);
    this.projector.touch(decision.agentId);
  }

  // ── Add to World, claims ───────────────────────────────────────────

  /** POST /api/agents. The agent exists only if the world houses it. */
  async createAgent(req: CreateAgentRequest): Promise<{ ok: true; agent: AgentSummary } | AgentError> {
    if (this.registry.lotTaken(req.lotId)) return fail(409, 'lot_unavailable', 'That lot already houses an agent');
    let real: string;
    let fromSession: string | null = null;
    if ('path' in req.workspace) {
      const typed = expandHome(req.workspace.path.trim());
      if (!path.isAbsolute(typed)) return fail(400, 'not_absolute', 'Type the absolute path of the project folder');
      const r = this.roots.check(typed, this.dataDir);
      if (!r.ok) return rootFailure(r.problem);
      real = r.realpath;
    } else {
      const sessionId = req.workspace.fromSessionId;
      if (this.registry.bindingOf(sessionId)) return fail(409, 'session_bound', 'That session already belongs to an agent');
      const arrival = this.arrivals.get(sessionId);
      if (!arrival && this.registry.runIdsOfSession(sessionId).length === 0) return fail(404, 'unknown_session', 'No such session');
      if (!arrival?.cwd) {
        return fail(409, 'cwd_unknown', 'Runloop no longer knows where that session ran (it restarted since); type the folder instead');
      }
      const r = this.roots.check(arrival.cwd, this.dataDir);
      if (!r.ok) return rootFailure(r.problem);
      real = r.realpath;
      fromSession = sessionId;
    }

    const agentId = `agt_${randomUUID()}`;
    const record = {
      agentId,
      displayName: req.displayName.trim(),
      hue: (req.hue ?? this.registry.nextHue()).toLowerCase(),
      lotId: req.lotId,
      workspaceId: `wsp_${randomUUID()}`,
      label: labelOf(real),
      pathHint: pathHintOf(real),
      rootRealpath: real,
    };
    try {
      this.registry.insert(record, fromSession ? { sessionId: fromSession, method: 'claimed' } : undefined);
    } catch (err) {
      // A concurrent request took the lot or the folder (UNIQUE constraints).
      if (/UNIQUE/i.test(String(err))) return fail(409, 'lot_unavailable', 'That lot or folder was just taken');
      throw err;
    }
    let res: Awaited<ReturnType<AgentService['house']>>;
    try {
      res = await this.house(record, 'user');
    } catch (err) {
      this.registry.remove(agentId, 'world_error');
      this.onError(err);
      return fail(500, 'world_error', 'The world could not process the request');
    }
    if (!res.ok) {
      this.registry.remove(agentId, res.code);
      return fail(res.code === 'unknown_entity' ? 404 : 409, res.code, res.code === 'unknown_entity' ? 'No such agent lot' : `The world refused: ${res.code}`);
    }
    this.registry.markHoused(agentId);
    if (fromSession) this.bound(fromSession, agentId);
    this.projector.touch(agentId);
    return { ok: true, agent: this.summary(agentId)! };
  }

  /** POST /api/agents/:id/claim: bind an Arrival to the agent and replay its recorded runs into the world. */
  claim(agentId: string, sessionId: string): { ok: true; agent: AgentSummary; backfilledRuns: number } | AgentError {
    const agent = this.registry.get(agentId);
    if (!agent) return fail(404, 'unknown_agent', 'No such agent');
    if (!agent.housed) return fail(409, 'not_housed', 'The agent is not in the town yet');
    if (this.registry.runIdsOfSession(sessionId).length === 0 && !this.arrivals.get(sessionId)) return fail(404, 'unknown_session', 'No such session');
    if (!this.registry.bind(sessionId, agentId, 'claimed')) return fail(409, 'session_bound', 'That session already belongs to an agent');
    const backfilledRuns = this.bound(sessionId, agentId);
    return { ok: true, agent: this.summary(agentId)!, backfilledRuns };
  }

  // ── read side ──────────────────────────────────────────────────────

  list(): AgentSummary[] {
    const presence = this.presenceById();
    return this.registry.list().map((a) => this.summarize(a, presence));
  }

  summary(agentId: string): AgentSummary | null {
    const a = this.registry.get(agentId);
    return a ? this.summarize(a, this.presenceById()) : null;
  }

  /** Unbound traced sessions (recorded) plus sessions seen since boot that have no run yet. */
  arrivalList(): ArrivalSummary[] {
    const mem = new Map(this.arrivals.all().map((a) => [a.sessionId, a]));
    const hint = (cwd: string | null | undefined) => (cwd ? pathHintOf(realpathOrNull(cwd) ?? path.resolve(cwd)) : null);
    const label = (cwd: string | null | undefined) => (cwd ? labelOf(cwd) : 'unknown project');
    const out: ArrivalSummary[] = this.registry.unboundSessions().map((s) => ({
      sessionId: s.sessionId,
      projectLabel: s.projectLabel || label(mem.get(s.sessionId)?.cwd),
      pathHint: hint(mem.get(s.sessionId)?.cwd),
      runIds: s.runIds,
      firstSeenAt: s.firstSeenAt,
      lastEventAt: s.lastEventAt,
    }));
    const listed = new Set(out.map((a) => a.sessionId));
    for (const a of mem.values()) {
      if (listed.has(a.sessionId) || this.registry.bindingOf(a.sessionId)) continue;
      out.push({
        sessionId: a.sessionId,
        projectLabel: label(a.cwd),
        pathHint: hint(a.cwd),
        runIds: [],
        firstSeenAt: a.firstSeenAt,
        lastEventAt: a.lastEventAt,
      });
    }
    return out;
  }

  // ── ProjectorDirectory ─────────────────────────────────────────────

  agentOfSession(sessionId: string): string | null {
    return this.registry.bindingOf(sessionId)?.agentId ?? null;
  }

  isHoused(agentId: string): boolean {
    return this.registry.get(agentId)?.housed ?? false;
  }

  housedAgentIds(): string[] {
    return this.registry
      .list()
      .filter((a) => a.housed)
      .map((a) => a.agentId);
  }

  openRunIdsOf(agentId: string): string[] {
    return this.registry.openRunIdsOf(agentId);
  }

  healthOf(agentId: string, now: number): ConnectionHealth {
    const a = this.registry.get(agentId);
    if (!a) return 'unknown';
    return this.healthFor(a, now);
  }

  noteRunEvent(agentId: string): void {
    if (this.firstEventNoted.has(agentId)) return;
    this.registry.noteFirstEvent(agentId, new Date(this.clock.now()).toISOString());
    this.firstEventNoted.add(agentId);
  }

  // ── internals ──────────────────────────────────────────────────────

  private house(a: Pick<AgentRecord, 'agentId' | 'displayName' | 'hue' | 'lotId'>, source: 'user' | 'system') {
    return this.world.submit({
      id: `house:${a.agentId}`,
      source,
      command: { type: 'agent.house', agentId: a.agentId, lotId: a.lotId!, displayName: a.displayName, hue: a.hue },
    });
  }

  /** After a binding: project the session's runs. Returns how many. */
  private bound(sessionId: string, agentId: string): number {
    this.arrivals.remove(sessionId);
    const runIds = this.registry.runIdsOfSession(sessionId);
    const n = this.projector.sessionBound(sessionId, agentId, runIds);
    if (n > 0) this.noteRunEvent(agentId);
    return n;
  }

  private noteEnvelope(agentId: string, at: number): void {
    const prev = this.lastEnvelope.get(agentId);
    const persist = !prev || at - prev.persistedAt >= PERSIST_ENVELOPE_MS;
    if (persist) this.registry.persistLastEnvelope(agentId, new Date(at).toISOString());
    this.lastEnvelope.set(agentId, { at, persistedAt: persist ? at : prev!.persistedAt });
  }

  private lastEnvelopeAt(a: AgentRecord): number | null {
    return this.lastEnvelope.get(a.agentId)?.at ?? (a.lastEnvelopeAt ? Date.parse(a.lastEnvelopeAt) : null);
  }

  private healthFor(a: AgentRecord, now: number): ConnectionHealth {
    return deriveHealth(
      {
        ingestOn: this.ingestOn,
        hasRoot: a.workspace !== null && this.roots.hasRoot(a.workspace.workspaceId),
        firstEventAt: a.firstEventAt ? Date.parse(a.firstEventAt) : null,
        lastEnvelopeAt: this.lastEnvelopeAt(a),
        openRuns: this.registry.openRunIdsOf(a.agentId).length,
        dispatchRunning: this.registry.runningDispatches(a.agentId) > 0,
      },
      now,
    );
  }

  private presenceById() {
    return new Map(this.world.snapshot().agents.map((p) => [p.agentId, p]));
  }

  private summarize(a: AgentRecord, presence: ReturnType<AgentService['presenceById']>): AgentSummary {
    const p = presence.get(a.agentId);
    const runs = this.registry.runsOf(a.agentId);
    const last = this.lastEnvelopeAt(a);
    const cli = this.dispatch?.cli() ?? null;
    const sessions: AgentSessionSummary[] = runs.map((r) => ({
      runId: r.runId,
      sessionId: r.sessionId,
      segment: r.segment,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      bindingMethod: r.method,
    }));
    return {
      agentId: a.agentId,
      kind: 'claude-code',
      displayName: a.displayName,
      hue: a.hue,
      orgId: a.orgId,
      lotId: a.lotId,
      buildingId: a.housed ? (p?.buildingId ?? null) : null,
      housed: a.housed,
      health: this.healthFor(a, this.clock.now()),
      attention: p?.attention ?? 'none',
      lastEventAt: last !== null ? new Date(last).toISOString() : null,
      capabilities: capabilitiesFor({
        ingestOn: this.ingestOn,
        hasFirstEvent: a.firstEventAt !== null,
        sessions: this.registry.sessionCount(a.agentId),
        cli: cli?.state ?? 'off',
        ...(cli?.reason ? { cliReason: cli.reason } : {}),
        policyAllowsDispatch: this.registry.policyAllowsDispatch(a.orgId),
        runningDispatches: this.registry.runningDispatches(a.agentId),
      }),
      workspace: a.workspace,
      sessions,
    };
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

function rootFailure(problem: RootProblem): AgentError {
  return fail(problem === 'already_bound' ? 409 : 400, problem, ROOT_PROBLEM_TEXT[problem]);
}
