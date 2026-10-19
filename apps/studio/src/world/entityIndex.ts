/**
 * Every entity in the town, for ⌘K and the EntityDirectory (plan §5): the
 * same snapshot the renderer draws, so choosing an entry is the same as
 * clicking it in 3D. Districts › buildings (and outdoor spots) › occupants,
 * plus the agents in their buildings.
 */
import { formatEntityRef, type AgentSummary, type EntityRef, type ResidentState, type WorldSnapshot } from '@runloop-world/events';
import type { CompiledTown } from '@runloop-world/town';

export type EntityKindLabel = 'Resident' | 'Building' | 'Agent' | 'District' | 'Place';

export interface WorldEntity {
  ref: EntityRef;
  name: string;
  /** "Barista · at Corner Café", "Café · Market Street", "Agent · Claude Code". */
  detail: string;
  kind: EntityKindLabel;
  keywords: string;
}

export interface DirectoryNode {
  /** Unique within the tree. */
  key: string;
  /** null for groups that are not entities ("On the move"). */
  ref: EntityRef | null;
  name: string;
  detail: string;
  children: DirectoryNode[];
}

const ARCHETYPE_LABEL: Record<string, string> = {
  house: 'Home',
  flats: 'Flats',
  cafe: 'Café',
  bakery: 'Bakery',
  diner: 'Diner',
  tavern: 'Tavern',
  shop: 'Shop',
  office: 'Office',
  workshop: 'Workshop',
  lab: 'Lab',
  greenhouse: 'Greenhouse',
  library: 'Library',
  town_hall: 'Town hall',
  agent_hq: 'Agent headquarters',
};

export const archetypeLabel = (a: string) => ARCHETYPE_LABEL[a] ?? a;

const ACTION_LABEL: Record<ResidentState['action'], string> = {
  sleep: 'sleeping',
  rest: 'resting',
  eat: 'eating',
  work: 'working',
  socialize: 'socialising',
  stroll: 'strolling',
};
export const actionLabel = (a: ResidentState['action']) => ACTION_LABEL[a];

/** The display name of any town or world entity (falls back to the id, never invents one). */
export function entityName(ref: EntityRef, snapshot: WorldSnapshot | null, town: CompiledTown | null, agents: readonly AgentSummary[] = []): string {
  switch (ref.kind) {
    case 'resident':
      return snapshot?.residents.find((r) => r.id === ref.id)?.name ?? ref.id;
    case 'building': {
      const agent = snapshot?.agents.find((a) => a.buildingId === ref.id);
      if (agent) return agent.displayName;
      return town?.buildingById.get(ref.id)?.def.name ?? ref.id;
    }
    case 'agent':
      return snapshot?.agents.find((a) => a.agentId === ref.id)?.displayName ?? agents.find((a) => a.agentId === ref.id)?.displayName ?? 'an agent';
    case 'district':
      return town?.def.districts.find((d) => d.id === ref.id)?.label ?? ref.id;
    case 'spot':
      return town?.spotById.get(ref.id)?.def.label ?? ref.id;
    case 'lot': {
      const lot = town?.lotById.get(ref.id);
      return lot ? `Lot ${ref.id.replace(/^lot_/, '').replace(/_/g, ' ')}` : ref.id;
    }
  }
}

/** The district a building or spot is in. */
export function districtOf(town: CompiledTown, placeId: string): string | null {
  const b = town.buildingById.get(placeId);
  if (b) return town.lotById.get(b.def.lotId)?.districtId ?? null;
  const s = town.spotById.get(placeId);
  if (s) return s.def.districtId;
  const lot = town.agentLots.find((l) => l.buildingId === placeId);
  return lot?.districtId ?? null;
}

