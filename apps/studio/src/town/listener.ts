/**
 * What the soundscape hears (contract §4b, TownListener): the camera's place
 * and zoom, the time of day, and the sound sources around it with a gain
 * (nearness) and a stereo pan (left … right of the view). Murmur comes only
 * from simulated occupancy at the town's busy places (café, fountain, atrium,
 * diner, tavern, bakery); no source is ever inside an agent lot.
 */
import type { CompiledTown } from '@runloop-world/town';
import type { WorldSnapshot } from '@runloop-world/events';
import { project, type View } from './cameraMath';
import { gridX, gridY, sceneX, sceneZ } from './coords';
import { polyDist, riverZ, type SurroundLayout } from './geometry/surroundings';
import type { TownLevel, TownListener } from './types';

type Kind = TownListener['sources'][number]['kind'];

/** Busy places whose simulated occupancy murmurs: buildings and outdoor spots, by id. */
const MURMUR_BUILDINGS = ['bld_corner_cafe', 'bld_bluebird_diner', 'bld_lantern_tavern', 'bld_sunrise_bakery'];
const MURMUR_SPOTS = ['spot_cafe_patio', 'spot_fountain_rim', 'spot_clock_square', 'spot_town_hall_steps', 'spot_signal_board'];

interface FixedSource {
  kind: Kind;
  id: string;
  x: number;
  z: number;
  weight: number;
}

/** Sources that never move (computed once per town). */
export function fixedSources(town: CompiledTown, layout: SurroundLayout | null): FixedSource[] {
  const f = { width: town.width, height: town.height };
  const out: FixedSource[] = [];
  const centre = (r: readonly number[]) => ({ x: sceneX(f, r[0]! + (r[2]! - 1) / 2), z: sceneZ(f, r[1]! + (r[3]! - 1) / 2) });
  for (const a of town.def.areas) {
    if (a.kind === 'water') out.push({ kind: 'water', id: a.id, ...centre(a.rect), weight: 0.8 });
    if (a.kind === 'park' || a.kind === 'garden') out.push({ kind: 'green', id: a.id, ...centre(a.rect), weight: 0.7 });
  }
  for (const l of town.def.landmarks) if (l.kind === 'fountain') out.push({ kind: 'water', id: l.id, ...centre(l.rect), weight: 0.6 });
  if (layout) {
    out.push({ kind: 'water', id: 'lake', x: layout.lake.cx, z: layout.lake.cz, weight: 0.9 });
    for (const fl of layout.fields.filter((_, i) => i % 4 === 0)) out.push({ kind: 'field', id: `field_${Math.round(fl.cx)}_${Math.round(fl.cz)}`, x: fl.cx, z: fl.cz, weight: 0.5 });
  }
  return out;
}

export interface ListenerInput {
  town: CompiledTown;
  snapshot: WorldSnapshot | null;
  layout: SurroundLayout | null;
  fixed: FixedSource[];
  view: View;
  fit: number;
  street: number;
  level: TownLevel;
  entered: string | null;
  minute: number;
  night: number;
  paused: boolean;
}

export function computeListener(p: ListenerInput): TownListener {
  const { town, view, snapshot } = p;
  const f = { width: town.width, height: town.height };
  const pose = view.pose;
  const zoom01 = Math.min(1, Math.max(0, Math.log(pose.zoom / p.fit) / Math.log(Math.max(1.01, p.street / p.fit))));
  // How far the listener hears: about half the view's width on the ground.
  const reach = Math.max(14, (view.width / pose.zoom) * 0.6);
  const sources: TownListener['sources'] = [];
  const add = (kind: Kind, id: string, x: number, z: number, weight: number) => {
    const d = Math.hypot(x - pose.x, z - pose.z);
    const g = Math.pow(Math.max(0, 1 - d / reach), 1.5) * weight;
    if (g < 0.02) return;
    const s = project(view, x, 0.5, z);
    let pan = (s.x - view.cx) / (view.width / 2);
    if (s.depth <= 0) pan = Math.sign((x - view.eye[0]) * view.right[0] + (z - view.eye[2]) * view.right[2]);
    sources.push({ kind, id, gain: Math.min(1, g), pan: Math.max(-1, Math.min(1, pan)) });
  };
  for (const s of p.fixed) add(s.kind, s.id, s.x, s.z, s.weight);
  // Murmur: simulated occupancy only.
  if (snapshot) {
    const spotCount = new Map<string, number>();
    for (const r of snapshot.residents) if (r.place.kind === 'outdoor' && r.place.spotId) spotCount.set(r.place.spotId, (spotCount.get(r.place.spotId) ?? 0) + 1);
    for (const id of MURMUR_SPOTS) {
      const s = town.spotById.get(id);
      const n = spotCount.get(id) ?? 0;
      if (!s || n === 0) continue;
      const c = s.def.cells[0]!;
      add('murmur', id, sceneX(f, c[0]), sceneZ(f, c[1]), Math.min(1, n / 6));
    }
    for (const id of MURMUR_BUILDINGS) {
      const b = town.buildingById.get(id);
      const st = b ? snapshot.buildings[b.idx] : undefined;
      if (!b || !st || st.id !== id || st.occupancy === 0) continue;
      const [x, y, w, h] = b.def.footprint;
      add('murmur', id, sceneX(f, x + (w - 1) / 2), sceneZ(f, y + (h - 1) / 2), Math.min(1, st.occupancy / 8) * 0.8);
    }
  }
  // Roads and the Brook: their nearest point to the listener.
  const L = p.layout;
  if (L) {
    if (pose.x > L.river.x0) add('water', 'brook', pose.x, riverZ(L.hz, pose.x), 1);
    let best: { d: number; id: string } | null = null;
    for (const r of L.roads) {
      if (r.kind !== 'road') continue;
      const d = polyDist(pose.x, pose.z, r.pts);
      if (!best || d < best.d) best = { d, id: r.id };
    }
    for (const c of L.cars) {
      const d = polyDist(pose.x, pose.z, c.pts);
      if (!best || d < best.d) best = { d, id: c.id };
    }
    if (best) {
      // Place it along the line from the listener, at its distance.
      const a = Math.atan2(-pose.z, -pose.x);
      add('road', best.id, pose.x + Math.cos(a) * best.d, pose.z + Math.sin(a) * best.d, 0.7);
    }
    add('green', 'forest', pose.x + 0.0001, pose.z - Math.max(0, pose.z + L.hz + 60), 0.6);
  }
  sources.sort((a, b) => b.gain - a.gain);
  sources.length = Math.min(sources.length, 12);
  return {
    x: Math.round(gridX(f, pose.x) * 100) / 100,
    z: Math.round(gridY(f, pose.z) * 100) / 100,
    zoom01,
    az: (((pose.az * 180) / Math.PI) % 360 + 360) % 360,
    level: p.level,
    entered: p.entered,
    minute: p.minute,
    night: p.night,
    paused: p.paused,
    sources,
  };
}
