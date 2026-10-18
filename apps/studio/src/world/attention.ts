/**
 * What deserves the viewer's attention (UX draft §5), as a pure fold over
 * world events. Every item cites the events it came from (seq range and
 * count), so the ticker and the catch-up never say anything the log does not.
 *
 * Severity: critical (a session failed, an approval waits, a connection was
 * lost mid-task) › attention (agent offline, an incident, a rejected command,
 * an unclaimed Claude Code session) › notable (sessions, buildings, agents
 * housed, conversations, the world resuming) › ambient (movement and needs;
 * never in the ticker, searchable in Intelligence).
 */
import type { AgentPresence, EntityRef, WorldEvent, WorldProvenance } from '@runloop-world/events';

export type Severity = 'critical' | 'attention' | 'notable' | 'ambient';
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, attention: 1, notable: 2, ambient: 3 };

export type AttentionKind =
  | 'session_failed'
  | 'permission'
  | 'dispatch_approval'
  | 'lost_mid_task'
  | 'agent_offline'
  | 'incident'
  | 'rejected'
  | 'arrival'
  | 'agent_live'
  | 'session_started'
  | 'session_ended'
  | 'housed'
  | 'building_opened'
  | 'building_closed'
  | 'conversations'
  | 'resumed'
  | 'upgraded'
  | 'dispatch';

export interface AttentionItem {
  /** Unique: groupKey plus the first seq. */
  key: string;
  groupKey: string;
  kind: AttentionKind;
  severity: Severity;
  prov: WorldProvenance;
  /** The entities it is about (the first is the subject). */
  refs: EntityRef[];
  /** The world events behind it; null only for Arrivals (from the agents API, not the world log). */
  events: { first: number; last: number; count: number } | null;
  firstTick: number;
  lastTick: number;
  /** Extra detail for the title (an outcome, a reject code, offline minutes). */
  detail?: string;
  /** A later event cleared the condition (an approval resolved, the agent came back). */
  resolved?: boolean;
  /** Folded from the log when the page opened (not news): the ticker skips it unless it still needs the viewer. */
  history?: boolean;
}

export interface Classified {
  severity: Severity;
  groupKey: string;
  kind: AttentionKind | null;
  refs: EntityRef[];
  detail?: string;
}

const agentRef = (agentId: string): EntityRef => ({ kind: 'agent', id: agentId });

/**
 * Severity and group of one event. `prev` is the agent's presence before the
 * event (to tell "lost mid-task" from "offline"). Ambient events return kind null.
 */
