/**
 * Pure view models for the context panels and chips (plan §5, P10 on the UI
 * side). Everything shown is read from the snapshot, the town file, the
 * agents API or a recorded event; a value nobody reported says "not reported".
 *
 * - Residents are labelled Simulated; their Why comes only from the recorded
 *   decision (`explanationView` drops any factor without a source).
 * - "Real" appears only on external-agent entities (agents and the events
 *   they report). Agent views have no Why: nothing implies hidden reasoning.
 */
import {
  CAPABILITIES,
  NEED_IDS,
  type AgentPresence,
  type AgentSummary,
  type Capability,
  type CapabilityStatus,
  type ConnectionHealth,
  type EntityKind,
  type Explanation,
  type ExplanationOption,
  type ResidentState,
  type WorldEvent,
  type WorldProvenance,
  type WorldSnapshot,
} from '@runloop-world/events';
import { blockAt, needsAt, points, scheduleOf, scheduleShift, simIndex } from '@runloop-world/sim';
import { isOpenAt, type CompiledTown } from '@runloop-world/town';
import type { Tone } from '../ui/Chip';
import type { IconName } from '../ui/Icon';
import { actionLabel, archetypeLabel, districtOf, placeText } from './entityIndex';
import { clockParts } from './interpolate';

// ── Provenance chips ─────────────────────────────────────────────────

export interface ProvChip {
  label: string;
  icon: IconName;
  tone: Tone;
  detail: string;
  /** True only for external-agent entities and events (P10). */
  real: boolean;
}

export const SIMULATED_CHIP: ProvChip = {
  label: 'Simulated',
  icon: 'diamond',
  tone: 'muted',
  detail: 'A simulated resident. Its decisions are rule-based and recorded by the engine.',
  real: false,
};

export const REAL_AGENT_CHIP: ProvChip = {
  label: 'Real · Claude Code · observed',
  icon: 'eye',
  tone: 'info',
  detail: 'A real Claude Code agent. Runloop shows what its hooks reported; it did not run or verify the work.',
  real: true,
};

const TOWN_CHIP: ProvChip = { label: 'Town', icon: 'map', tone: 'muted', detail: 'Part of the town file.', real: false };

/** The chip an entity carries. Only agents are Real. */
export function entityChip(kind: EntityKind): ProvChip {
  if (kind === 'agent') return REAL_AGENT_CHIP;
  if (kind === 'resident') return SIMULATED_CHIP;
  return TOWN_CHIP;
}

/** The chip for one world event's provenance. */
export function provenanceChip(prov: WorldProvenance, obs?: 'observed' | 'executed'): ProvChip {
  switch (prov) {
    case 'simulation':
      return { ...SIMULATED_CHIP, detail: 'Decided by the simulation engine.' };
    case 'user':
      return { label: 'You', icon: 'pencil', tone: 'muted', detail: 'A command you sent from Studio.', real: false };
    case 'system':
      return { label: 'Runloop', icon: 'settings', tone: 'muted', detail: 'Runloop itself (start-up, connection health).', real: false };
    case 'external-agent':
      return obs === 'executed'
        ? { label: 'Real · executed', icon: 'terminal', tone: 'info', detail: "Runloop's runtime ran it.", real: true }
        : REAL_AGENT_CHIP;
    case 'inferred':
      return { label: 'Inferred', icon: 'inferred', tone: 'warn', detail: 'Reconstructed by Runloop (an idle sweep or a restart closed the session); the agent did not report it.', real: false };
  }
}

// ── Health ───────────────────────────────────────────────────────────

export interface HealthView {
  text: string;
  icon: IconName;
  tone: Tone;
  detail: string;
}

const HEALTH: Record<ConnectionHealth, HealthView> = {
  live: { text: 'Live', icon: 'pulse', tone: 'live', detail: 'Events arrived in the last 5 minutes.' },
  idle: { text: 'Idle', icon: 'pause', tone: 'muted', detail: 'A session is open but quiet.' },
  offline: { text: 'Offline', icon: 'slash', tone: 'muted', detail: 'No open session. The building stays; the world keeps living.' },
  awaiting_first_event: { text: 'Waiting for first event', icon: 'hourglass', tone: 'warn', detail: 'Start Claude Code in the workspace with the Runloop plugin.' },
  not_connected: { text: 'Not connected', icon: 'circle', tone: 'muted', detail: 'No workspace is bound to this agent yet.' },
  unknown: { text: 'Unknown', icon: 'alert', tone: 'warn', detail: 'Claude Code ingest is off in this runtime, so Runloop cannot tell.' },
};

