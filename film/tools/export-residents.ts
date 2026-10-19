/**
 * residents.json: the 80 simulated residents of a new Runloop Commons world, run by the real engine.
 *
 *   npx tsx tools/export-residents.ts [--seed 42] [--from 1680] [--to 2820]
 *
 * The world is made exactly as the runtime makes a new one (createWorld with the town's default
 * population, Day 1 08:00), then stepped tick by tick with the engine's own step() and applyEvent()
 * (what WorldHost does, minus I/O and the wall clock). No input commands: agents never change residents
 * (truth rule P5), and nobody closes a building.
 *
 * Output, per resident, is a list of segments in tick order (a tick is one sim minute):
 *   ['s', t0, action, placeId, gx, gy, inside, floor, pose, reason]  staying at a slot
 *   ['w', t0, action, toPlaceId, fromX, fromY, rle, cells, reason]    walking the engine's route
 * A segment lasts until the next one's t0. A walk is the engine's motion, stored in the engine's own
 * route encoding (events/src/world.ts encodeRoute: from + N/E/S/W run lengths); decodeRoute gives the
 * cells and world-engine positionAt({path, startTick: t0}, tick, 1/walkCellsPerMinute) the position, which
 * is exactly how the Studio draws walkers (town/place.ts). The exporter checks that round trip.
 * Inside buildings residents are hidden in the product (drawn only in the open interior); inside = 1.
 */
import {
  decodeRoute,
  encodeRoute,
  placeId,
  type ResidentState,
  type WorldEvent,
  type WorldEventDraft,
} from '../../packages/events/src/index.ts';
import { interiorSize, interiorToTown, type CompiledTown } from '../../packages/town/src/index.ts';
import { applyEvent, createWorld, step, type SimState } from '../../packages/sim/src/index.ts';
import { positionAt } from '../../packages/world-engine/src/index.ts';
import { DEFAULT_SEED, arg, clockOf, loadCommons, writeJson } from './lib.ts';

const seed = Number(arg('seed', String(DEFAULT_SEED)));
const FROM = Number(arg('from', String(1440 + 4 * 60))); // Day 2 04:00
const TO = Number(arg('to', String(1440 + 23 * 60))); // Day 2 23:00
const { town } = loadCommons();
const W = town.width;
const population = town.def.population.default;

// ---------------------------------------------------------------- run the engine
const events: WorldEvent[] = [];
let state: SimState = null as unknown as SimState;
const tickEvents: WorldEvent[] = [];
const emit = (d: WorldEventDraft): WorldEvent => {
  const e = { ...d, seq: events.length + 1 } as WorldEvent;
  events.push(e);
  tickEvents.push(e);
  state = applyEvent(state ?? null, e, town);
  return e;
};
for (const d of createWorld(town, { worldId: 'film-commons', seed, population })) emit(d);
const world = { town, seed };
const startTick = state.tick;

// ---------------------------------------------------------------- slot positions (as town/place.ts)
function slotPlace(t: CompiledTown, r: ResidentState): { gx: number; gy: number; inside: 0 | 1; floor: number; pose: string } | null {
  if (r.place.kind === 'outdoor') {
    const spot = r.place.spotId ? t.spotById.get(r.place.spotId) : undefined;
    if (!spot || !r.slotId) return null;
    const i = Number(r.slotId.slice(r.slotId.indexOf('#') + 1));
    const c = spot.def.cells[i] ?? spot.def.cells[0]!;
    return { gx: c[0], gy: c[1], inside: 0, floor: 0, pose: spot.def.pose };
  }
  const b = t.buildingById.get(r.place.buildingId)!;
  const interior = t.interiors[b.def.interior];
  if (!interior || interior.kind !== 'grid' || !r.slotId) return { gx: b.def.door[0], gy: b.def.door[1], inside: 1, floor: 0, pose: 'stand' };
  const m = /^([a-z0-9_]+)#(\d+)@(\d+)$/.exec(r.slotId)!;
  const f = interior.furniture.find((x) => x.id === m[1])!;
  const u = f.uses[Number(m[2])]!;
  const [gx, gy] = interiorToTown(u.cell, interiorSize(interior), [b.def.footprint[0], b.def.footprint[1]], b.def.facing);
  return { gx, gy, inside: 1, floor: Number(m[3]), pose: u.pose };
}