export function classify(e: WorldEvent, prev?: AgentPresence | null): Classified {
  const ambient: Classified = { severity: 'ambient', groupKey: `ambient:${e.type}`, kind: null, refs: [] };
  switch (e.type) {
    case 'agent.session_changed': {
      const ref = [agentRef(e.p.agentId)];
      if (e.p.phase === 'started') return { severity: 'notable', groupKey: `session:${e.p.agentId}`, kind: 'session_started', refs: ref };
      if (e.p.outcome === 'failed') return { severity: 'critical', groupKey: `failed:${e.p.agentId}`, kind: 'session_failed', refs: ref, detail: e.p.outcome };
      return { severity: 'notable', groupKey: `session:${e.p.agentId}`, kind: 'session_ended', refs: ref, ...(e.p.outcome ? { detail: e.p.outcome } : {}) };
    }
    case 'agent.connection_changed': {
      const ref = [agentRef(e.p.agentId)];
      if (e.p.attention === 'permission_requested') return { severity: 'critical', groupKey: `permission:${e.p.agentId}`, kind: 'permission', refs: ref };
      if (e.p.attention === 'dispatch_awaiting_approval') return { severity: 'critical', groupKey: `dispatch:${e.p.agentId}`, kind: 'dispatch_approval', refs: ref };
      if (e.p.health === 'offline' && prev && prev.health !== 'offline') {
        if (prev.activeRunId) return { severity: 'critical', groupKey: `lost:${e.p.agentId}`, kind: 'lost_mid_task', refs: ref };
        return { severity: 'attention', groupKey: `offline:${e.p.agentId}`, kind: 'agent_offline', refs: ref };
      }
      if (e.p.attention === 'incident' && prev?.attention !== 'incident') return { severity: 'attention', groupKey: `incident:${e.p.agentId}`, kind: 'incident', refs: ref };
      if (e.p.health === 'live' && prev && prev.health !== 'live') return { severity: 'notable', groupKey: `live:${e.p.agentId}`, kind: 'agent_live', refs: ref };
      return { ...ambient, refs: ref };
    }
    case 'command.rejected':
      return { severity: 'attention', groupKey: `rejected:${e.prov}:${e.p.code}`, kind: 'rejected', refs: [], detail: e.p.code };
    case 'agent.housed':
      return { severity: 'notable', groupKey: `housed:${e.p.agentId}`, kind: 'housed', refs: [agentRef(e.p.agentId)] };
    case 'building.open_changed':
      return {
        severity: 'notable',
        groupKey: `building:${e.p.buildingId}`,
        kind: e.p.open ? 'building_opened' : 'building_closed',
        refs: [{ kind: 'building', id: e.p.buildingId }],
      };
    case 'interaction.happened': {
      const kind = e.p.placeId.startsWith('bld_') ? 'building' : 'spot';
      return { severity: 'notable', groupKey: `talk:${e.p.placeId}`, kind: 'conversations', refs: [{ kind, id: e.p.placeId }] };
    }
    case 'world.resumed_after_offline':
      return { severity: 'notable', groupKey: 'resumed', kind: 'resumed', refs: [], detail: String(e.p.offlineWallMs) };
    case 'world.sim_upgraded':
      return { severity: 'notable', groupKey: 'upgraded', kind: 'upgraded', refs: [], detail: `${e.p.fromVersion}→${e.p.toVersion}` };
    case 'agent.dispatch_changed':
      return { severity: 'notable', groupKey: `dispatch:${e.p.dispatchId}`, kind: 'dispatch', refs: [agentRef(e.p.agentId)], detail: e.p.outcome ?? e.p.phase };
    default:
      return ambient;
  }
}

const PROV_RANK: Record<WorldProvenance, number> = { 'external-agent': 0, inferred: 0, user: 1, system: 1, simulation: 2 };

/** Severity, then real agents before the simulation, then the most recent. */
export function compareItems(a: AttentionItem, b: AttentionItem): number {
  return (
    Number(a.resolved ?? false) - Number(b.resolved ?? false) ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    PROV_RANK[a.prov] - PROV_RANK[b.prov] ||
    (b.events?.last ?? 0) - (a.events?.last ?? 0)
  );
}

/** Items with the same group merge when they are this many sim minutes apart or less. */
export const GROUP_WINDOW_TICKS = 10;
export const MAX_ITEMS = 60;

/** Kinds a later event of another kind clears, by group prefix. */
const CLEARS: Partial<Record<AttentionKind, (c: Classified, e: WorldEvent) => boolean>> = {
  permission: (_c, e) => e.type === 'agent.connection_changed' && e.p.attention !== 'permission_requested',
  dispatch_approval: (_c, e) => e.type === 'agent.connection_changed' && e.p.attention !== 'dispatch_awaiting_approval',
  agent_offline: (_c, e) => e.type === 'agent.connection_changed' && e.p.health !== 'offline',
  lost_mid_task: (_c, e) => e.type === 'agent.connection_changed' && e.p.health !== 'offline',
  incident: (_c, e) => e.type === 'agent.connection_changed' && e.p.attention !== 'incident',
  agent_live: (_c, e) => e.type === 'agent.connection_changed' && e.p.health !== 'live',
};

/**
 * Fold one event into the items (a new array; the input is not changed).
 * Ambient events change nothing except clearing resolved conditions.
 */