export const healthView = (h: ConnectionHealth): HealthView => HEALTH[h];

const ATTENTION: Record<AgentPresence['attention'], string | null> = {
  none: null,
  permission_requested: 'Waiting for a permission in Claude Code',
  incident: 'A tool failed in the open session',
  dispatch_awaiting_approval: 'A task waits for your approval',
};
export const attentionText = (a: AgentPresence['attention']) => ATTENTION[a];

/** "last event 12 s ago", or "no event yet". */
export function lastEventText(lastEventAt: string | null | undefined, nowMs: number): string {
  if (!lastEventAt) return 'no event yet';
  const t = Date.parse(lastEventAt);
  if (!Number.isFinite(t)) return 'last event: not reported';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `last event ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `last event ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `last event ${h} h ${m % 60} min ago` : `last event ${Math.floor(h / 24)} days ago`;
}

/** Live agents: the count the top bar shows. */
export const liveAgentCount = (snap: WorldSnapshot | null) => snap?.agents.filter((a) => a.health === 'live').length ?? 0;

// ── Residents ────────────────────────────────────────────────────────

export interface NeedBar {
  id: (typeof NEED_IDS)[number];
  label: string;
  /** Urgency 0–100 (100 = urgent). */
  points: number;
  threshold: number;
}

export interface ResidentView {
  name: string;
  role: string;
  chip: ProvChip;
  /** "Working at Lattice Lab" */
  now: string;
  /** Sim time the current action or arrival was recorded ("since 12:05"). */
  since: string;
  walking: boolean;
  home: string;
  work: string | null;
  needs: NeedBar[];
  schedule: { label: string; blocks: { id: string; label: string; from: string; to: string; current: boolean }[] };
  relationships: { idx: number; id: string; name: string; affinity: number }[];
  lastDecisionSeq: number;
}

const roleLabel = (town: CompiledTown, role: string) => town.def.roles.find((r) => r.id === role)?.label ?? role;

export function residentView(snap: WorldSnapshot, town: CompiledTown, seed: number, r: ResidentState, tick: number): ResidentView {
  const t = Math.floor(tick);
  const values = needsAt(r, t);
  const ix = simIndex(town);
  let schedule: ResidentView['schedule'] = { label: 'Not reported', blocks: [] };
  try {
    const sched = scheduleOf(ix, r);
    const current = blockAt(sched, scheduleShift(seed, r.idx), t);
    schedule = {
      label: sched.def.label,
      blocks: sched.def.blocks.map((b) => ({ id: b.id, label: b.label, from: b.from, to: b.to, current: b.id === current.id })),
    };
  } catch {
    // a role without a schedule: shown as not reported
  }
  const since = Math.max(r.needs[0].t0, r.needs[1].t0, r.needs[2].t0);
  const relationships: ResidentView['relationships'] = [];
  for (const [key, v] of Object.entries(snap.affinity)) {
    const [a, b] = key.split(':').map(Number) as [number, number];
    const other = a === r.idx ? b : b === r.idx ? a : -1;
    const o = snap.residents[other];
    if (o && v > 0) relationships.push({ idx: other, id: o.id, name: o.name, affinity: v });
  }
  relationships.sort((x, y) => y.affinity - x.affinity || x.idx - y.idx);
  const where = placeText(r, town);
  const verb = actionLabel(r.action);
  return {
    name: r.name,
    role: roleLabel(town, r.role),
    chip: SIMULATED_CHIP,
    now: r.motion ? `Walking, to go ${verb}` : `${verb[0]!.toUpperCase()}${verb.slice(1)} ${where}`,
    since: `since ${clockParts(since).hh}:${clockParts(since).mm}`,
    walking: r.motion !== null,
    home: town.buildingById.get(r.homeId)?.def.name ?? r.homeId,
    work: r.workId ? (town.buildingById.get(r.workId)?.def.name ?? r.workId) : null,
    needs: NEED_IDS.map((id, i) => ({ id, label: town.def.needs[i]!.label, points: points(values[i as 0 | 1 | 2]), threshold: town.def.needs[i]!.threshold })),
    schedule,
    relationships: relationships.slice(0, 5),
    lastDecisionSeq: r.lastDecisionSeq,
  };
}

/** An explanation as shown: factors without a recorded source are dropped (P10). */
export function explanationView(x: Explanation): { chosen: ExplanationOption; alternatives: ExplanationOption[]; dropped: number } {
  let dropped = 0;
  const keep = (o: ExplanationOption): ExplanationOption => {
    const factors = o.factors.filter((f) => {
      const ok = Number.isInteger(f.source?.seq) && f.source.seq >= 1 && typeof f.source.field === 'string' && f.source.field.length > 0;
      if (!ok) dropped++;
      return ok;
    });
    return { ...o, factors };
  };
  return { chosen: keep(x.chosen), alternatives: x.alternatives.map(keep), dropped };
}

