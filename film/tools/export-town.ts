/**
 * town.json: Runloop Commons as the product compiles and draws it, for the film's 3-D sets.
 *
 *   npx tsx tools/export-town.ts [--seed 42]
 *
 * Everything comes from the repo, read-only:
 * - the town file and its interiors, compiled by @runloop-world/town (compileTown: raster, walks, slots);
 * - trees and props from decorate(town, seed), the Studio's own seeded scatter (the Studio passes the
 *   world's seed, so --seed must be the capture world's seed for the 3-D to match the screen);
 * - the land beyond the town from the Studio's pure surroundLayout(town, seed);
 * - the sky from the Studio's skyAt(minute) (DL-011: the sky follows sim time);
 * - building heights from the Studio's buildingShape; the HQ volumes copied from AgentHq.tsx (a .tsx
 *   React component, so its constants are restated here with the file as their source).
 *
 * Coordinates: grid x = column (east), y = row (south), cell centres integer. Scene (as the Studio):
 * one cell = one unit, x = gx - (W-1)/2, z = gy - (H-1)/2, +y up.
 */
import { GROUND, decorate, interiorSize, rectCells, type CompiledTown } from '../../packages/town/src/index.ts';
import { buildingShape, wallHeight } from '../../apps/studio/src/town/geometry/buildings.ts';
import { STOREY, SURFACE_Y, MARGIN } from '../../apps/studio/src/town/coords.ts';
import { skyAt } from '../../apps/studio/src/town/sky.ts';
import { surroundLayout } from '../../apps/studio/src/town/geometry/surroundings.ts';
import { AGENT_HQ_COLORS, BUILDING_COLORS, DECO_COLORS, GLOW, GROUND_COLORS, LANDMARK_COLORS } from '../../apps/studio/src/town/townPalette.ts';
import { DEFAULT_SEED, arg, loadCommons, round, writeJson } from './lib.ts';

const seed = Number(arg('seed', String(DEFAULT_SEED)));
const { town } = loadCommons();
const { def, width: W, height: H } = town;

/** One character per ground code, row by row (72 strings of 96). */
const CODE_CHARS = '.RSXPpGgWLFDM';
const legend = Object.fromEntries(Object.entries(GROUND).map(([k, v]) => [CODE_CHARS[v], k]));
const rows: string[] = [];
for (let y = 0; y < H; y++) {
  let s = '';
  for (let x = 0; x < W; x++) s += CODE_CHARS[town.raster.ground[y * W + x]!];
  rows.push(s);
}

/** Roof form per archetype, as apps/studio/src/town/geometry/buildings.ts builds it. */
const ROOF: Record<string, { roof: string; note: string }> = {
  house: { roof: 'gable_u', note: 'gabled along the facade, rise 1.25, chimney, porch canopy, shutters and flower boxes' },
  flats: { roof: 'hip', note: 'hip roof rise 1.0, balconies on upper floors' },
  cafe: { roof: 'gable_v', note: 'street gable rise 1.35, striped awning #c2674a' },
  bakery: { roof: 'gable_v', note: 'street gable rise 1.35, striped awning #d9963b, chimney' },
  shop: { roof: 'false_front', note: 'false front over a low gable rise 0.7, awning in roof colour' },
  diner: { roof: 'flat', note: 'flat gravel roof, blue band #4a86b8, awning' },
  tavern: { roof: 'gable_u', note: 'gable rise 1.3, two chimneys, lanterns at the door (lamp glow)' },
  office: { roof: 'flat', note: 'flat roof with parapet and rooftop units, entrance canopy' },
  lab: { roof: 'flat_dome', note: 'flat roof with a white dome and skylights' },
  workshop: { roof: 'sawtooth', note: 'sawtooth roof, glazed faces looking back, tall chimney' },
  greenhouse: { roof: 'glass_gable', note: 'glass walls and gable with white ribs' },
  library: { roof: 'hip_portico', note: 'hip roof rise 1.1, four-column portico with pediment' },
  town_hall: { roof: 'hip_portico_cupola', note: 'hip roof rise 1.5, portico, cupola and flag' },
};

const districtOfCell = (x: number, y: number) => {
  const i = town.districtAt[y * W + x]!;
  return i >= 0 ? def.districts[i]!.id : null;
};