export function foldAttention(
  items: readonly AttentionItem[],
  e: WorldEvent,
  prev?: AgentPresence | null,
  windowTicks: number = GROUP_WINDOW_TICKS,
): AttentionItem[] {
  const c = classify(e, prev);
  let out = items as AttentionItem[];
  // Clear earlier conditions about the same agent that this event resolves.
  const subject = c.refs[0];
  if (e.type === 'agent.connection_changed') {
    out = out.map((it) => {
      const check = CLEARS[it.kind];
      if (it.resolved || !check || it.refs[0]?.id !== e.p.agentId || !check(c, e)) return it;
      return { ...it, resolved: true };
    });
  }
  if (c.severity === 'ambient' || c.kind === null) return out === items ? [...items] : out;
  const i = out.findIndex((it) => it.groupKey === c.groupKey && !it.resolved && e.tick - it.lastTick <= windowTicks);
  if (i >= 0) {
    const it = out[i]!;
    const { history: _old, ...rest } = it;
    // Title, detail and provenance follow the latest event (e.g. a dispatch approved by
    // the user, then finished by the system, reads as the system's).
    const merged: AttentionItem = {
      ...rest,
      kind: c.kind,
      prov: e.prov,
      severity: SEVERITY_RANK[c.severity] < SEVERITY_RANK[it.severity] ? c.severity : it.severity,
      events: { first: it.events?.first ?? e.seq, last: e.seq, count: (it.events?.count ?? 0) + 1 },
      lastTick: e.tick,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
    };
    out = [...out.slice(0, i), merged, ...out.slice(i + 1)];
  } else {
    const item: AttentionItem = {
      key: `${c.groupKey}@${e.seq}`,
      groupKey: c.groupKey,
      kind: c.kind,
      severity: c.severity,
      prov: e.prov,
      refs: subject ? c.refs : [],
      events: { first: e.seq, last: e.seq, count: 1 },
      firstTick: e.tick,
      lastTick: e.tick,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
    };
    out = [...out, item];
  }
  return out.sort(compareItems).slice(0, MAX_ITEMS);
}

type Presence = Pick<AgentPresence, 'health' | 'attention' | 'activeRunId'>;

/** An agent's connection fields after one event (enough to classify the next one). */
function track(prev: Presence | null, e: WorldEvent): Presence {
  const p: Presence = prev ? { ...prev } : { health: 'not_connected', attention: 'none', activeRunId: null };
  if (e.type === 'agent.connection_changed') {
    p.health = e.p.health;
    p.attention = e.p.attention;
  } else if (e.type === 'agent.session_changed') {
    p.activeRunId = e.p.phase === 'started' ? e.p.runId : null;
  }
  return p;
}

/**
 * Fold a run of events (oldest first) into the items, tracking each agent's
 * connection along the way so "offline" and "lost mid-task" are told apart.
 * `presence` is each agent's state before the first event, when known.
 */
export function foldAttentionLog(
  items: readonly AttentionItem[],
  events: readonly WorldEvent[],
  presence: ReadonlyMap<string, Presence> = new Map(),
  windowTicks: number = GROUP_WINDOW_TICKS,
): AttentionItem[] {
  const agents = new Map<string, Presence>(presence);
  let out = [...items];
  for (const e of events) {
    const id = 'agentId' in e.p ? (e.p as { agentId: string }).agentId : null;
    const prev = id ? (agents.get(id) ?? null) : null;
    out = foldAttention(out, e, prev ? ({ ...prev } as AgentPresence) : null, windowTicks);
    if (id) agents.set(id, track(prev, e));
  }
  return out;
}

/** Items for unclaimed Claude Code sessions (from GET /api/agents/arrivals; no world events behind them). */
export function arrivalItems(arrivals: readonly { sessionId: string; projectLabel: string }[]): AttentionItem[] {
  return arrivals.map((a) => ({
    key: `arrival:${a.sessionId}`,
    groupKey: `arrival:${a.sessionId}`,
    kind: 'arrival' as const,
    severity: 'attention' as const,
    prov: 'external-agent' as const,
    refs: [],
    events: null,
    firstTick: 0,
    lastTick: 0,
    detail: a.projectLabel,
  }));
}