// ---------------------------------------------------------------- record segments
type Seg = (string | number)[];
const segs: Seg[][] = state.residents.map(() => []);
const sig: string[] = state.residents.map(() => '');
const lastReason = new Map<number, string>();
const lastDest = new Map<number, string>();
const occupancy: Record<string, [number, number][]> = Object.fromEntries(town.def.buildings.map((b) => [b.id, []]));
const interactions: [number, number, number, string, number][] = [];
let checked = 0;

function record(tick: number): void {
  for (const e of tickEvents) {
    if (e.type === 'resident.decided') lastReason.set(e.p.r, e.p.reason);
    if (e.type === 'resident.departed') lastDest.set(e.p.r, placeId(e.p.dest));
    if (e.type === 'interaction.happened' && tick >= FROM && tick <= TO) interactions.push([tick, e.p.a, e.p.b, e.p.placeId, e.p.dAffinity]);
  }
  tickEvents.length = 0;
  for (const r of state.residents) {
    const key = r.motion
      ? `w|${r.motion.startTick}|${r.motion.path.length}|${r.action}`
      : `s|${r.place.kind === 'building' ? r.place.buildingId : r.place.spotId}|${r.slotId}|${r.action}`;
    if (key === sig[r.idx]) continue;
    sig[r.idx] = key;
    const reason = lastReason.get(r.idx) ?? '';
    if (r.motion) {
      const route = encodeRoute(r.motion.path);
      // Round trip through the engine's decoder and positionAt (the film evaluates walks this way).
      const back = decodeRoute(route);
      if (back.length !== r.motion.path.length || back.some((c, i) => c[0] !== r.motion!.path[i]![0] || c[1] !== r.motion!.path[i]![1])) throw new Error(`route round trip failed for ${r.id}`);
      const end = positionAt({ path: back, startTick: r.motion.startTick }, r.motion.startTick + (back.length - 1) / town.def.walkCellsPerMinute, 1 / town.def.walkCellsPerMinute);
      if (Math.abs(end.x - back.at(-1)![0]) > 1e-9 || Math.abs(end.y - back.at(-1)![1]) > 1e-9) throw new Error(`positionAt end mismatch for ${r.id}`);
      checked++;
      segs[r.idx]!.push(['w', r.motion.startTick, r.action, lastDest.get(r.idx) ?? '', route.from[0], route.from[1], route.rle, back.length, reason]);
    } else {
      const p = slotPlace(town, r);
      const id = r.place.kind === 'building' ? r.place.buildingId : (r.place.spotId ?? '');
      segs[r.idx]!.push(['s', tick, r.action, id, p?.gx ?? -1, p?.gy ?? -1, p?.inside ?? 0, p?.floor ?? 0, p?.pose ?? 'stand', reason]);
    }
  }
  for (const b of state.buildings) {
    const list = occupancy[b.id]!;
    if (!list.length || list.at(-1)![1] !== b.occupancy) list.push([tick, b.occupancy]);
  }
}

record(startTick);
const hourly: Record<string, { walking: number; outdoors: number; inside: number }> = {};
for (let t = startTick + 1; t <= TO; t++) {
  step(state, world, t, [], emit);
  record(t);
  if (t % 60 === 0 && t >= FROM) {
    const walking = state.residents.filter((r) => r.motion).length;
    const outdoors = state.residents.filter((r) => r.place.kind === 'outdoor').length;
    hourly[clockOf(t)] = { walking, outdoors, inside: population - outdoors };
  }
}

