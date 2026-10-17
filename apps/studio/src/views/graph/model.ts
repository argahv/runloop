import type { ExecState, TaskStatus } from '@runloop-world/core';
import type { AgentRuntimeState, TaskKind, ToolCategory } from '@runloop-world/events';
import { identityIndex } from '../../state/identity';
import { usageText } from '../../state/labels';
import type { StatusView } from '../../state/view';

/**
 * The agent network at one point of a run (pure, from Layer-1 state only):
 * agents as nodes, delegation edges (who handed a task to whom) and message
 * edges (who talked to whom, how often, and the latest message).
 */

export interface GraphTask {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
}

export interface GraphNode {
  id: string;
  name: string;
  role: string;
  model: string | null;
  embodied: boolean;
  /** Identity hue (1-based, --rl-id-N) or null for agents without one (same rule as the world and timeline). */
  identity: number | null;
  state: AgentRuntimeState;
  /** Task the agent is on now, if any. */
  task: GraphTask | null;
  /** Tool call in flight, if any. */
  call: { tool: string; category: ToolCategory | null } | null;
  /** Usage the source reported for this agent, as text; null = not reported (never shown as zero). */
  usage: string | null;
  /** Incidents on this agent that are still open. */
  openIncidents: number;
  /** Sequence of the newest open incident (to jump to it). */
  latestIncidentSeq: number | null;
  registeredSeq: number;
}

export interface DelegationEdge {
  id: string;
  from: string;
  to: string;
  /** Tasks handed over along this edge, in creation order. */
  tasks: GraphTask[];
  /** A handed-over task is being worked on now. */
  active: boolean;
  /** The latest handed-over task failed. */
  failed: boolean;
}

export interface MessageEdge {
  id: string;
  /** The pair, in registration order. */
  a: string;
  b: string;
  count: number;
  aToB: number;
  bToA: number;
  latest: { seq: number; from: string; to: string; eventId: string };
}

export interface AgentGraph {
  nodes: GraphNode[];
  delegations: DelegationEdge[];
  messages: MessageEdge[];
}

const OPEN: ReadonlySet<TaskStatus> = new Set(['assigned', 'in_progress', 'blocked']);
const RUN_ENDED = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);

function graphTask(exec: ExecState, id: string | null): GraphTask | null {
  const t = id ? exec.tasks[id] : undefined;
  return t ? { id: t.id, kind: t.kind, title: t.title, status: t.status } : null;
}

export function buildAgentGraph(exec: ExecState): AgentGraph {
  const ids = exec.agentOrder.filter((id) => exec.agents[id]);
  const known = new Set(ids);
  const order = new Map(ids.map((id, i) => [id, i]));
  const ended = RUN_ENDED.has(exec.run.status);

  const incidents = new Map<string, { open: number; latest: number | null }>();
  for (const inc of exec.incidents) {
    if (!inc.agentId || inc.resolvedSeq !== null) continue;
    const cur = incidents.get(inc.agentId) ?? { open: 0, latest: null };
    incidents.set(inc.agentId, { open: cur.open + 1, latest: Math.max(cur.latest ?? 0, inc.seq) });
  }

  const nodes: GraphNode[] = ids.map((id) => {
    const a = exec.agents[id]!;
    const call = a.activeCallId ? exec.toolCalls.get(a.activeCallId) : undefined;
    const usage = a.usage ? usageText(a.usage) : null;
    const inc = incidents.get(id);
    return {
      id,
      name: a.name,
      role: a.role,
      model: a.model,
      embodied: a.embodied,
      identity: identityIndex(exec, id),
      state: a.state,
      task: graphTask(exec, a.currentTaskId),
      call: call && call.status === 'running' ? { tool: call.tool, category: call.category } : null,
      usage,
      openIncidents: inc?.open ?? 0,
      latestIncidentSeq: inc?.latest ?? null,
      registeredSeq: a.registeredSeq,
    };
  });

  const delegations = new Map<string, DelegationEdge>();
  for (const tid of exec.taskOrder) {
    const t = exec.tasks[tid];
    if (!t || !t.createdBy || !t.ownerId || t.createdBy === t.ownerId) continue;
    if (!known.has(t.createdBy) || !known.has(t.ownerId)) continue;
    const key = `${t.createdBy}>${t.ownerId}`;
    const e = delegations.get(key) ?? { id: `d:${key}`, from: t.createdBy, to: t.ownerId, tasks: [], active: false, failed: false };
    e.tasks.push({ id: t.id, kind: t.kind, title: t.title, status: t.status });
    e.active ||= !ended && OPEN.has(t.status);
    e.failed = t.status === 'failed';
    delegations.set(key, e);
  }

  const messages = new Map<string, MessageEdge>();
  for (const m of exec.messages) {
    if (!known.has(m.fromAgentId)) continue;
    const targets = m.to === 'all' ? ids.filter((id) => id !== m.fromAgentId) : known.has(m.to) ? [m.to] : [];
    for (const to of targets) {
      if (to === m.fromAgentId) continue;
      const [a, b] = order.get(m.fromAgentId)! <= order.get(to)! ? [m.fromAgentId, to] : [to, m.fromAgentId];
      const key = `${a}~${b}`;
      const e = messages.get(key) ?? { id: `m:${key}`, a, b, count: 0, aToB: 0, bToA: 0, latest: { seq: 0, from: '', to: '', eventId: '' } };
      e.count += 1;
      if (m.fromAgentId === a) e.aToB += 1;
      else e.bToA += 1;
      if (m.seq >= e.latest.seq) e.latest = { seq: m.seq, from: m.fromAgentId, to, eventId: m.eventId };
      messages.set(key, e);
    }
  }

  return { nodes, delegations: [...delegations.values()], messages: [...messages.values()] };
}

const RUNTIME_STATUS: Record<AgentRuntimeState, StatusView> = {
  idle: { icon: '◌', text: 'idle', tone: 'muted' },
  working: { icon: '⚙', text: 'working', tone: 'live' },
  waiting: { icon: '…', text: 'waiting', tone: 'warn' },
  blocked: { icon: '⏳', text: 'blocked', tone: 'warn' },
  failed: { icon: '✗', text: 'failed', tone: 'err' },
  done: { icon: '✓', text: 'done', tone: 'ok' },
};

/** Left working when the run ended (e.g. interrupted): nothing runs any more. */
const UNFINISHED: StatusView = { icon: '■', text: 'unfinished', tone: 'muted' };

/**
 * Icon + text for an agent's Layer-1 state (agents without a robot have no
 * presentation state). Once the run has ended, an agent still marked working,
 * waiting or blocked shows as unfinished, like its open tasks.
 */
export function runtimeStatusView(state: AgentRuntimeState, runEnded = false): StatusView {
  if (runEnded && (state === 'working' || state === 'waiting' || state === 'blocked')) return UNFINISHED;
  return RUNTIME_STATUS[state];
}
