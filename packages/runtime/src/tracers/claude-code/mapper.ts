/**
 * Claude Code hook → Runloop events: a pure state machine per session.
 *
 * `mapHook(state, envelope, ctx)` returns the next state and one batch of
 * event drafts (recorded atomically by the session manager). It never reads
 * the clock or the database: event times are the hook's `observedAt`.
 *
 * Rules (see docs/plans/claude-code-tracer.md §4 and Appendix C):
 * - A session becomes a run lazily, on the first prompt, tool, permission or
 *   subagent event. One run per segment; a later segment continues it.
 * - Agents: `user` (not embodied), `main` (the Claude Code session) and
 *   `sa-<agent_id>` for subagents; hooks carrying `agent_id` belong to a subagent.
 * - Calls are keyed by `tool_use_id`. Delivery may be out of order: a result
 *   without a start synthesises the start (inferred); a late start is ignored.
 * - Which Agent call spawned a subagent is not reported until the call's
 *   result names it, so the link made at SubagentStart is inferred, and is
 *   corrected (with a marker) when the result disagrees.
 * - A denied permission fires no hook (default mode): it is inferred at the
 *   agent's next boundary — after the batch that held the call ended
 *   (PostToolBatch), the next prompt, Stop, SubagentStop or SessionEnd.
 * - Every draft carries a provenance: `reported` when Claude Code said it,
 *   `inferred` when Runloop reconstructed it (e.g. a denial no hook reports).
 * - Usage comes only from what Claude Code reports (the Agent tool's result);
 *   the main agent's usage is not reported by hooks, so no event is made.
 */
import type { EventDraft, Provenance, ToolCategory } from '@runloop-world/events';
import type { BatchDraft, RunManifest } from '../../recorder';
import { num, rec, str, toolResult, type HookEnvelope } from './hook-input';
import {
  MAIN_AGENT_ID,
  USER_AGENT_ID,
  delegateTaskId,
  inputHash,
  messageId,
  permissionId,
  runIdFor,
  subagentId,
  turnTaskId,
} from './ids';
import {
  MESSAGE_MAX,
  OUTPUT_SUMMARY_MAX,
  clipText,
  failureSummary,
  inputSummary,
  oneLine,
  parseTestOutput,
  isShellTool,
  sanitizeText,
  splitExitCode,
  successSummary,
  toolCategory,
} from './summarize';

export interface MapContext {
  /** World for new runs. */
  worldId: string;
  /** Subagents beyond this many get no character (they are still traced). */
  maxEmbodiedSubagents: number;
  /** Used in the summary of runs the idle sweep closes. */
  idleMinutes: number;
}

export const DEFAULT_MAP_CONTEXT: MapContext = { worldId: 'research-campus', maxEmbodiedSubagents: 8, idleMinutes: 120 };

export interface SubagentState {
  ccAgentId: string;
  type: string;
  /** Display name, e.g. "Explore #2". */
  name: string;
  /** Its delegated task (null for a subagent only known from an Agent result). */
  taskId: string | null;
  done: boolean;
  embodied: boolean;
  /** The Agent call it is linked to (inferred until that call's result confirms it). */
  callId: string | null;
  /** The Agent call its task's title and parent came from (fixed once recorded). */
  titledFrom: string | null;
}

export interface CallState {
  agentId: string;
  tool: string;
  category: ToolCategory;
  startedAt: string;
  inputHash: string;
  taskId: string | null;
  permissionId: string | null;
  /** Agent calls: the subagent it spawned (inferred at SubagentStart, confirmed by the result). */
  subagentId: string | null;
  subagentType: string | null;
  description: string | null;
}

export interface PermissionState {
  agentId: string;
  callId: string | null;
  tool: string;
  inputHash: string;
  /** request: a PermissionRequest reported it; notification: inferred from a permission_prompt notification. */
  source: 'request' | 'notification';
  /** The batch holding its call ended (PostToolBatch) with no result: denied at the agent's next step. */
  batchEnded: boolean;
}

/** A recently closed call, to link a PermissionRequest that arrives after its call's result. */
export interface ClosedCall {
  callId: string;
  agentId: string;
  tool: string;
  inputHash: string;
  /** The call ran (a result was reported), so a permission for it was approved. */
  ran: boolean;
  hadPermission: boolean;
}

/**
 * Ids of closed calls (late results for them are dropped). Append-only: full
 * chunks are frozen and shared between states, so a step copies at most one
 * chunk, not every id seen in the session. Bounded (oldest chunks dropped).
 */
export interface ClosedIds {
  frozen: readonly ReadonlySet<string>[];
  recent: readonly string[];
}

const CLOSED_CHUNK = 256;
const CLOSED_MAX_CHUNKS = 64;
const RECENT_CALLS = 32;

export const emptyClosedIds = (): ClosedIds => ({ frozen: [], recent: [] });
export const closedHas = (c: ClosedIds, id: string): boolean => c.recent.includes(id) || c.frozen.some((set) => set.has(id));
export function closedAdd(c: ClosedIds, id: string): ClosedIds {
  const recent = [...c.recent, id];
  if (recent.length < CLOSED_CHUNK) return { frozen: c.frozen, recent };
  return { frozen: [...c.frozen, new Set(recent)].slice(-CLOSED_MAX_CHUNKS), recent: [] };
}