// ── Buildings ────────────────────────────────────────────────────────

export interface BuildingView {
  id: string;
  name: string;
  purpose: string;
  org: string | null;
  district: string | null;
  /** The user's switch (a command), separate from opening hours. */
  open: boolean;
  /** Open now: the switch and the hours. */
  openNow: boolean;
  hours: string;
  occupancy: number;
  capacity: number;
  occupants: { id: string; name: string; action: string }[];
  chip: ProvChip;
  isHome: boolean;
}

export function buildingView(snap: WorldSnapshot, town: CompiledTown, id: string, tick: number): BuildingView | null {
  const b = town.buildingById.get(id);
  const state = snap.buildings.find((x) => x.id === id);
  if (!b || !state) return null;
  const minute = clockParts(tick).minuteOfDay;
  const occupants = snap.residents
    .filter((r) => !r.motion && r.place.kind === 'building' && r.place.buildingId === id)
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((r) => ({ id: r.id, name: r.name, action: actionLabel(r.action) }));
  const district = districtOf(town, id);
  return {
    id,
    name: b.def.name,
    purpose: archetypeLabel(b.def.archetype),
    org: b.def.orgId ? (town.def.orgs.find((o) => o.id === b.def.orgId)?.name ?? null) : null,
    district: district ? (town.def.districts.find((d) => d.id === district)?.label ?? null) : null,
    open: state.open,
    openNow: state.open && isOpenAt(b.hours, minute),
    hours: b.def.hours ? `${b.def.hours.open}–${b.def.hours.close}` : 'Always open',
    occupancy: state.occupancy,
    capacity: b.slots.length,
    occupants,
    chip: TOWN_CHIP,
    isHome: b.isHome,
  };
}

// ── Agents ───────────────────────────────────────────────────────────

export interface CapabilityView {
  id: Capability;
  label: string;
  available: boolean;
  /** Why it is not available (null when it is). */
  reason: string | null;
}

const CAP_LABEL: Record<Capability, string> = {
  observe: 'Observe',
  inspect: 'Inspect',
  submit_task: 'Submit task',
  cancel: 'Cancel',
  message: 'Message',
  control: 'Control',
};

/** Every capability, each with its state; unavailable ones say why. */
export function capabilityViews(caps: Partial<Record<Capability, CapabilityStatus>> | null | undefined): CapabilityView[] {
  return CAPABILITIES.map((id) => {
    const c = caps?.[id];
    if (!c) return { id, label: CAP_LABEL[id], available: false, reason: 'Not reported by this runtime' };
    const available = c.state === 'available';
    return { id, label: CAP_LABEL[id], available, reason: available ? null : (c.reason ?? c.state.replace(/_/g, ' ')) };
  });
}

/** An agent's panel model. It has no Why: an agent's reasoning is never shown or implied. */
export interface AgentView {
  agentId: string;
  name: string;
  chip: ProvChip;
  health: HealthView;
  attention: string | null;
  lastEvent: string;
  capabilities: CapabilityView[];
  workspace: { label: string; pathHint: string } | null;
  activeRunId: string | null;
  execState: string;
  counts: { category: string; n: number }[];
  helpers: number;
  openIncidents: number;
  /** The run events behind the latest change, for "see in Traces". */
  lastCause: AgentPresence['lastCause'];
  sessions: AgentSummary['sessions'];
  /** The agents API is not available: workspace, sessions and capabilities are not reported. */
  apiMissing: boolean;
}

export function agentView(presence: AgentPresence | null, summary: AgentSummary | null, nowMs: number): AgentView | null {
  if (!presence && !summary) return null;
  const health = presence?.health ?? summary!.health;
  return {
    agentId: presence?.agentId ?? summary!.agentId,
    name: presence?.displayName ?? summary!.displayName,
    chip: REAL_AGENT_CHIP,
    health: healthView(health),
    attention: attentionText(presence?.attention ?? summary?.attention ?? 'none'),
    lastEvent: summary ? lastEventText(summary.lastEventAt, nowMs) : 'last event: not reported',
    capabilities: capabilityViews(summary?.capabilities),
    workspace: summary?.workspace ? { label: summary.workspace.label, pathHint: summary.workspace.pathHint } : null,
    activeRunId: presence?.activeRunId ?? null,
    execState: presence ? presence.execState.replace(/_/g, ' ') : 'not reported',
    counts: Object.entries(presence?.counts ?? {})
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([category, n]) => ({ category, n: n ?? 0 }))
      .sort((a, b) => b.n - a.n),
    helpers: presence?.helpers ?? 0,
    openIncidents: presence?.openIncidents ?? 0,
    lastCause: presence?.lastCause ?? null,
    sessions: summary?.sessions ?? [],
    apiMissing: summary === null,
  };
}