/** The district a resident is in now: their place's, or (walking) the cell they are on at `tick`. */
export function residentDistrict(town: CompiledTown, r: ResidentState, tick: number): string | null {
  if (r.motion) {
    const f = Math.min(r.motion.path.length - 1, Math.max(0, Math.floor((tick - r.motion.startTick) * town.def.walkCellsPerMinute)));
    const [x, y] = r.motion.path[f]!;
    const d = town.districtAt[y * town.width + x] ?? -1;
    return d >= 0 ? (town.def.districts[d]?.id ?? null) : null;
  }
  const id = r.place.kind === 'building' ? r.place.buildingId : r.place.spotId;
  return id ? districtOf(town, id) : null;
}

/** A resident's place as words: "at Corner Café", "on the way", "at Plaza steps". */
export function placeText(r: ResidentState, town: CompiledTown | null): string {
  if (r.motion) return 'on the way';
  if (r.place.kind === 'building') return `at ${town?.buildingById.get(r.place.buildingId)?.def.name ?? r.place.buildingId}`;
  return r.place.spotId ? `at ${town?.spotById.get(r.place.spotId)?.def.label ?? r.place.spotId}` : 'outdoors';
}

const roleLabel = (town: CompiledTown | null, role: string) => town?.def.roles.find((r) => r.id === role)?.label ?? role.replace(/_/g, ' ');

/** Every entity, residents first by name, then agents, buildings, places and districts. */
export function buildEntityIndex(snapshot: WorldSnapshot | null, town: CompiledTown | null, agents: readonly AgentSummary[] = []): WorldEntity[] {
  if (!snapshot || !town) return [];
  const out: WorldEntity[] = [];
  const districtLabel = (id: string | null) => (id ? (town.def.districts.find((d) => d.id === id)?.label ?? '') : '');
  for (const r of [...snapshot.residents].sort((a, b) => a.name.localeCompare(b.name))) {
    const role = roleLabel(town, r.role);
    out.push({
      ref: { kind: 'resident', id: r.id },
      name: r.name,
      detail: `${role} · ${actionLabel(r.action)} ${placeText(r, town)}`,
      kind: 'Resident',
      keywords: `${r.id} ${role} resident simulated person`,
    });
  }
  for (const a of snapshot.agents) {
    const summary = agents.find((s) => s.agentId === a.agentId);
    out.push({
      ref: { kind: 'agent', id: a.agentId },
      name: a.displayName,
      detail: `Agent · Claude Code · ${a.health.replace(/_/g, ' ')}`,
      kind: 'Agent',
      keywords: `agent claude code real building ${summary?.workspace?.label ?? ''} ${a.buildingId}`,
    });
  }
  for (const b of town.buildings) {
    const d = districtOf(town, b.def.id);
    out.push({
      ref: { kind: 'building', id: b.def.id },
      name: b.def.name,
      detail: `${archetypeLabel(b.def.archetype)} · ${districtLabel(d)}`,
      kind: 'Building',
      keywords: `${b.def.archetype} building ${b.def.sign?.text ?? ''}`,
    });
  }
  for (const s of town.spots) {
    out.push({
      ref: { kind: 'spot', id: s.def.id },
      name: s.def.label,
      detail: `${s.def.kind} · ${districtLabel(s.def.districtId)}`,
      kind: 'Place',
      keywords: `outdoor place ${s.def.kind}`,
    });
  }
  for (const d of town.def.districts) {
    out.push({ ref: { kind: 'district', id: d.id }, name: d.label, detail: `District · ${d.kind}`, kind: 'District', keywords: `district area ${d.kind}` });
  }
  return out;
}

/**
 * Entities matching `query` (every term in the name, detail or keywords):
 * name-prefix matches first, then word starts, then the rest. At most `limit`.
 */