export interface SessionState {
  sessionId: string;
  /** none: no run yet; open: recording into runId; closed: runId ended (a later event opens the next segment). */
  status: 'none' | 'open' | 'closed';
  segment: number;
  runId: string | null;
  /** observedAt of the event that closed the run; deliveries observed before it are late. */
  closedAt: string | null;
  /** What closed the run: Claude Code (ended), the idle sweep, or a runtime restart. */
  closedBy: 'ended' | 'idle' | 'restart' | null;
  /** From SessionStart, held until the run is created. */
  pending: { cwd: string | null; model: string | null; startSource: string | null };
  cwd: string | null;
  permissionMode: string | null;
  pluginVersion: string | null;
  /** Claude Code processes (hook parent pids) seen since the last SessionStart. */
  ppids: number[];
  lastObservedAt: string | null;
  /** Last state recorded for `main` (so closing a session only emits a change when needed). */
  mainState: 'idle' | 'working' | 'waiting' | 'failed';
  turn: { n: number; taskId: string; implicit: boolean } | null;
  /** Turns so far, across segments (turn ids continue). */
  turnCount: number;
  subagents: Record<string, SubagentState>;
  /** Open calls. */
  calls: Record<string, CallState>;
  /** Calls that already have their terminal event (late results are dropped). */
  closedCalls: ClosedIds;
  /** The last few closed calls, newest last. */
  recentCalls: ClosedCall[];
  /** Pending permission requests. */
  permissions: Record<string, PermissionState>;
  counters: { permission: number; delegate: number; message: number; embodied: number; byType: Record<string, number> };
}

export interface TraceBatch {
  runId: string;
  create?: { manifest: RunManifest; timestamp: string; provenance: Provenance };
  drafts: BatchDraft[];
}

export interface MapResult {
  state: SessionState;
  /** Events to record; null when the envelope only changed the state (or nothing). */
  batch: TraceBatch | null;
  /** Set when the envelope was not used (counted as ignored). */
  ignored?: string;
}

/** A session seen for the first time, optionally continuing an earlier (closed) segment. */
export function initialSessionState(
  sessionId: string,
  previous?: { segment: number; runId: string; closedAt: string | null; turnCount: number },
): SessionState {
  return {
    sessionId,
    status: previous ? 'closed' : 'none',
    segment: previous?.segment ?? 0,
    runId: previous?.runId ?? null,
    closedAt: previous?.closedAt ?? null,
    closedBy: previous ? 'restart' : null,
    pending: { cwd: null, model: null, startSource: null },
    cwd: null,
    permissionMode: null,
    pluginVersion: null,
    ppids: [],
    lastObservedAt: previous?.closedAt ?? null,
    mainState: 'idle',
    turn: null,
    turnCount: previous?.turnCount ?? 0,
    subagents: {},
    calls: {},
    closedCalls: emptyClosedIds(),
    recentCalls: [],
    permissions: {},
    counters: { permission: 0, delegate: 0, message: 0, embodied: 0, byType: {} },
  };
}

/** Hooks the mapper understands; anything else is ignored (and counted). */
export const HANDLED_HOOKS: ReadonlySet<string> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'Notification',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
]);

/** Map one hook delivery. Pure: `prev` is not modified. */
export function mapHook(prev: SessionState, env: HookEnvelope, ctx: MapContext = DEFAULT_MAP_CONTEXT): MapResult {
  const event = env.hook.hook_event_name;
  if (!HANDLED_HOOKS.has(event)) return { state: prev, batch: null, ignored: `unhandled hook ${event}` };
  if (prev.status === 'closed' && prev.closedAt && Date.parse(env.observedAt) <= Date.parse(prev.closedAt)) {
    return { state: prev, batch: null, ignored: 'late delivery for a closed run' };
  }
  const step = new Step(prev, env.observedAt, ctx, env.hook);
  step.observe(env);
  const ignored = step.handle(event);
  return step.result(ignored);
}

/**
 * Close everything still open (idle timeout or runtime restart). Events are
 * stamped `at` (normally the last observed time), all inferred.
 */
export function sweep(prev: SessionState, ctx: MapContext, reason: 'idle' | 'restart', at: string): MapResult {
  if (prev.status !== 'open') return { state: prev, batch: null };
  const step = new Step(prev, at, ctx, { session_id: prev.sessionId, hook_event_name: 'Sweep' });
  step.closeAll(reason);
  return step.result(undefined);
}

// ── implementation ─────────────────────────────────────────────────────

type Hook = Record<string, unknown>;

const INFERRED_DENIAL = 'No result was reported after the permission request; treated as denied (inferred)';

/** Working copy of one mapping step: copy-on-write state plus the drafts produced. */
class Step {
  private s: SessionState;
  private readonly drafts: BatchDraft[] = [];
  private create: TraceBatch['create'];
  private readonly hook: Hook;
  private readonly at: string;
  private readonly ctx: MapContext;

  constructor(prev: SessionState, at: string, ctx: MapContext, hook: Hook) {
    this.s = {
      ...prev,
      subagents: { ...prev.subagents },
      calls: { ...prev.calls },
      permissions: { ...prev.permissions },
      counters: { ...prev.counters, byType: { ...prev.counters.byType } },
    };
    this.at = at;
    this.ctx = ctx;
    this.hook = hook;
  }

  /** Drafts already produced are always kept; `ignored` only applies when there are none. */
  result(ignored: string | undefined): MapResult {
    if (this.drafts.length === 0 && !this.create) return { state: this.s, batch: null, ...(ignored ? { ignored } : {}) };
    return { state: this.s, batch: { runId: this.s.runId!, ...(this.create ? { create: this.create } : {}), drafts: this.drafts } };
  }

  // ── bookkeeping ────────────────────────────────────────────────────

  private get cwd(): string | null {
    return str(this.hook, 'cwd') ?? this.s.cwd;
  }

  private text(value: string): string {
    return sanitizeText(value, this.cwd);
  }

