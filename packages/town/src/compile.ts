/**
 * compileTown: validate a town and its interiors (every problem at once, like
 * world-engine's compileWorld) and build the lookup tables the sim and Studio
 * share: the ground raster, outdoor walkability, buildings with their slots,
 * spots, lots and districts per cell.
 */
import { townContentHash } from './hash';
import { GROUND, inRect, isWalkableGround, paintGround, rectCells, type TownRaster } from './raster';
import {
  TOWN_ACTIONS,
  parseInteriorDefinition,
  parseTownDefinition,
  type Building,
  type Cell,
  type GridInterior,
  type InteriorDefinition,
  type Lot,
  type Spot,
  type TownDefinition,
} from './schema';
import { DAY_MINUTES, minuteOf, spanOf, type Span } from './time';

/** One place a resident can be: a furniture use on one floor, or one outdoor spot cell. */
export interface TownSlot {
  /** `<furnitureId>#<use>@<floor>` in a building, `<spotId>#<i>` outdoors. */
  id: string;
  /** Furniture tags (actions and role tags), or the spot's tags. */
  tags: readonly string[];
  floor: number;
  pose: 'sit' | 'stand' | 'sleep';
  /** The interior cell of the use (as authored), or the spot's town cell. */
  cell: Cell;
}

export interface CompiledBuilding {
  def: Building;
  /** Position in `def.buildings`. */
  idx: number;
  /** Town cell index (y·width + x) of the door. */
  doorIndex: number;
  /** Opening hours in minutes of day; null = always open. */
  hours: Span | null;
  /** Every slot on every floor, in furniture, use, floor order. */
  slots: readonly TownSlot[];
  /** A home: only the people who live there go in. */
  isHome: boolean;
}

export interface CompiledSpot {
  def: Spot;
  idx: number;
  hours: Span | null;
  /** One slot per cell, `<spotId>#<i>`. */
  slots: readonly TownSlot[];
  /** Town cell index of each slot. */
  cellIndex: readonly number[];
}

/** A validated town with lookup tables. Built once; treat as read-only. */
export interface CompiledTown {
  def: TownDefinition;
  interiors: Readonly<Record<string, InteriorDefinition>>;
  contentHash: string;
  width: number;
  height: number;
  raster: TownRaster;
  /** 1 where residents may walk outdoors; agent lots are never walkable (P6). */
  walkable: Uint8Array;
  buildings: readonly CompiledBuilding[];
  buildingById: ReadonlyMap<string, CompiledBuilding>;
  spots: readonly CompiledSpot[];
  spotById: ReadonlyMap<string, CompiledSpot>;
  lotById: ReadonlyMap<string, Lot>;
  agentLots: readonly Lot[];
  /** Index into def.districts per cell (-1 = none). */
  districtAt: Int16Array;
  /** Building whose door is at a cell index. */
  doorAt: ReadonlyMap<number, string>;
  /** Outdoor slot at a cell index. */
  spotSlotAt: ReadonlyMap<number, { spotId: string; slot: number }>;
  /** Front-walk path cells of each building. */
  walks: ReadonlyMap<string, readonly Cell[]>;
}

export class TownCompileError extends Error {
  constructor(
    readonly townId: string,
    readonly problems: readonly string[],
  ) {
    super(`Invalid town "${townId}": ${problems.join('; ')}`);
  }
}