// ── Events (World Log) ───────────────────────────────────────────────

/** One line for a world event, from its payload only. `name` resolves residents, buildings and agents. */
export function eventText(e: WorldEvent, name: (kind: EntityKind, id: string) => string, residentName: (idx: number) => string): string {
  switch (e.type) {
    case 'world.created':
      return `World created with ${e.p.roster.length} residents (seed ${e.p.seed})`;
    case 'world.resumed_after_offline':
      return `Resumed after ${Math.round(e.p.offlineWallMs / 60_000)} min with Runloop off`;
    case 'world.sim_upgraded':
      return `Simulation upgraded v${e.p.fromVersion} → v${e.p.toVersion}`;
    case 'world.clock_changed':
      return e.p.speed === 0 ? 'Paused the world' : `Set the world to ${e.p.speed}×`;
    case 'building.open_changed':
      return `${e.p.open ? 'Opened' : 'Closed'} ${name('building', e.p.buildingId)}`;
    case 'agent.housed':
      return `${e.p.displayName} moved into the Agent District`;
    case 'agent.connection_changed':
      return `${name('agent', e.p.agentId)}: ${HEALTH[e.p.health].text.toLowerCase()}${e.p.attention !== 'none' ? ` · ${ATTENTION[e.p.attention]!.toLowerCase()}` : ''}`;
    case 'agent.session_changed':
      return `${name('agent', e.p.agentId)}: session ${e.p.phase}${e.p.outcome ? ` (${e.p.outcome})` : ''}`;
    case 'agent.activity_observed': {
      const n = Object.values(e.p.counts).reduce((a, b) => a + (b ?? 0), 0);
      return `${name('agent', e.p.agentId)}: ${n} tool ${n === 1 ? 'call' : 'calls'} so far · ${e.p.execState.replace(/_/g, ' ')}`;
    }
    case 'agent.dispatch_changed':
      return `${name('agent', e.p.agentId)}: dispatch ${e.p.phase}${e.p.outcome ? ` (${e.p.outcome})` : ''}`;
    case 'resident.decided': {
      const place = e.p.place.kind === 'building' ? name('building', e.p.place.buildingId) : e.p.place.spotId ? name('spot', e.p.place.spotId) : 'outdoors';
      return `${residentName(e.p.r)} decided: ${actionLabel(e.p.a)} at ${place}`;
    }
    case 'resident.departed': {
      const place = e.p.dest.kind === 'building' ? name('building', e.p.dest.buildingId) : e.p.dest.spotId ? name('spot', e.p.dest.spotId) : 'outdoors';
      return `${residentName(e.p.r)} set off for ${place}`;
    }
    case 'resident.arrived': {
      const place = e.p.place.kind === 'building' ? name('building', e.p.place.buildingId) : e.p.place.spotId ? name('spot', e.p.place.spotId) : 'outdoors';
      return `${residentName(e.p.r)} arrived at ${place}`;
    }
    case 'interaction.happened':
      return `${residentName(e.p.a)} and ${residentName(e.p.b)} talked at ${name(e.p.placeId.startsWith('bld_') ? 'building' : 'spot', e.p.placeId)}`;
    case 'command.rejected':
      return `Command ${e.p.cmdId} rejected: ${e.p.code.replace(/_/g, ' ')}`;
  }
}

/** The agent run behind an agent event, for a link to Traces (null for other events). */
export function eventRunLink(e: WorldEvent): { runId: string; seq: number } | null {
  return e.cause ? { runId: e.cause.runId, seq: e.cause.seqTo } : null;
}

/**
 * The agent a run belongs to and its session number in that agent's list
 * (oldest = #1), for the "Agent District › Building › Session #n" crumb.
 */
export function agentOfRun(agents: readonly AgentSummary[], runId: string | null): { agent: AgentSummary; session: number } | null {
  if (!runId) return null;
  for (const agent of agents) {
    const i = agent.sessions.findIndex((s) => s.runId === runId);
    if (i >= 0) return { agent, session: agent.sessions.length - i };
  }
  return null;
}