  private emit(draft: EventDraft, provenance: Provenance, extra: { parentCallId?: string } = {}): void {
    this.drafts.push({ ...draft, provenance, timestamp: this.at, ...extra } as BatchDraft);
  }

  private setMainState(state: SessionState['mainState'], reason: string, provenance: Provenance): void {
    this.emit({ type: 'agent.state_changed', payload: { agentId: MAIN_AGENT_ID, state, reason } }, provenance);
    this.s.mainState = state;
  }

  observe(env: HookEnvelope): void {
    const s = this.s;
    if (!s.lastObservedAt || Date.parse(env.observedAt) > Date.parse(s.lastObservedAt)) s.lastObservedAt = env.observedAt;
    s.pluginVersion = env.plugin.version;
    const cwd = str(this.hook, 'cwd');
    if (cwd) s.cwd = cwd;
    const mode = str(this.hook, 'permission_mode');
    if (mode) s.permissionMode = mode;
    if (env.ppid !== undefined && !s.ppids.includes(env.ppid)) {
      // A SessionStart announces the process; any other new parent means a second process on this session.
      if (env.hook.hook_event_name === 'SessionStart') s.ppids = [env.ppid];
      else {
        if (s.ppids.length > 0 && s.status === 'open') {
          this.emit(
            { type: 'run.marker', payload: { kind: 'other', label: 'Another Claude Code process is writing to this session' } },
            'inferred',
          );
        }
        s.ppids = [...s.ppids, env.ppid].slice(-8);
      }
    }
  }

  /** Start recording (a new segment when a previous run of this session is closed). */
  private ensureRun(provenance: Provenance): void {
    const s = this.s;
    if (s.status === 'open') return;
    const continuesRunId = s.status === 'closed' ? s.runId : null;
    s.segment += 1;
    s.runId = runIdFor(s.sessionId, s.segment);
    s.status = 'open';
    s.closedAt = null;
    s.closedBy = null;
    s.turn = null;
    s.mainState = 'idle';
    s.subagents = {};
    s.calls = {};
    s.closedCalls = emptyClosedIds();
    s.recentCalls = [];
    s.permissions = {};
    s.counters = { permission: 0, delegate: 0, message: 0, embodied: 0, byType: {} };
    const cwd = s.pending.cwd ?? s.cwd;
    const projectLabel = projectLabelOf(cwd);
    this.create = {
      timestamp: this.at,
      provenance,
      manifest: {
        title: `Claude Code · ${projectLabel}`,
        missionId: 'claude-code',
        worldId: this.ctx.worldId,
        adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code (traced via hooks)' },
        mode: 'traced',
        source: {
          kind: 'claude-code',
          sessionId: s.sessionId,
          segment: s.segment,
          projectLabel,
          model: s.pending.model,
          ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
          ...(s.pending.startSource ? { startSource: s.pending.startSource } : {}),
          ...(s.pluginVersion ? { pluginVersion: s.pluginVersion } : {}),
          ...(continuesRunId ? { continuesRunId } : {}),
        },
      },
    };
    this.emit(
      {
        type: 'agent.registered',
        payload: { agentId: USER_AGENT_ID, name: 'You', role: 'user', model: null, tools: [], embodied: false },
      },
      'reported',
    );
    this.emit(
      {
        type: 'agent.registered',
        payload: {
          agentId: MAIN_AGENT_ID,
          name: 'Claude',
          role: 'main agent',
          model: s.pending.model,
          tools: [],
          embodied: true,
          characterPreset: 'claude',
        },
      },
      'reported',
    );
  }

  /** `main`, or the subagent the hook fired in (registered on first sight). */
  private agentOf(): string {
    const cc = str(this.hook, 'agent_id');
    return cc ? this.ensureSubagent(cc, str(this.hook, 'agent_type') ?? 'subagent', 'inferred') : MAIN_AGENT_ID;
  }

  /** The task an agent's calls belong to: main's turn (opened implicitly if none), or the subagent's delegation. */
  private taskOf(agentId: string): string | null {
    if (agentId === MAIN_AGENT_ID) return this.ensureTurn().taskId;
    return this.s.subagents[agentId]?.taskId ?? null;
  }

  private ensureTurn(): NonNullable<SessionState['turn']> {
    if (this.s.turn) return this.s.turn;
    return this.openTurn(null, 'inferred');
  }

  private openTurn(prompt: string | null, provenance: Provenance): NonNullable<SessionState['turn']> {
    const s = this.s;
    const n = ++s.turnCount;
    const taskId = turnTaskId(n);
    s.turn = { n, taskId, implicit: prompt === null };
    const title = prompt === null ? `Turn ${n} (no prompt reported)` : `Turn ${n}`;
    this.emit(
      { type: 'task.created', payload: { taskId, title, kind: 'turn', dependsOn: [] }, actorId: prompt === null ? MAIN_AGENT_ID : USER_AGENT_ID },
      provenance,
    );
    this.emit({ type: 'task.started', payload: { taskId, agentId: MAIN_AGENT_ID } }, provenance);
    if (prompt !== null) {
      this.emit(
        {
          type: 'agent.message_sent',
          payload: { messageId: messageId(++s.counters.message), fromAgentId: USER_AGENT_ID, to: MAIN_AGENT_ID, text: clipText(this.text(prompt), MESSAGE_MAX) },
          visibility: 'sensitive',
        },
        provenance,
      );
    }
    this.setMainState('working', prompt === null ? 'Working without a reported prompt' : 'Prompt received', provenance);
    return s.turn;
  }

  private closeTurn(summary: string, provenance: Provenance, visibility: 'public' | 'sensitive' = 'public'): void {
    const turn = this.s.turn;
    if (!turn) return;
    this.emit({ type: 'task.completed', payload: { taskId: turn.taskId, summary, artifactIds: [] }, visibility }, provenance);
    this.s.turn = null;
  }