export const TICKER_GAP_MS = 4000;

/**
 * The next item for the ticker, or null. At most one item every 4 s; a
 * critical item skips the wait. `shown` maps item keys to the event count
 * last shown, so an item comes back when more events join it. Ambient and
 * resolved items never show.
 */
export function nextTickerItem(
  items: readonly AttentionItem[],
  nowMs: number,
  lastShownMs: number,
  shown: ReadonlyMap<string, number> = new Map(),
): AttentionItem | null {
  const next = [...items]
    .sort(compareItems)
    .find(
      (it) =>
        it.severity !== 'ambient' &&
        !it.resolved &&
        // History is not news; only conditions that still need the viewer come back from it.
        !(it.history && it.severity === 'notable') &&
        shown.get(it.key) !== (it.events?.count ?? 1),
    );
  if (!next) return null;
  if (next.severity === 'critical') return next;
  return nowMs - lastShownMs >= TICKER_GAP_MS ? next : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const OUTCOME: Record<string, string> = {
  succeeded: 'finished',
  stopped: 'ended',
  failed: 'failed',
  interrupted: 'was interrupted',
};

const REJECT: Record<string, string> = {
  forbidden_source: 'not allowed from that source',
  unknown_entity: 'it named something that does not exist',
  lot_unavailable: 'that lot is taken or not an agent lot',
  not_housed: 'that agent has no building yet',
  invalid: 'it was not valid',
};

/** One sentence for an item, from recorded facts only. `name` resolves entity names. */
export function attentionTitle(item: AttentionItem, name: (ref: EntityRef) => string): string {
  const who = item.refs[0] ? name(item.refs[0]) : 'Something';
  const n = item.events?.count ?? 1;
  switch (item.kind) {
    case 'session_failed':
      return `${who}: a session failed`;
    case 'permission':
      return `${who} is waiting for a permission in Claude Code`;
    case 'dispatch_approval':
      return `${who}: a task is waiting for your approval`;
    case 'lost_mid_task':
      return `${who} went offline during a session`;
    case 'agent_offline':
      return `${who} is offline`;
    case 'incident':
      return `${who} reported a failure in its session`;
    case 'rejected': {
      const by = item.prov === 'user' ? 'Your command was' : item.prov === 'system' ? "Runloop's command was" : 'A command was';
      return `${by} rejected${n > 1 ? ` (${n}×)` : ''}: ${REJECT[item.detail ?? ''] ?? item.detail ?? 'no reason given'}`;
    }
    case 'arrival':
      return `Unclaimed Claude Code session in “${item.detail ?? 'a project'}”`;
    case 'agent_live':
      return `${who} is live`;
    case 'session_started':
      return n > 1 ? `${who}: ${plural(n, 'session event')}` : `${who} started a session`;
    case 'session_ended':
      return n > 1 ? `${who}: ${plural(n, 'session event')}` : `${who}: session ${OUTCOME[item.detail ?? ''] ?? 'ended'}`;
    case 'housed':
      return `${who} moved into the Agent District`;
    case 'building_opened':
      return `${who} opened`;
    case 'building_closed':
      return `${who} closed`;
    case 'conversations':
      return `${plural(n, 'conversation')} at ${who}`;
    case 'resumed': {
      const min = Math.round(Number(item.detail ?? 0) / 60_000);
      return `The world resumed after ${min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`} with Runloop off (shown as paused)`;
    }
    case 'upgraded':
      return `The simulation was upgraded (${item.detail ?? ''})`;
    case 'dispatch':
      return `${who}: dispatched task ${item.detail ?? ''}`;
  }
}

/** Polite live-region announcements are for critical and attention items only. */
export const announces = (item: AttentionItem) => item.severity === 'critical' || item.severity === 'attention';