const buildings = town.buildings.map((b) => {
  const d = b.def;
  const shape = buildingShape(b);
  const interior = town.interiors[d.interior];
  const [fx, fy, fw, fh] = d.footprint;
  return {
    id: d.id,
    name: d.name,
    archetype: d.archetype,
    district: districtOfCell(fx, fy),
    lotId: d.lotId,
    footprint: d.footprint,
    facing: d.facing,
    door: d.door,
    floors: d.floors,
    wallHeight: round(wallHeight(d.floors)),
    wallTop: round(shape.wallTop),
    top: round(shape.top),
    ...ROOF[d.archetype],
    palette: d.palette,
    sign: d.sign ?? null,
    access: d.access,
    hours: d.hours,
    orgId: d.orgId,
    isHome: b.isHome,
    beds: b.slots.filter((s) => s.tags.includes('sleep')).length,
    slots: b.slots.length,
    interior: { id: d.interior, size: interior ? interiorSize(interior) : null },
    walk: town.walks.get(d.id) ?? [],
    center: [round(fx + (fw - 1) / 2 - (W - 1) / 2), round(fy + (fh - 1) / 2 - (H - 1) / 2)],
  };
});

// The agent headquarters: AgentHq.tsx (MAIN, UPPER volumes in the lot's local frame: u along the
// frontage, v towards the street, both in cells from the lot centre).
const HQ = {
  source: 'apps/studio/src/town/AgentHq.tsx (buildHq, hqLayout) and status.ts',
  main: { u0: -4.6, u1: 4.6, v0: -3.9, v1: 1.9, h: 2.5 },
  upper: { u0: -2.6, u1: 3.4, v0: -3.6, v1: -0.2, h: 1.35 },
  canopy: { u0: -1.4, u1: 1.4, v0: 1.9, v1: 2.9, y: 1.55 },
  identityBand: { y: 2.18, h: 0.16, note: "the agent's identity hue along the top of the facade" },
  glassFront: 'five 1.4-wide glass panes at y 0.4-1.95 on the street face, a glass door 1.1 wide',
  beacon: { u: 0.4, v: -1.9, y: 4.05, ring: 'torus r 0.42, tube 0.07, lying flat', colours: 'working lime, waiting / needs approval warning, incident failure, idle ice, off #5d626c' },
  robot: { u: 1.35, v: 3.15, note: 'the agent robot on the forecourt, facing the street' },
  states: {
    awaiting_first_event: 'dimmed: an unpainted model (shell #d4d8de, glass #b9c0ca, no vertex colours), beacon at half opacity, 8-sided',
    live: 'painted; glass lit warm (#ffd18a x (0.12 + 0.5 night)); beacon lime while reported working (pulses 0.85-1.0)',
    idle: 'painted; glass lit; beacon ice',
    offline: 'painted; windows dark; beacon off grey',
  },
  colors: AGENT_HQ_COLORS,
  interior: { world: 'research-campus', scale: 0.5, note: 'worlds/runloop-commons/interiors/agent_hq.json: the run diorama at 0.5 scale, exactly one 12x10 lot' },
};

const agentLots = town.agentLots.map((l) => ({
  id: l.id,
  buildingId: l.buildingId,
  rect: l.rect,
  frontage: l.frontage,
  center: [round(l.rect[0] + (l.rect[2] - 1) / 2 - (W - 1) / 2), round(l.rect[1] + (l.rect[3] - 1) / 2 - (H - 1) / 2)],
}));

const deco = decorate(town, seed).map((d) => [d.kind, d.cell[0], d.cell[1], d.yaw] as const);

// Land beyond the town (Studio surroundLayout, the same seed the Studio passes: the world's).
const L = surroundLayout(town, seed);
const R = 260; // the film never shows detail beyond this (haze); trees further out are dropped
const near = (x: number, z: number) => Math.hypot(x, z) <= R;
const land = {
  source: 'apps/studio/src/town/geometry/surroundings.ts surroundLayout(town, seed): decoration, never state',
  halfExtents: [L.hx, L.hz],
  margin: MARGIN,
  roads: L.roads.map((r) => ({ id: r.id, kind: r.kind, width: r.width, lampsTo: r.lampsTo, pts: r.pts.map((p) => [round(p.x, 2), round(p.z, 2)]) })),
  river: L.river,
  lake: L.lake,
  bridges: L.bridges,
  farms: L.farms.map((f) => [round(f.x, 2), round(f.z, 2), round(f.yaw, 3), f.silo ? 1 : 0, f.windmill ? 1 : 0]),
  fields: L.fields.filter((f) => near(f.cx, f.cz)).map((f) => [round(f.cx, 2), round(f.cz, 2), round(f.w, 2), round(f.d, 2), round(f.yaw, 3), round(f.tone, 2), f.orchard ? 1 : 0]),
  trees: L.trees.filter((t) => near(t.x, t.z)).map((t) => [round(t.x, 2), round(t.z, 2), round(t.s, 2), round(t.h, 2), t.tone, round(t.rank, 2)]),
  treesFormat: '[x, z, crownScale, heightScale, tone, rank]',
  fieldsFormat: '[cx, cz, w, d, yaw, tone, orchard]',
  farmsFormat: '[x, z, yaw, silo, windmill]; farm windows are never lit',
  radius: R,
};