  private ensureSubagent(ccAgentId: string, type: string, provenance: Provenance): string {
    const s = this.s;
    const id = subagentId(ccAgentId);
    if (s.subagents[id]) return id;
    const k = ++s.counters.delegate;
    const ordinal = (s.counters.byType[type] = (s.counters.byType[type] ?? 0) + 1);
    const embodied = s.counters.embodied < this.ctx.maxEmbodiedSubagents;
    if (embodied) s.counters.embodied += 1;
    // No hook says which Agent call started a subagent: guess the oldest unlinked call of this type (inferred;
    // the call's result names the subagent and corrects a wrong guess).
    const linked = Object.entries(s.calls).find(
      ([, c]) => c.category === 'delegate' && c.subagentId === null && (c.subagentType ?? 'general-purpose') === type,
    );
    if (linked) s.calls[linked[0]] = { ...linked[1], subagentId: id };
    const taskId = delegateTaskId(k);
    const name = `${type} #${ordinal}`;
    s.subagents[id] = { ccAgentId, type, name, taskId, done: false, embodied, callId: linked?.[0] ?? null, titledFrom: linked?.[0] ?? null };
    const linkProvenance: Provenance = linked ? 'inferred' : provenance;
    this.emit(
      {
        type: 'agent.registered',
        payload: {
          agentId: id,
          name,
          role: type,
          model: null,
          tools: [],
          embodied,
          ...(embodied ? { characterPreset: `subagent-${s.counters.embodied}` } : {}),
        },
      },
      provenance,
    );
    const description = linked?.[1].description;
    this.emit(
      {
        type: 'task.created',
        payload: { taskId, title: description ? oneLine(this.text(description), 120) : `${type} subagent`, kind: 'delegated', dependsOn: [] },
        actorId: linked?.[1].agentId ?? MAIN_AGENT_ID,
      },
      linkProvenance,
      linked ? { parentCallId: linked[0] } : {},
    );
    this.emit({ type: 'task.assigned', payload: { taskId, agentId: id }, actorId: linked?.[1].agentId ?? MAIN_AGENT_ID }, linkProvenance);
    this.emit({ type: 'task.started', payload: { taskId, agentId: id } }, provenance);
    this.emit({ type: 'agent.state_changed', payload: { agentId: id, state: 'working', reason: 'Delegated task started' } }, provenance);
    return id;
  }

  // ── calls ──────────────────────────────────────────────────────────

  private toolInput(): Record<string, unknown> {
    return rec(this.hook, 'tool_input') ?? {};
  }