const ACTIONS: ReadonlySet<string> = new Set(TOWN_ACTIONS);
const DIRS: readonly Cell[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Slots of a grid interior on `floors` floors: furniture order, then use, then floor. */
export function interiorSlots(interior: GridInterior, floors: number): TownSlot[] {
  const out: TownSlot[] = [];
  for (const f of interior.furniture) {
    f.uses.forEach((u, i) => {
      for (let floor = 0; floor < floors; floor++) {
        out.push({ id: `${f.id}#${i}@${floor}`, tags: f.tags, floor, pose: u.pose, cell: [u.cell[0], u.cell[1]] });
      }
    });
  }
  return out;
}

function checkInterior(id: string, i: InteriorDefinition, problems: string[]): void {
  if (i.id !== id) problems.push(`interior ${id}: its id is ${i.id}`);
  if (i.kind === 'world') {
    if (i.archetype !== 'agent_hq') problems.push(`interior ${id}: world interiors are for agent headquarters only`);
    return;
  }
  const g = i.grid;
  const h = g.length;
  const w = g[0]!.length;
  if (g.some((r) => r.length !== w)) {
    problems.push(`interior ${id}: rows have different lengths`);
    return;
  }
  const doors: Cell[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = g[y]![x]!;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (edge && !'#wD'.includes(ch)) problems.push(`interior ${id}: edge cell ${x},${y} must be a wall or the door`);
      if (!edge && !'.#'.includes(ch)) problems.push(`interior ${id}: inner cell ${x},${y} must be floor or wall`);
      if (ch === 'D') doors.push([x, y]);
    }
  }
  const door = doors[0];
  if (doors.length !== 1 || !door || door[1] !== h - 1 || door[0] === 0 || door[0] === w - 1) {
    problems.push(`interior ${id}: needs exactly one D on the bottom row, away from the corners`);
    return;
  }
  const covered = new Map<string, string>();
  const ids = new Set<string>();
  for (const f of i.furniture) {
    if (ids.has(f.id)) problems.push(`interior ${id}: furniture id ${f.id} is used twice`);
    ids.add(f.id);
    for (const [x, y] of f.cells) {
      if (g[y]?.[x] !== '.') problems.push(`interior ${id}.${f.id}: cell ${x},${y} is not floor`);
      const k = `${x},${y}`;
      if (covered.has(k)) problems.push(`interior ${id}.${f.id}: cell ${k} overlaps ${covered.get(k)}`);
      covered.set(k, f.id);
    }
    if (f.uses.length && !f.tags.some((t) => ACTIONS.has(t))) problems.push(`interior ${id}.${f.id}: has uses but no action tag`);
  }
  // Floor reachable from the door, walking round furniture.
  const free = (x: number, y: number) => g[y]?.[x] === '.' && !covered.has(`${x},${y}`);
  const seen = new Set<string>([`${door[0]},${door[1]}`]);
  const queue: Cell[] = [door];
  for (let q = 0; q < queue.length; q++) {
    const [x, y] = queue[q]!;
    for (const [dx, dy] of DIRS) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && free(x + dx, y + dy)) {
        seen.add(k);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  const usesAt = new Set<string>();
  for (const f of i.furniture) {
    const own = new Set(f.cells.map(([x, y]) => `${x},${y}`));
    if (!f.cells.some(([x, y]) => DIRS.some(([dx, dy]) => seen.has(`${x + dx},${y + dy}`)))) {
      problems.push(`interior ${id}.${f.id}: cannot be reached from the door`);
    }
    for (const u of f.uses) {
      const k = `${u.cell[0]},${u.cell[1]}`;
      if (usesAt.has(k)) problems.push(`interior ${id}.${f.id}: two uses at ${k}`);
      usesAt.add(k);
      if (own.has(k)) continue;
      if (!seen.has(k)) problems.push(`interior ${id}.${f.id}: use at ${k} is not reachable floor`);
      else if (!f.cells.some(([x, y]) => Math.abs(x - u.cell[0]) + Math.abs(y - u.cell[1]) === 1)) {
        problems.push(`interior ${id}.${f.id}: use at ${k} is not beside the furniture`);
      }
    }
  }
}

/**
 * Validate a town and its interiors, reporting every problem at once:
 * overlaps, unreachable doors and spots, an interior D that is not its
 * building's door, agent lots that do not front a road, duplicate or dangling
 * ids, schedules that do not tile the day, too few beds or work slots.
 */
export function checkTown(def: TownDefinition, interiors: Readonly<Record<string, InteriorDefinition>>): { problems: string[]; compiled: CompiledTown | null } {
  const problems: string[] = [];
  const [width, height] = def.size;
  for (const [id, i] of Object.entries(interiors)) checkInterior(id, i, problems);

  const painted = paintGround(def, interiors);
  problems.push(...painted.problems);
  const { ground } = painted.raster;
  const cellIdx = ([x, y]: Cell) => y * width + x;
  const inBounds = ([x, y]: Cell) => x >= 0 && y >= 0 && x < width && y < height;

  // Ids: unique across every kind, agent lot building ids included.
  const ids = new Map<string, string>();
  const claim = (id: string, kind: string) => {
    if (ids.has(id)) problems.push(`id ${id} is used twice (${ids.get(id)} and ${kind})`);
    ids.set(id, kind);
  };
  for (const kind of ['districts', 'roads', 'crossings', 'areas', 'landmarks', 'lots', 'buildings', 'spots', 'orgs'] as const) {
    for (const o of def[kind]) claim(o.id, kind);
  }
  for (const l of def.lots) if (l.buildingId) claim(l.buildingId, `agent building of ${l.id}`);

  // Districts: in bounds, apart; lots and spots inside their own district.
  const districtAt = new Int16Array(width * height).fill(-1);
  def.districts.forEach((d, di) => {
    for (const r of d.rects) {
      for (const c of rectCells(r)) {
        if (!inBounds(c)) {
          problems.push(`${d.id}: cell ${c} is out of bounds`);
          continue;
        }
        const prev = districtAt[cellIdx(c)]!;
        if (prev >= 0) problems.push(`${d.id}: overlaps ${def.districts[prev]!.id} at ${c}`);
        districtAt[cellIdx(c)] = di;
      }
    }
  });
  const districtIds = new Set(def.districts.map((d) => d.id));
  const districtOf = (c: Cell) => (inBounds(c) ? def.districts[districtAt[cellIdx(c)]!]?.id : undefined);
  for (const l of def.lots) {
    if (!districtIds.has(l.districtId)) problems.push(`${l.id}: unknown district ${l.districtId}`);
    else if (rectCells(l.rect).some((c) => districtOf(c) !== l.districtId)) problems.push(`${l.id}: is not inside ${l.districtId}`);
  }

  // Outdoor walkability for residents: walkable ground outside agent lots (P6).
  const walkable = new Uint8Array(width * height);
  for (let i = 0; i < ground.length; i++) walkable[i] = isWalkableGround(ground[i]!) ? 1 : 0;
  const agentLots = def.lots.filter((l) => l.use === 'agent');
  for (const l of agentLots) {
    for (const c of rectCells(l.rect)) {
      if (!inBounds(c)) continue;
      if (walkable[cellIdx(c)]) problems.push(`${l.id}: walkable cell ${c} inside an agent lot (P6)`);
      walkable[cellIdx(c)] = 0;
    }
  }

  // Reachability: every walkable cell, door and spot cell connects to the first door.
  const seen = new Uint8Array(width * height);
  const first = def.buildings.find((b) => inBounds(b.door))?.door;
  if (first) {
    const queue = [cellIdx(first)];
    seen[queue[0]!] = 1;
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q]!;
      const x = cur % width;
      const y = (cur - x) / width;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (!walkable[n] || seen[n]) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  for (const b of def.buildings) if (inBounds(b.door) && !seen[cellIdx(b.door)]) problems.push(`${b.id}: door ${b.door} cannot be reached on foot`);
  let stranded = 0;
  for (let i = 0; i < walkable.length; i++) if (walkable[i] && !seen[i]) stranded++;
  if (stranded) problems.push(`${stranded} walkable cells cannot be reached from the other doors`);

  // Spots: walkable, reachable, one per cell, outside lots, inside their district.
  const spotSlotAt = new Map<number, { spotId: string; slot: number }>();
  for (const s of def.spots) {
    if (!districtIds.has(s.districtId)) problems.push(`${s.id}: unknown district ${s.districtId}`);
    s.cells.forEach((c, slot) => {
      if (!inBounds(c)) {
        problems.push(`${s.id}: cell ${c} is out of bounds`);
        return;
      }
      const i = cellIdx(c);
      if (!walkable[i]) problems.push(`${s.id}: cell ${c} is not walkable`);
      else if (!seen[i]) problems.push(`${s.id}: cell ${c} cannot be reached`);
      if (spotSlotAt.has(i)) problems.push(`${s.id}: cell ${c} already belongs to ${spotSlotAt.get(i)!.spotId}`);
      if (def.lots.some((l) => inRect(c, l.rect))) problems.push(`${s.id}: cell ${c} is inside a lot`);
      if (districtIds.has(s.districtId) && districtOf(c) !== s.districtId) problems.push(`${s.id}: cell ${c} is not inside ${s.districtId}`);
      spotSlotAt.set(i, { spotId: s.id, slot });
    });
  }

  // Agent lots: sized for the agent HQ and fronting a road (sidewalk, then asphalt).
  const hq = interiors[def.agentHq.interior];
  if (!hq) problems.push(`agentHq: unknown interior ${def.agentHq.interior}`);
  else if (hq.kind !== 'world') problems.push(`agentHq: interior ${hq.id} is not a world interior`);
  for (const l of agentLots) {
    const [x, y, w, h] = l.rect;
    if (hq?.kind === 'world' && (w !== hq.size[0] || h !== hq.size[1])) problems.push(`${l.id}: is ${w}×${h}, the agent HQ needs ${hq.size[0]}×${hq.size[1]}`);
    const edge: Cell[] =
      l.frontage === 'n'
        ? rectCells([x, y - 1, w, 1])
        : l.frontage === 's'
          ? rectCells([x, y + h, w, 1])
          : l.frontage === 'w'
            ? rectCells([x - 1, y, 1, h])
            : rectCells([x + w, y, 1, h]);
    const [dx, dy] = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[l.frontage] as Cell;
    const fronts = edge.every((c) => inBounds(c) && ground[cellIdx(c)] === GROUND.sidewalk && inBounds([c[0] + dx, c[1] + dy]) && painted.road[cellIdx([c[0] + dx, c[1] + dy])] === 1);
    if (!fronts) problems.push(`${l.id}: does not front a road (its ${l.frontage} side needs a sidewalk, then the road)`);
  }

  // References.
  const orgIds = new Set(def.orgs.map((o) => o.id));
  if (!orgIds.has('org_home')) problems.push('orgs: org_home (the user’s organisation) is missing');
  const buildingIds = new Set(def.buildings.map((b) => b.id));
  for (const b of def.buildings) {
    if (b.orgId && !orgIds.has(b.orgId)) problems.push(`${b.id}: unknown org ${b.orgId}`);
    if ((b.access === 'residents') !== (b.orgId === null)) problems.push(`${b.id}: homes, and only homes, have no org`);
  }
  const scheduleIds = new Set(def.schedules.map((s) => s.id));
  for (const r of def.roles) {
    if (!scheduleIds.has(r.schedule)) problems.push(`role ${r.id}: unknown schedule ${r.schedule}`);
    for (const id of r.work?.buildings ?? []) if (!buildingIds.has(id)) problems.push(`role ${r.id}: unknown building ${id}`);
  }
  for (const rule of def.decoration.rules) if (rule.district && !districtIds.has(rule.district)) problems.push(`decoration: unknown district ${rule.district}`);
  for (const f of def.decoration.fixed) if (!inBounds(f.cell)) problems.push(`decoration: ${f.kind} at ${f.cell} is out of bounds`);

  // Schedules tile the day.
  for (const s of def.schedules) {
    let total = 0;
    const blockIds = new Set<string>();
    s.blocks.forEach((b, i) => {
      if (blockIds.has(b.id)) problems.push(`schedule ${s.id}: block ${b.id} appears twice`);
      blockIds.add(b.id);
      const next = s.blocks[(i + 1) % s.blocks.length]!;
      if (b.to !== next.from) problems.push(`schedule ${s.id}: ${b.id} ends at ${b.to} but ${next.id} starts at ${next.from}`);
      total += (minuteOf(b.to) - minuteOf(b.from) + DAY_MINUTES) % DAY_MINUTES;
    });
    if (total !== DAY_MINUTES) problems.push(`schedule ${s.id}: covers ${total} minutes, not a whole day`);
  }
  for (const a of TOWN_ACTIONS) {
    const [lo, hi] = def.weights.durations[a];
    if (lo > hi) problems.push(`weights.durations.${a}: ${lo} > ${hi}`);
  }

  // Buildings and their slots.
  const buildings: CompiledBuilding[] = def.buildings.map((b, idx) => {
    const interior = interiors[b.interior];
    return {
      def: b,
      idx,
      doorIndex: inBounds(b.door) ? cellIdx(b.door) : -1,
      hours: spanOf(b.hours),
      slots: interior?.kind === 'grid' ? interiorSlots(interior, b.floors) : [],
      isHome: b.access === 'residents',
    };
  });
  const tagged = (b: CompiledBuilding, ...tags: string[]) => b.slots.filter((s) => tags.every((t) => s.tags.includes(t))).length;
  const beds = buildings.filter((b) => b.isHome).reduce((n, b) => n + tagged(b, 'sleep'), 0);
  if (def.population.max > beds) problems.push(`population.max ${def.population.max} exceeds the ${beds} beds in homes`);
  if (def.population.default > def.population.max) problems.push(`population.default ${def.population.default} exceeds population.max`);
  const shares = def.roles.reduce((n, r) => n + r.share, 0);
  if (shares <= 0) problems.push('roles: shares add up to 0');
  for (const r of def.roles) {
    if (!r.work) continue;
    const tag = r.work.tag ?? 'work';
    const slots = r.work.buildings.reduce((n, id) => {
      const b = buildings.find((x) => x.def.id === id);
      return n + (b ? tagged(b, 'work', tag) : 0);
    }, 0);
    const demand = shares > 0 ? Math.ceil((def.population.max * r.share) / shares) : 0;
    if (slots < demand) problems.push(`role ${r.id}: ${slots} work slots for up to ${demand} workers`);
  }

  if (problems.length) return { problems, compiled: null };

  const doorAt = new Map<number, string>();
  for (const b of buildings) doorAt.set(b.doorIndex, b.def.id);
  const spots: CompiledSpot[] = def.spots.map((s, idx) => ({
    def: s,
    idx,
    hours: spanOf(s.hours ?? null),
    slots: s.cells.map((c, i) => ({ id: `${s.id}#${i}`, tags: s.tags, floor: 0, pose: s.pose, cell: [c[0], c[1]] as Cell })),
    cellIndex: s.cells.map(cellIdx),
  }));
  return {
    problems,
    compiled: {
      def,
      interiors,
      contentHash: townContentHash(def, interiors),
      width,
      height,
      raster: painted.raster,
      walkable,
      buildings,
      buildingById: new Map(buildings.map((b) => [b.def.id, b])),
      spots,
      spotById: new Map(spots.map((s) => [s.def.id, s])),
      lotById: new Map(def.lots.map((l) => [l.id, l])),
      agentLots,
      districtAt,
      doorAt,
      spotSlotAt,
      walks: painted.walks,
    },
  };
}

/** Validate and compile; throws TownCompileError listing every problem. */
export function compileTown(def: TownDefinition, interiors: Readonly<Record<string, InteriorDefinition>>): CompiledTown {
  const { problems, compiled } = checkTown(def, interiors);
  if (!compiled) throw new TownCompileError(def.id, problems);
  return compiled;
}

/**
 * Parse and compile raw JSON (the town file and interior files). The content
 * hash is taken over the raw JSON, exactly as stored.
 */
export function loadTown(rawTown: unknown, rawInteriors: Readonly<Record<string, unknown>>): CompiledTown {
  const def = parseTownDefinition(rawTown);
  const interiors: Record<string, InteriorDefinition> = {};
  for (const id of Object.keys(rawInteriors).sort()) interiors[id] = parseInteriorDefinition(rawInteriors[id]);
  const compiled = compileTown(def, interiors);
  return { ...compiled, contentHash: townContentHash(rawTown, rawInteriors) };
}