export function searchEntities(index: readonly WorldEntity[], query: string, limit = 20): WorldEntity[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return index.slice(0, limit);
  const scored: { e: WorldEntity; score: number; i: number }[] = [];
  index.forEach((e, i) => {
    const name = e.name.toLowerCase();
    const hay = `${name} ${e.detail.toLowerCase()} ${e.keywords.toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) return;
    const first = terms[0]!;
    const score = name.startsWith(first) ? 0 : name.split(/[\s·&-]+/).some((w) => w.startsWith(first)) ? 1 : 2;
    scored.push({ e, score, i });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

/**
 * The directory tree: District › Building or outdoor place › occupants, with
 * residents on the move under the district they are crossing, and each agent
 * in its building. Every resident and agent of the snapshot appears exactly once.
 */
export function directoryTree(snapshot: WorldSnapshot, town: CompiledTown, tick: number): DirectoryNode[] {
  const byPlace = new Map<string, ResidentState[]>();
  const walkingIn = new Map<string, ResidentState[]>();
  const nowhere: ResidentState[] = [];
  for (const r of snapshot.residents) {
    if (r.motion || (r.place.kind === 'outdoor' && !r.place.spotId)) {
      const d = residentDistrict(town, r, tick);
      if (d) (walkingIn.get(d) ?? walkingIn.set(d, []).get(d)!).push(r);
      else nowhere.push(r);
      continue;
    }
    const id = r.place.kind === 'building' ? r.place.buildingId : r.place.spotId!;
    (byPlace.get(id) ?? byPlace.set(id, []).get(id)!).push(r);
  }
  const residentNode = (r: ResidentState): DirectoryNode => ({
    key: `resident:${r.id}`,
    ref: { kind: 'resident', id: r.id },
    name: r.name,
    detail: `${roleLabel(town, r.role)} · ${actionLabel(r.action)}`,
    children: [],
  });
  const byName = (a: ResidentState, b: ResidentState) => a.name.localeCompare(b.name);
  const occupantsOf = (id: string) => (byPlace.get(id) ?? []).sort(byName).map(residentNode);

  const tree: DirectoryNode[] = town.def.districts.map((d) => {
    const children: DirectoryNode[] = [];
    for (const a of snapshot.agents) {
      if (districtOf(town, a.buildingId) !== d.id) continue;
      children.push({ key: `agent:${a.agentId}`, ref: { kind: 'agent', id: a.agentId }, name: a.displayName, detail: `Agent · Claude Code · ${a.health.replace(/_/g, ' ')}`, children: [] });
    }
    for (const b of town.buildings) {
      if (districtOf(town, b.def.id) !== d.id) continue;
      const occ = occupantsOf(b.def.id);
      children.push({ key: `building:${b.def.id}`, ref: { kind: 'building', id: b.def.id }, name: b.def.name, detail: `${archetypeLabel(b.def.archetype)} · ${occ.length} inside`, children: occ });
    }
    for (const s of town.spots) {
      if (s.def.districtId !== d.id) continue;
      const occ = occupantsOf(s.def.id);
      children.push({ key: `spot:${s.def.id}`, ref: { kind: 'spot', id: s.def.id }, name: s.def.label, detail: `Outdoors · ${occ.length} here`, children: occ });
    }
    const walking = (walkingIn.get(d.id) ?? []).sort(byName).map(residentNode);
    if (walking.length) {
      children.push({ key: `walking:${d.id}`, ref: null, name: 'On the move', detail: `${walking.length} walking`, children: walking });
    }
    return { key: `district:${d.id}`, ref: { kind: 'district', id: d.id }, name: d.label, detail: d.kind, children };
  });
  if (nowhere.length) {
    tree.push({ key: 'walking:streets', ref: null, name: 'Streets', detail: `${nowhere.length} walking`, children: nowhere.sort(byName).map(residentNode) });
  }
  return tree;
}

/** Every entity ref in a tree (depth first), as "kind:id" strings (groups are skipped). */
export function treeRefs(nodes: readonly DirectoryNode[]): string[] {
  const out: string[] = [];
  const walk = (n: DirectoryNode) => {
    if (n.ref) out.push(formatEntityRef(n.ref));
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