// ---------------------------------------------------------------- trim to the window
const trim = <T extends (string | number)[]>(list: T[]): T[] => {
  let first = 0;
  for (let i = 0; i < list.length; i++) if ((list[i]![1] as number) <= FROM) first = i;
  return list.slice(first).filter((s) => (s[1] as number) <= TO);
};
const roster = state.residents.map((r) => ({
  id: r.id,
  idx: r.idx,
  name: r.name,
  role: r.role,
  home: r.homeId,
  work: r.workId,
  traits: r.traits,
  outfit: r.outfit,
  segs: trim(segs[r.idx]!),
}));
// Occupancy entries are [tick, count]: keep the one in force at FROM and every change up to TO.
const trimOcc = (list: [number, number][]) => {
  let first = 0;
  for (let i = 0; i < list.length; i++) if (list[i]![0] <= FROM) first = i;
  return list.slice(first).filter(([t]) => t <= TO);
};
const occ = Object.fromEntries(Object.entries(occupancy).map(([id, list]) => [id, trimOcc(list)]));

// Friendships: affinity at the end of the window, strongest pairs first.
const names = state.residents.map((r) => r.name);
const friendships = Object.entries(state.affinity)
  .map(([k, v]) => {
    const [a, b] = k.split(':').map(Number) as [number, number];
    return [a, b, v] as const;
  })
  .sort((x, y) => y[2] - x[2])
  .slice(0, 60)
  .map(([a, b, v]) => ({ a, b, names: [names[a], names[b]], affinity: v }));

const walks = roster.reduce((n, r) => n + r.segs.filter((s) => s[0] === 'w').length, 0);
const out = {
  provenance: {
    source: 'packages/sim createWorld + step + applyEvent on worlds/runloop-commons (the engine the runtime hosts)',
    exporter: 'film/tools/export-residents.ts',
    contentHash: town.contentHash,
    seed,
    population,
    worldId: 'film-commons',
    events: events.length,
    note: 'A new world starts Day 1 08:00. The runtime draws a random seed per world; re-export with the capture world\'s --seed so the 3-D residents match the captured screens.',
  },
  clock: {
    tick: 'one sim minute; tick 0 = Day 1 00:00; Day d HH:MM = (d-1)*1440 + HH*60 + MM',
    worldStartTick: startTick,
    window: [FROM, TO],
    windowClock: [clockOf(FROM), clockOf(TO)],
    walkCellsPerMinute: town.def.walkCellsPerMinute,
    productSpeeds: 'paused, 1x, 4x, 16x: at 1x one tick per wall second (WorldHost); real agents always run at real speed',
    offline: 'the prototype does not simulate while Runloop is off: it resumes at the same tick and logs world.resumed_after_offline',
  },
  segmentFormat: {
    s: "['s', t0, action, placeId, gx, gy, inside, floor, pose, reason]",
    w: "['w', t0=startTick, action, toPlaceId, fromX, fromY, rle, cells, reason]  position(t) = positionAt({path: decodeRoute({from, rle}), startTick: t0}, t, 1/3)",
    lane: 'the Studio offsets walkers to the right of travel by laneOffset(idx) (town/place.ts) so two-way traffic passes',
  },
  hourly,
  residents: roster,
  occupancy: { rule: 'windows lit when occupancy > 0 (StaticTown.tsx), glowing x night factor', format: '[tick, residents inside] changes', buildings: occ },
  interactions: { format: '[tick, a idx, b idx, placeId, dAffinity]', count: interactions.length, items: interactions },
  friendships,
};
const file = writeJson('residents.json', out);
console.log(`residents.json: seed ${seed}, ${population} residents, window ${clockOf(FROM)} - ${clockOf(TO)}, ${events.length} engine events, ${walks} walks (${checked} routes checked through decodeRoute + positionAt), ${interactions.length} interactions -> ${file}`);
for (const [k, v] of Object.entries(hourly)) console.log(`  ${k}  walking ${String(v.walking).padStart(2)}  outdoors ${String(v.outdoors).padStart(2)}`);