// The sky by minute of day, every 10 minutes (the Studio interpolates per minute with smoothstep).
const sky = [];
for (let m = 0; m < 1440; m += 10) {
  const s = skyAt(m);
  sky.push({ m, night: round(s.night), sunDir: s.sunDir.map((v) => round(v)), sun: s.sunColor, sunI: round(s.sunIntensity), amb: s.ambientColor, ambI: round(s.ambient), hemiSky: s.hemiSky, hemiGround: s.hemiGround, hemiI: round(s.hemi), zenith: s.zenith, horizon: s.horizon, haze: s.haze, cloud: s.cloud, stars: round(s.stars) });
}

// The ring road's centre line (Ridge Road, Eastway, Brook Road, Westway): the film draws the logo from it.
const ring = def.roads.filter((r) => r.kind === 'ring');
const rx0 = Math.min(...ring.map((r) => r.rect[0])), ry0 = Math.min(...ring.map((r) => r.rect[1]));
const rx1 = Math.max(...ring.map((r) => r.rect[0] + r.rect[2])), ry1 = Math.max(...ring.map((r) => r.rect[1] + r.rect[3]));
const ringCentre = { gridRect: [rx0 + 0.5, ry0 + 0.5, rx1 - 1.5, ry1 - 1.5], note: 'centre line of the 2-cell ring road as [x0, y0, x1, y1] in grid units (cell centres at integers; the road spans x0-0.5..x0+1.5)' };

const out = {
  provenance: {
    source: 'worlds/runloop-commons (town.json + interiors), compiled by packages/town compileTown',
    exporter: 'film/tools/export-town.ts',
    contentHash: town.contentHash,
    decorationSeed: seed,
    note: 'Geography, buildings, lots and decoration are the product\'s. Re-export with --seed <capture world seed> after the captures.',
  },
  id: def.id,
  name: def.name,
  size: [W, H],
  walkCellsPerMinute: def.walkCellsPerMinute,
  startTime: def.startTime,
  population: def.population,
  frame: { cell: 1, sceneX: 'gx - (W-1)/2', sceneZ: 'gy - (H-1)/2', storey: STOREY, surfaceY: Object.fromEntries(Object.entries(SURFACE_Y).map(([k, v]) => [CODE_CHARS[Number(k)], v])) },
  ground: { legend, rows },
  districts: def.districts.map((d) => ({ id: d.id, label: d.label, kind: d.kind, rects: d.rects, ground: d.ground })),
  roads: def.roads,
  ringRoad: ringCentre,
  crossings: def.crossings,
  areas: def.areas,
  landmarks: def.landmarks,
  lots: def.lots.map((l) => ({ id: l.id, district: l.districtId, rect: l.rect, frontage: l.frontage, use: l.use, fence: l.fence ?? false, buildingId: l.buildingId ?? null })),
  buildings,
  spots: town.spots.map((s) => ({ id: s.def.id, label: s.def.label, kind: s.def.kind, district: s.def.districtId, pose: s.def.pose, cells: s.def.cells, tags: s.def.tags, hours: s.def.hours ?? null })),
  orgs: def.orgs,
  agentLots,
  agentHq: HQ,
  decoration: { format: '[kind, gx, gy, yawDeg]', count: deco.length, kinds: [...new Set(deco.map((d) => d[0]))], items: deco },
  land,
  sky: { source: 'apps/studio/src/town/sky.ts skyAt(minute); keys at 04:30, 05:30, 07:00, 12:00, 17:30, 19:30, 22:00 with smoothstep', every: 10, samples: sky },
  palette: { ground: GROUND_COLORS, deco: DECO_COLORS, landmark: LANDMARK_COLORS, building: BUILDING_COLORS, glow: GLOW },
};

const file = writeJson('town.json', out);
const lamps = deco.filter((d) => d[0] === 'lamp').length;
console.log(`town.json: ${W}x${H}, ${buildings.length} buildings, ${agentLots.length} agent lots, ${def.districts.length} districts, ${deco.length} decoration items (${lamps} lamps), ${land.trees.length} land trees within ${R} -> ${file}`);