  private startCall(callId: string, agentId: string, provenance: Provenance): CallState {
    const tool = oneLine(str(this.hook, 'tool_name') ?? 'unknown', 100) || 'unknown';
    const input = this.toolInput();
    const category = toolCategory(tool, input);
    const taskId = this.taskOf(agentId);
    const call: CallState = {
      agentId,
      tool,
      category,
      startedAt: this.at,
      inputHash: inputHash(input),
      taskId,
      permissionId: null,
      subagentId: null,
      subagentType: category === 'delegate' ? (typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose') : null,
      description: category === 'delegate' && typeof input.description === 'string' ? input.description : null,
    };
    // A subagent that started before its Agent call arrived (async delivery): link it now (inferred, state only).
    if (category === 'delegate') {
      const early = Object.entries(this.s.subagents).find(([, a]) => !a.done && a.callId === null && a.taskId !== null && a.type === call.subagentType);
      if (early) {
        this.s.subagents[early[0]] = { ...early[1], callId };
        call.subagentId = early[0];
      }
    }
    this.s.calls[callId] = call;
    this.emit(
      {
        type: 'tool.call_started',
        payload: { callId, agentId, ...(taskId ? { taskId } : {}), tool, category, inputSummary: inputSummary(tool, input, this.cwd) },
        // Commands can carry credentials the redaction patterns do not know.
        ...(isShellTool(tool) ? { visibility: 'sensitive' as const } : {}),
      },
      provenance,
    );
    // A permission request that arrived before its call (async delivery) is linked now.
    const waiting = Object.entries(this.s.permissions).find(
      ([, p]) => p.callId === null && p.agentId === agentId && p.tool === tool && p.inputHash === call.inputHash,
    );
    if (waiting) {
      this.s.permissions[waiting[0]] = { ...waiting[1], callId };
      this.s.calls[callId] = { ...call, permissionId: waiting[0] };
    }
    return this.s.calls[callId]!;
  }

  /** The open call a result belongs to; synthesised (inferred) when the start never arrived. */
  private callForResult(): { callId: string; call: CallState } | { ignored: string } {
    const callId = str(this.hook, 'tool_use_id');
    if (!callId) return { ignored: 'tool result without tool_use_id' };
    // After an idle close the session goes on in a new segment, which records the result (its start inferred).
    const continues = this.s.status === 'closed' && this.s.closedBy !== 'ended';
    if (!continues && closedHas(this.s.closedCalls, callId)) return { ignored: 'late result for a closed call' };
    this.ensureRun('reported');
    const call = this.s.calls[callId] ?? this.startCall(callId, this.agentOf(), 'inferred');
    return { callId, call };
  }

  private closeCall(callId: string, ran: boolean): void {
    const call = this.s.calls[callId];
    delete this.s.calls[callId];
    this.s.closedCalls = closedAdd(this.s.closedCalls, callId);
    if (call) {
      const closed: ClosedCall = { callId, agentId: call.agentId, tool: call.tool, inputHash: call.inputHash, ran, hadPermission: call.permissionId !== null };
      this.s.recentCalls = [...this.s.recentCalls, closed].slice(-RECENT_CALLS);
    }
  }

  private durationOf(call: CallState): number {
    const reported = num(this.hook, 'duration_ms');
    if (reported !== undefined && reported >= 0) return reported;
    return Math.max(0, Date.parse(this.at) - Date.parse(call.startedAt));
  }

  private resolvePermission(call: CallState, decision: 'approved' | 'denied', by: string, provenance: Provenance): void {
    if (!call.permissionId || !this.s.permissions[call.permissionId]) return;
    this.emit({ type: 'tool.permission_resolved', payload: { permissionId: call.permissionId, decision, by } }, provenance);
    delete this.s.permissions[call.permissionId];
  }

  /** `durationMs` defaults to the time since the call started (for closes Runloop infers). */
  private failCall(
    callId: string,
    call: CallState,
    errorType: 'denied' | 'aborted' | 'unobserved',
    message: string,
    provenance: Provenance,
    durationMs = Math.max(0, Date.parse(this.at) - Date.parse(call.startedAt)),
  ): void {
    this.emit(
      {
        type: 'tool.call_failed',
        payload: { callId, errorType, message, durationMs },
        actorId: call.agentId,
        ...(call.taskId ? { taskId: call.taskId } : {}),
      },
      provenance,
      { parentCallId: callId },
    );
    this.closeCall(callId, false);
  }

  /**
   * A boundary for an agent: its pending permissions were never followed by a
   * result, so they were denied (inferred). `onlyBatchEnded`: just those whose
   * call's batch already ended (the agent has moved on to its next step).
   */
  private denyPending(agentId: string | null, onlyBatchEnded = false): void {
    for (const [permId, p] of Object.entries(this.s.permissions)) {
      if (agentId !== null && p.agentId !== agentId) continue;
      if (onlyBatchEnded && !p.batchEnded) continue;
      this.emit({ type: 'tool.permission_resolved', payload: { permissionId: permId, decision: 'denied', by: 'unknown' } }, 'inferred');
      delete this.s.permissions[permId];
      const call = p.callId ? this.s.calls[p.callId] : undefined;
      if (p.callId && call) this.failCall(p.callId, call, 'denied', INFERRED_DENIAL, 'inferred');
    }
  }

  /** Close everything (SessionEnd, idle sweep, restart). */
  closeAll(reason: 'ended' | 'idle' | 'restart'): void {
    const s = this.s;
    this.denyPending(null);
    const why =
      reason === 'ended'
        ? 'The session ended before a result was reported (inferred)'
        : reason === 'idle'
          ? `No events from Claude Code for ${this.ctx.idleMinutes} min; result not reported (inferred)`
          : 'Runloop restarted; result not reported (inferred)';
    for (const [callId, call] of Object.entries(s.calls)) this.failCall(callId, call, 'unobserved', why, 'inferred');
    const taskSummary = reason === 'ended' ? 'Ended with the session (inferred)' : 'Closed without a reported end (inferred)';
    this.closeTurn(taskSummary, 'inferred');
    for (const [id, a] of Object.entries(s.subagents)) {
      if (a.done) continue;
      if (a.taskId) this.emit({ type: 'task.completed', payload: { taskId: a.taskId, summary: taskSummary, artifactIds: [] } }, 'inferred');
      this.emit({ type: 'agent.state_changed', payload: { agentId: id, state: 'done', reason: taskSummary } }, 'inferred');
      s.subagents[id] = { ...a, done: true };
    }
    if (s.mainState === 'working' || s.mainState === 'waiting') this.setMainState('idle', 'Session closed', 'inferred');
    if (reason === 'ended') {
      const why = str(this.hook, 'reason');
      this.emit(
        { type: 'run.completed', payload: { outcome: 'stopped', summary: `Session ended (${why ? oneLine(why, 80) : 'reason not reported'})` }, actorId: 'system' },
        'reported',
      );
    } else {
      this.emit(
        {
          type: 'run.completed',
          payload: {
            outcome: 'interrupted',
            summary:
              reason === 'idle'
                ? `No events from Claude Code for ${this.ctx.idleMinutes} min; closed without a session end (inferred)`
                : 'Runloop restarted while this session was traced (inferred)',
          },
          actorId: 'system',
        },
        'inferred',
      );
    }
    s.status = 'closed';
    s.closedAt = this.at;
    s.closedBy = reason;
    s.turn = null;
  }

  // ── hooks ──────────────────────────────────────────────────────────

  /** Apply one hook. Returns a reason when the delivery is ignored. */
  handle(event: string): string | undefined {
    const s = this.s;
    const h = this.hook;
    switch (event) {
      case 'SessionStart': {
        s.pending = {
          cwd: str(h, 'cwd') ?? s.pending.cwd,
          model: str(h, 'model') ?? s.pending.model,
          startSource: str(h, 'source') ?? s.pending.startSource,
        };
        if (s.status === 'open') {
          const source = str(h, 'source') ?? 'unknown';
          const marker =
            source === 'resume'
              ? { kind: 'session_resumed' as const, label: 'Session resumed' }
              : source === 'compact'
                ? { kind: 'compaction' as const, label: 'Session continued after compaction' }
                : { kind: 'other' as const, label: `Session started again (${oneLine(source, 40)})` };
          this.emit({ type: 'run.marker', payload: { ...marker, agentId: MAIN_AGENT_ID } }, 'reported');
        }
        return undefined;
      }

      case 'UserPromptSubmit': {
        this.ensureRun('reported');
        this.denyPending(MAIN_AGENT_ID);
        this.closeTurn('Turn ended without a reported reply (inferred)', 'inferred');
        this.openTurn(str(h, 'prompt') ?? '', 'reported');
        return undefined;
      }

      case 'PreToolUse': {
        const callId = str(h, 'tool_use_id');
        if (!callId) return 'PreToolUse without tool_use_id';
        if (s.calls[callId] || (s.status === 'open' && closedHas(s.closedCalls, callId))) return 'call already known';
        this.ensureRun('reported');
        const agentId = this.agentOf();
        // A new step of this agent: a permission whose batch ended without a result was denied.
        this.denyPending(agentId, true);
        this.startCall(callId, agentId, 'reported');
        return undefined;
      }

      case 'PostToolBatch': {
        if (s.status !== 'open') return 'PostToolBatch without an open run';
        const agentId = this.agentOf();
        this.denyPending(agentId, true);
        const ids = new Set(
          (Array.isArray(h.tool_calls) ? h.tool_calls : []).flatMap((c) =>
            c !== null && typeof c === 'object' && typeof (c as Hook).tool_use_id === 'string' ? [(c as Hook).tool_use_id as string] : [],
          ),
        );
        // The batch's results are all in; a call still waiting on a permission got none (its result may still be
        // in flight, so the denial is only inferred at the agent's next step).
        for (const [permId, p] of Object.entries(s.permissions)) {
          if (p.callId && ids.has(p.callId) && s.calls[p.callId]) s.permissions[permId] = { ...p, batchEnded: true };
        }
        return undefined;
      }

      case 'PermissionRequest': {
        this.ensureRun('reported');
        const agentId = this.agentOf();
        const tool = oneLine(str(h, 'tool_name') ?? 'unknown', 100) || 'unknown';
        const input = this.toolInput();
        const hash = inputHash(input);
        const same = (c: { agentId: string; tool: string; inputHash: string }) => c.agentId === agentId && c.tool === tool && c.inputHash === hash;
        // A permission_prompt notification that arrived first already recorded this prompt (inferred): keep that one.
        const fromNotification = Object.entries(s.permissions).find(([, p]) => p.agentId === agentId && p.source === 'notification');
        // No tool_use_id: the newest open call of this agent with the same tool and input (inferred link).
        const match = Object.entries(s.calls)
          .reverse()
          .find(([, c]) => same(c) && (!c.permissionId || c.permissionId === fromNotification?.[0]));
        if (fromNotification) {
          const [permId, p] = fromNotification;
          s.permissions[permId] = { ...p, source: 'request' };
          if (match && match[0] !== p.callId) {
            // Move the link to the call the request names.
            if (p.callId && s.calls[p.callId]) s.calls[p.callId] = { ...s.calls[p.callId]!, permissionId: null };
            s.calls[match[0]] = { ...match[1], permissionId: permId };
            s.permissions[permId] = { ...s.permissions[permId]!, callId: match[0] };
          }
          return undefined;
        }
        // Delivered after its call's result (async): the call ran, so it was approved (inferred).
        const ran = match ? undefined : [...s.recentCalls].reverse().find((c) => same(c) && !c.hadPermission);
        const permId = permissionId(++s.counters.permission);
        const callId = match?.[0] ?? ran?.callId;
        if (match) s.calls[match[0]] = { ...match[1], permissionId: permId };
        if (!ran) s.permissions[permId] = { agentId, callId: match?.[0] ?? null, tool, inputHash: hash, source: 'request', batchEnded: false };
        const shell = isShellTool(tool);
        this.emit(
          {
            type: 'tool.permission_requested',
            payload: {
              permissionId: permId,
              agentId,
              ...(callId ? { callId } : {}),
              action: oneLine(`${tool} ${inputSummary(tool, input, this.cwd)}`, 200),
              scope: s.permissionMode ?? 'default',
            },
            ...(shell ? { visibility: 'sensitive' as const } : {}),
          },
          'reported',
        );
        if (ran) {
          s.recentCalls = s.recentCalls.map((c) => (c === ran ? { ...c, hadPermission: true } : c));
          this.emit(
            { type: 'tool.permission_resolved', payload: { permissionId: permId, decision: ran.ran ? 'approved' : 'denied', by: ran.ran ? 'user' : 'unknown' } },
            'inferred',
          );
        }
        return undefined;
      }

      case 'PostToolUse': {
        const found = this.callForResult();
        if ('ignored' in found) return found.ignored;
        const { callId, call } = found;
        this.resolvePermission(call, 'approved', 'user', 'inferred');
        const result = toolResult(h);
        const tests = call.category === 'test' ? parseTestOutput(`${result?.stdoutTail ?? ''}\n${result?.stderrTail ?? ''}`) : undefined;
        this.emit(
          {
            type: 'tool.call_completed',
            payload: {
              callId,
              status: 'success',
              durationMs: this.durationOf(call),
              outputSummary: oneLine(this.text(successSummary(call.tool, result, tests?.metrics)), OUTPUT_SUMMARY_MAX),
              ...(tests?.metrics ? { metrics: tests.metrics } : {}),
              ...(tests?.failingTests.length ? { failingTests: tests.failingTests } : {}),
            },
            actorId: call.agentId,
            ...(call.taskId ? { taskId: call.taskId } : {}),
          },
          'reported',
          { parentCallId: callId },
        );
        if (call.category === 'delegate') this.reportAgentResult(callId, call);
        this.closeCall(callId, true);
        return undefined;
      }

      case 'PostToolUseFailure': {
        const found = this.callForResult();
        if ('ignored' in found) return found.ignored;
        const { callId, call } = found;
        const error = str(h, 'error') ?? '';
        if (h.is_interrupt === true) {
          this.resolvePermission(call, 'denied', 'user', 'inferred');
          const message = oneLine(`Interrupted${error ? `: ${this.text(error)}` : ''}`, OUTPUT_SUMMARY_MAX);
          this.failCall(callId, call, 'aborted', message, 'reported', this.durationOf(call));
          return undefined;
        }
        this.resolvePermission(call, 'approved', 'user', 'inferred');
        const { exitCode, output } = splitExitCode(error);
        const tests = call.category === 'test' ? parseTestOutput(output) : undefined;
        this.emit(
          {
            type: 'tool.call_completed',
            payload: {
              callId,
              status: 'error',
              durationMs: this.durationOf(call),
              ...(exitCode !== undefined ? { exitCode } : {}),
              outputSummary: failureSummary(error, exitCode, tests?.metrics, this.cwd),
              ...(tests?.metrics ? { metrics: tests.metrics } : {}),
              ...(tests?.failingTests.length ? { failingTests: tests.failingTests } : {}),
              errorType: exitCode !== undefined ? 'exit_nonzero' : 'tool_error',
            },
            actorId: call.agentId,
            ...(call.taskId ? { taskId: call.taskId } : {}),
          },
          'reported',
          { parentCallId: callId },
        );
        this.closeCall(callId, true);
        return undefined;
      }

      case 'PermissionDenied': {
        const found = this.callForResult();
        if ('ignored' in found) return found.ignored;
        const { callId, call } = found;
        this.resolvePermission(call, 'denied', 'auto mode', 'reported');
        const reason = str(h, 'reason') ?? str(h, 'message');
        this.failCall(callId, call, 'denied', oneLine(reason ? this.text(reason) : 'Denied by auto mode', OUTPUT_SUMMARY_MAX), 'reported');
        return undefined;
      }

      case 'SubagentStart': {
        const cc = str(h, 'agent_id');
        if (!cc) return 'SubagentStart without agent_id';
        this.ensureRun('reported');
        if (s.subagents[subagentId(cc)]) return undefined; // already registered from an earlier (reordered) event
        this.ensureSubagent(cc, str(h, 'agent_type') ?? 'subagent', 'reported');
        return undefined;
      }

      case 'SubagentStop': {
        const cc = str(h, 'agent_id');
        if (!cc) return 'SubagentStop without agent_id';
        this.ensureRun('reported');
        const id = this.ensureSubagent(cc, str(h, 'agent_type') ?? 'subagent', 'inferred');
        const agent = s.subagents[id]!;
        if (agent.done) return 'subagent already stopped';
        this.denyPending(id);
        for (const [callId, call] of Object.entries(s.calls)) {
          if (call.agentId === id) this.failCall(callId, call, 'unobserved', 'The subagent stopped before a result was reported (inferred)', 'inferred');
        }
        const reply = str(h, 'last_assistant_message');
        if (reply) {
          this.emit(
            {
              type: 'agent.message_sent',
              payload: { messageId: messageId(++s.counters.message), fromAgentId: id, to: MAIN_AGENT_ID, text: clipText(this.text(reply), MESSAGE_MAX) },
              visibility: 'sensitive',
            },
            'reported',
          );
        }
        if (agent.taskId) {
          this.emit(
            {
              type: 'task.completed',
              payload: { taskId: agent.taskId, summary: reply ? oneLine(this.text(reply), 160) : 'Finished (no reply reported)', artifactIds: [] },
              ...(reply ? { visibility: 'sensitive' as const } : {}),
            },
            'reported',
          );
        }
        this.emit({ type: 'agent.state_changed', payload: { agentId: id, state: 'done', reason: 'Subagent finished' } }, 'reported');
        s.subagents[id] = { ...agent, done: true };
        return undefined;
      }

      case 'Stop': {
        if (s.status !== 'open') return 'Stop without an open run';
        if (h.stop_hook_active === true) return undefined; // a stop hook keeps Claude going; the turn is not over
        this.denyPending(MAIN_AGENT_ID);
        const reply = str(h, 'last_assistant_message');
        if (reply) {
          this.emit(
            {
              type: 'agent.message_sent',
              payload: { messageId: messageId(++s.counters.message), fromAgentId: MAIN_AGENT_ID, to: USER_AGENT_ID, text: clipText(this.text(reply), MESSAGE_MAX) },
              visibility: 'sensitive',
            },
            'reported',
          );
        }
        this.closeTurn(reply ? oneLine(this.text(reply), 160) : 'Turn finished (no reply reported)', 'reported', reply ? 'sensitive' : 'public');
        this.setMainState('idle', 'Turn finished', 'reported');
        return undefined;
      }

      case 'StopFailure': {
        if (s.status !== 'open') return 'StopFailure without an open run';
        this.denyPending(MAIN_AGENT_ID);
        const detail = str(h, 'error') ?? str(h, 'error_details') ?? str(h, 'message');
        const reason = detail ? oneLine(this.text(detail), OUTPUT_SUMMARY_MAX) : 'API error (details not reported)';
        if (s.turn) {
          this.emit({ type: 'task.failed', payload: { taskId: s.turn.taskId, reason, errorType: 'api_error' } }, 'reported');
          s.turn = null;
        }
        this.setMainState('failed', reason, 'reported');
        this.emit({ type: 'run.marker', payload: { kind: 'api_error', label: 'API error', detail: reason, agentId: MAIN_AGENT_ID } }, 'reported');
        return undefined;
      }

      case 'Notification': {
        if (s.status !== 'open') return 'Notification without an open run';
        const type = str(h, 'notification_type');
        const message = str(h, 'message');
        const agentId = this.agentOf();
        if (type === 'idle_prompt') {
          if (agentId === MAIN_AGENT_ID) this.setMainState('waiting', 'Waiting for your input', 'reported');
          else this.emit({ type: 'agent.state_changed', payload: { agentId, state: 'waiting', reason: 'Waiting for your input' } }, 'reported');
        } else if (type === 'permission_prompt') {
          const pending = Object.values(s.permissions).some((p) => p.agentId === agentId);
          const open = Object.entries(s.calls).reverse().find(([, c]) => c.agentId === agentId && !c.permissionId);
          if (pending || !open) return 'permission prompt already recorded';
          const permId = permissionId(++s.counters.permission);
          s.permissions[permId] = { agentId, callId: open[0], tool: open[1].tool, inputHash: open[1].inputHash, source: 'notification', batchEnded: false };
          s.calls[open[0]] = { ...open[1], permissionId: permId };
          this.emit(
            {
              type: 'tool.permission_requested',
              payload: { permissionId: permId, agentId, callId: open[0], action: oneLine(this.text(message ?? open[1].tool), 200), scope: s.permissionMode ?? 'default' },
            },
            'inferred',
          );
        } else {
          this.emit(
            { type: 'run.marker', payload: { kind: 'notification', label: oneLine(this.text(message ?? type ?? 'Notification'), 160), agentId } },
            'reported',
          );
        }
        return undefined;
      }

      case 'PreCompact':
      case 'PostCompact': {
        if (s.status !== 'open') return `${event} without an open run`;
        const trigger = str(h, 'trigger');
        const summary = str(h, 'compact_summary');
        this.emit(
          {
            type: 'run.marker',
            payload: {
              kind: 'compaction',
              label: event === 'PreCompact' ? `Compaction started${trigger ? ` (${oneLine(trigger, 40)})` : ''}` : 'Compaction finished',
              ...(summary !== undefined ? { detail: `Summary of ${summary.length} characters` } : {}),
              agentId: MAIN_AGENT_ID,
            },
          },
          'reported',
        );
        return undefined;
      }

      case 'SessionEnd': {
        if (s.status !== 'open') return 'SessionEnd without an open run';
        this.closeAll('ended');
        return undefined;
      }

      default:
        return `unhandled hook ${event}`;
    }
  }

  /**
   * The Agent result names the subagent this call started (reported). When the
   * link guessed at SubagentStart named another call, the subagent's task got
   * that call's title and parent: say so with a marker, and fix the state.
   */
  private confirmLink(callId: string, call: CallState, id: string, agent: SubagentState): void {
    const s = this.s;
    if (call.subagentId && call.subagentId !== id && s.subagents[call.subagentId]?.callId === callId) {
      s.subagents[call.subagentId] = { ...s.subagents[call.subagentId]!, callId: null };
    }
    s.subagents[id] = { ...agent, callId };
    if (agent.titledFrom && agent.titledFrom !== callId) {
      const name = agent.name;
      const what = call.description ? `"${oneLine(this.text(call.description), 80)}"` : `call ${callId}`;
      this.emit(
        {
          type: 'run.marker',
          payload: {
            kind: 'other',
            label: `Delegation corrected: ${name} was started by ${what}`,
            detail: `Its task's title and parent were inferred from arrival order (call ${agent.titledFrom}); the Agent result names the subagent.`,
            agentId: id,
          },
        },
        'reported',
      );
    }
  }

  /** The Agent tool's result names the subagent and carries its reported usage. */
  private reportAgentResult(callId: string, call: CallState): void {
    const result = toolResult(this.hook);
    const fields = result?.fields ?? {};
    const cc = typeof fields.agentId === 'string' ? fields.agentId : null;
    if (!cc) return;
    const id = subagentId(cc);
    const known = this.s.subagents[id];
    if (known) this.confirmLink(callId, call, id, known);
    else {
      // Never saw this subagent start or stop: register it so the report has an owner (not embodied).
      const name = `${call.subagentType ?? 'subagent'} (late)`;
      this.s.subagents[id] = { ccAgentId: cc, type: call.subagentType ?? 'subagent', name, taskId: null, done: true, embodied: false, callId, titledFrom: null };
      this.emit(
        { type: 'agent.registered', payload: { agentId: id, name, role: call.subagentType ?? 'subagent', model: null, tools: [], embodied: false } },
        'inferred',
      );
    }
    const usage = result?.usage ?? {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
    const input = n(usage.input_tokens);
    const output = n(usage.output_tokens);
    if (input === undefined || output === undefined) return; // not reported: no event, never zeros
    const cacheRead = n(usage.cache_read_input_tokens);
    const cacheCreation = n(usage.cache_creation_input_tokens);
    const total = n(fields.totalTokens);
    const duration = typeof fields.totalDurationMs === 'number' && fields.totalDurationMs >= 0 ? fields.totalDurationMs : undefined;
    const toolUses = n(fields.totalToolUseCount);
    this.emit(
      {
        type: 'agent.usage_reported',
        payload: {
          agentId: id,
          model: typeof fields.resolvedModel === 'string' ? fields.resolvedModel : null,
          inputTokens: input,
          outputTokens: output,
          ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
          ...(total !== undefined ? { totalTokens: total } : {}),
          ...(duration !== undefined ? { durationMs: duration } : {}),
          ...(toolUses !== undefined ? { toolUseCount: toolUses } : {}),
          callId,
          source: 'claude-code.agent_result',
        },
      },
      'reported',
    );
  }
}

/** The project's base name (never the path). */
export function projectLabelOf(cwd: string | null): string {
  if (!cwd) return 'unknown project';
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return oneLine(base, 200) || 'unknown project';
}
