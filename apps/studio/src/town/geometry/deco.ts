/**
 * Trees, street props, landmarks, outdoor seating, fences and the reserved
 * agent lots, merged into static meshes. Decoration comes from the town's
 * `decorate(town, seed)` (deterministic); seats are drawn under each outdoor
 * spot cell people sit at, behind where they sit, so walkers pass in front.
 */
import { decorate, type CompiledTown, type DecorationItem } from '@runloop-world/town';
import { Vector3 } from 'three';
import { mixHex, scaleHex } from '../color';
import { cellY, sceneX, sceneZ, yawOf } from '../coords';
import type { TownPlaces } from '../place';
import { BODY } from '../rig/residentRig';
import { AGENT_HQ_COLORS, DECO_COLORS as D, GROUND_COLORS as G, LANDMARK_COLORS as LM } from '../townPalette';
import { GLOW_KIND, GeoBuilder, type Meta } from './builder';
import { exitKey, noise2 } from './ground';

/** Height of the clock face centre on the clock tower (the hands are drawn by ClockHands). */
export const CLOCK = { faceY: 4.15, faceR: 0.55, halfWidth: 0.8 } as const;

/** `exits`: cells the roads out cross (exitKey); nothing stands on them. */
export function buildDecoration(town: CompiledTown, places: TownPlaces, seed: number, exits: ReadonlyMap<number, number> = new Map()): GeoBuilder {
  const gb = new GeoBuilder();
  const items = decorate(town, seed).filter((it) => !exits.has(exitKey(town, it.cell[0], it.cell[1])));
  const patioCells = new Set<number>();
  for (const s of town.spots) if (s.def.kind === 'patio') for (const i of s.cellIndex) patioCells.add(i);
  for (const it of items) {
    // Anchored, so the item can be hidden whole when it stands in front of an open interior.
    gb.anchor = it.cell[1] * town.width + it.cell[0] + 1;
    decoItem(town, gb, it, patioCells);
  }
  gb.anchor = 0;
  for (const lm of town.def.landmarks) landmark(town, gb, lm);
  seats(town, places, gb);
  fences(town, gb);
  agentLots(town, gb);
  return gb;
}

function at(town: CompiledTown, x: number, y: number): { x: number; z: number; y: number } {
  const f = { width: town.width, height: town.height };
  return { x: sceneX(f, x), z: sceneZ(f, y), y: cellY(town, x, y) };
}

function decoItem(town: CompiledTown, gb: GeoBuilder, it: DecorationItem, patio: ReadonlySet<number>): void {
  const [cx, cy] = it.cell;
  let { x, z, y } = at(town, cx, cy);
  const n = noise2(cx, cy, 11);
  const n2 = noise2(cx, cy, 12);
  const yaw = (it.yaw * Math.PI) / 180;
  // Optional rank: foliage goes first at low quality; street furniture always stays.
  const opt: Meta = { opt: 0.02 + 0.98 * n };
  const leaf = [D.leafA, D.leafB, D.leafC][Math.floor(n2 * 3)]!;
  // Jitter inside the cell so rows of trees do not look planted by a grid.
  const jx = (n - 0.5) * 0.3;
  const jz = (n2 - 0.5) * 0.3;
  switch (it.kind) {
    case 'tree_round': {
      const s = 0.85 + 0.35 * n;
      gb.cylinder(x + jx, y, z + jz, 0.09 * s, 0.8 * s, D.trunk, 6, 0.8, opt);
      gb.blob(x + jx, y + 1.25 * s, z + jz, 0.62 * s, 0.56 * s, 0.62 * s, leaf, 1, opt, n * 6);
      gb.blob(x + jx + 0.22 * s, y + 1.55 * s, z + jz - 0.12 * s, 0.42 * s, 0.38 * s, 0.42 * s, scaleHex(leaf, 1.08), 0, opt, n2 * 6);
      gb.blob(x + jx - 0.25 * s, y + 1.05 * s, z + jz + 0.15 * s, 0.4 * s, 0.34 * s, 0.4 * s, scaleHex(leaf, 0.93), 0, opt);
      return;
    }
    case 'tree_cone': {
      const s = 0.8 + 0.45 * n;
      const c = n2 < 0.5 ? D.coneA : D.coneB;
      gb.cylinder(x + jx, y, z + jz, 0.08 * s, 0.45 * s, D.trunk, 6, 0.8, opt);
      gb.cylinder(x + jx, y + 0.3 * s, z + jz, 0.62 * s, 0.95 * s, c, 7, 0.0, opt, n * 3);
      gb.cylinder(x + jx, y + 0.85 * s, z + jz, 0.5 * s, 0.85 * s, scaleHex(c, 1.06), 7, 0.0, opt, n2 * 3);
      gb.cylinder(x + jx, y + 1.35 * s, z + jz, 0.36 * s, 0.75 * s, scaleHex(c, 1.12), 7, 0.0, opt);
      return;
    }
    case 'tree_blossom': {
      const s = 0.8 + 0.3 * n;
      const c = n2 < 0.5 ? D.blossomA : D.blossomB;
      gb.cylinder(x + jx, y, z + jz, 0.08 * s, 0.7 * s, D.trunk, 6, 0.8, opt);
      gb.blob(x + jx, y + 1.1 * s, z + jz, 0.58 * s, 0.5 * s, 0.58 * s, c, 1, opt, n * 6);
      gb.blob(x + jx + 0.2 * s, y + 1.35 * s, z + jz + 0.1 * s, 0.38 * s, 0.32 * s, 0.38 * s, scaleHex(c, 1.05), 0, opt);
      return;
    }
    case 'bush': {
      const c = n < 0.5 ? D.bush : D.bushDark;
      gb.blob(x + jx, y + 0.22, z + jz, 0.36, 0.28, 0.36, c, 0, opt, n * 5);
      gb.blob(x + jx + 0.22, y + 0.18, z + jz + 0.1, 0.24, 0.2, 0.24, scaleHex(c, 1.08), 0, opt);
      return;
    }
    case 'flowerbed': {
      gb.box(x, y, z, 0.8, 0.1, 0.8, mixHex(G.gardenSoil, G.gardenRow, 0.3), opt);
      const cols = [D.flowerRed, D.flowerGold, D.flowerViolet, D.flowerWhite];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + n * 3;
        gb.blob(x + Math.cos(a) * 0.24, y + 0.16, z + Math.sin(a) * 0.24, 0.1, 0.08, 0.1, cols[(i + Math.floor(n2 * 4)) % 4]!, 0, opt);
      }
      gb.blob(x, y + 0.14, z, 0.16, 0.12, 0.16, D.bush, 0, opt);
      return;
    }
    case 'lamp': {
      gb.cylinder(x, y, z, 0.07, 0.12, D.lampPost, 6);
      gb.cylinder(x, y, z, 0.035, 1.85, D.lampPost, 6);
      gb.box(x, y + 1.82, z, 0.26, 0.05, 0.26, D.lampPost);
      gb.box(x, y + 1.6, z, 0.18, 0.24, 0.18, D.lampHead, { glow: GLOW_KIND.lamp });
      gb.cylinder(x, y + 1.86, z, 0.12, 0.1, D.lampPost, 4, 0.2);
      return;
    }
    case 'planter': {
      gb.box(x, y, z, 0.72, 0.42, 0.72, D.planter);
      gb.box(x, y + 0.42, z, 0.78, 0.06, 0.78, scaleHex(D.planter, 0.9));
      gb.blob(x, y + 0.62, z, 0.36, 0.3, 0.36, n < 0.5 ? D.bush : D.leafC, 0, opt, n * 4);
      if (n2 > 0.5) for (let i = 0; i < 3; i++) gb.blob(x + (i - 1) * 0.18, y + 0.8, z + 0.12, 0.07, 0.06, 0.07, i % 2 ? D.flowerRed : D.flowerGold, 0, opt);
      return;
    }
    case 'hydrant':
      gb.cylinder(x, y, z, 0.11, 0.36, D.hydrant, 8);
      gb.blob(x, y + 0.38, z, 0.11, 0.08, 0.11, D.hydrant);
      gb.box(x, y + 0.2, z, 0.32, 0.08, 0.08, scaleHex(D.hydrant, 0.85), {}, yaw);
      return;
    case 'bike_rack':
      // Three hoops (two legs and a top bar each).
      for (let i = -1; i <= 1; i++) {
        const ox = Math.cos(yaw) * i * 0.28;
        const oz = -Math.sin(yaw) * i * 0.28;
        for (const s of [-0.2, 0.2]) gb.box(x + ox - Math.sin(yaw) * s, y, z + oz - Math.cos(yaw) * s, 0.04, 0.4, 0.04, D.bikeRack, {}, yaw);
        gb.box(x + ox, y + 0.38, z + oz, 0.04, 0.04, 0.44, D.bikeRack, {}, yaw);
      }
      return;
    case 'mailbox':
      gb.box(x, y, z, 0.07, 0.6, 0.07, D.lampPost);
      gb.box(x, y + 0.6, z, 0.3, 0.3, 0.42, D.mailbox, {}, yaw);
      gb.cylinder(x, y + 0.86, z, 0.15, 0.08, D.mailbox, 8, 1, {}, yaw);
      return;
    case 'parasol': {
      // On a café patio the parasol stands at the table between two seats.
      if (patio.has(cy * town.width + cx)) {
        x += cx % 2 === 0 ? 0.5 : -0.5;
        z += 0.5;
      }
      gb.cylinder(x, y, z, 0.25, 0.04, D.lampPost, 10);
      gb.cylinder(x, y + 0.04, z, 0.025, 1.6, D.lampPost, 5);
      gb.cylinder(x, y + 1.35, z, 0.85, 0.32, D.parasolCloth, 8, 0.06, opt);
      gb.cylinder(x, y + 1.33, z, 0.86, 0.06, '#c2674a', 8, 1, opt);
      return;
    }
    case 'crate':
      gb.box(x, y, z, 0.5, 0.42, 0.5, D.crate, {}, yaw);
      gb.box(x + 0.1, y + 0.42, z - 0.05, 0.36, 0.3, 0.36, scaleHex(D.crate, 0.92), {}, yaw + 0.3);
      return;
    case 'signpost': {
      gb.box(x, y, z, 0.08, 1.45, 0.08, D.signWood);
      gb.box(x, y + 1.2, z, 0.75, 0.16, 0.04, D.signPlate, {}, yaw + 0.2);
      gb.box(x, y + 0.98, z, 0.7, 0.16, 0.04, D.signPlate, {}, yaw - 0.35);
      return;
    }
    case 'reeds':
      for (let i = 0; i < 5; i++) {
        const a = i * 1.7 + n * 6;
        gb.box(x + Math.cos(a) * 0.2, y + 0.04, z + Math.sin(a) * 0.2, 0.04, 0.35 + 0.25 * noise2(cx + i, cy, 4), 0.04, D.reeds, opt, a);
      }
      return;
  }
}

function landmark(town: CompiledTown, gb: GeoBuilder, lm: CompiledTown['def']['landmarks'][number]): void {
  const [lx, ly, lw, lh] = lm.rect;
  const c = at(town, lx + (lw - 1) / 2, ly + (lh - 1) / 2);
  const y = 0.1;
  switch (lm.kind) {
    case 'clock_tower': {
      gb.box(c.x, y, c.z, 1.9, 0.3, 1.9, LM.stoneDark);
      gb.box(c.x, y + 0.3, c.z, 1.55, 3.2, 1.55, LM.stone);
      gb.box(c.x, y + 3.5, c.z, 1.75, 0.18, 1.75, LM.stoneDark);
      gb.box(c.x, y + 3.68, c.z, 1.6, 1.0, 1.6, LM.stone);
      // Clock faces on all four sides (hands are drawn by ClockHands).
      for (const [dx, dz] of [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ] as const) {
        const fw = CLOCK.faceR * 2;
        gb.box(c.x + dx * (CLOCK.halfWidth - 0.01), y + CLOCK.faceY - fw / 2 - 0.08, c.z + dz * (CLOCK.halfWidth - 0.01), dx ? 0.04 : fw + 0.16, fw + 0.16, dz ? 0.04 : fw + 0.16, LM.stoneDark);
        gb.box(c.x + dx * CLOCK.halfWidth, y + CLOCK.faceY - fw / 2, c.z + dz * CLOCK.halfWidth, dx ? 0.04 : fw, fw, dz ? 0.04 : fw, LM.clockFace);
      }
      gb.box(c.x, y + 4.68, c.z, 1.8, 0.14, 1.8, LM.stoneDark);
      gb.hip(c.x, y + 4.82, c.z, 1.9, 1.9, 1.5, LM.roofSlate);
      gb.cylinder(c.x, y + 6.3, c.z, 0.03, 0.5, '#8a8f98', 5);
      // Arched openings on the shaft.
      for (const [dx, dz] of [
        [0, 1],
        [1, 0],
      ] as const) {
        gb.box(c.x + dx * 0.78, y + 1.2, c.z + dz * 0.78, dx ? 0.04 : 0.5, 1.1, dz ? 0.04 : 0.5, scaleHex(LM.stone, 0.75));
      }
      return;
    }
    case 'fountain': {
      const w = lw - 0.2;
      const d = lh - 0.2;
      // Basin walls round a pool, a capstone rim, then the tiered bowl in the middle.
      const t = 0.32;
      gb.box(c.x, y, c.z, w - 0.2, 0.3, d - 0.2, LM.fountainWater);
      gb.box(c.x, y, c.z + d / 2 - t / 2, w, 0.42, t, LM.stone);
      gb.box(c.x, y, c.z - d / 2 + t / 2, w, 0.42, t, LM.stone);
      gb.box(c.x + w / 2 - t / 2, y, c.z, t, 0.42, d, LM.stone);
      gb.box(c.x - w / 2 + t / 2, y, c.z, t, 0.42, d, LM.stone);
      gb.box(c.x, y + 0.42, c.z + d / 2 - t / 2, w + 0.06, 0.07, t + 0.06, LM.stoneDark);
      gb.box(c.x, y + 0.42, c.z - d / 2 + t / 2, w + 0.06, 0.07, t + 0.06, LM.stoneDark);
      gb.box(c.x + w / 2 - t / 2, y + 0.42, c.z, t + 0.06, 0.07, d + 0.06, LM.stoneDark);
      gb.box(c.x - w / 2 + t / 2, y + 0.42, c.z, t + 0.06, 0.07, d + 0.06, LM.stoneDark);
      gb.cylinder(c.x, y + 0.4, c.z, 0.28, 0.9, LM.stone, 10);
      gb.cylinder(c.x, y + 1.3, c.z, 0.85, 0.16, LM.stoneDark, 12, 0.7);
      gb.cylinder(c.x, y + 1.4, c.z, 0.6, 0.05, LM.fountainWater, 12);
      gb.cylinder(c.x, y + 1.42, c.z, 0.14, 0.5, LM.stone, 8);
      gb.blob(c.x, y + 2.0, c.z, 0.16, 0.22, 0.16, mixHex(LM.fountainWater, '#ffffff', 0.4), 0);
      return;
    }
    case 'signal_board': {
      for (const s of [-1, 1]) gb.box(c.x + s * 0.8, y, c.z, 0.1, 1.9, 0.1, LM.boardFrame);
      gb.box(c.x, y + 0.85, c.z, 1.95, 1.25, 0.14, LM.boardFrame);
      gb.box(c.x, y + 0.93, c.z + 0.04, 1.8, 1.1, 0.1, LM.boardFace);
      // Rows of the feed (unlit by day; it is read in Studio's World Log).
      for (let i = 0; i < 4; i++) gb.box(c.x - 0.15 + (i % 2) * 0.1, y + 1.12 + i * 0.22, c.z + 0.1, 1.3 - (i % 3) * 0.25, 0.06, 0.02, '#6e7a8c');
      gb.box(c.x, y + 2.1, c.z, 2.05, 0.12, 0.3, LM.roofSlate);
      return;
    }
    case 'statue': {
      gb.box(c.x, y, c.z, 1.5, 0.3, 1.5, LM.stoneDark);
      gb.box(c.x, y + 0.3, c.z, 1.1, 0.9, 1.1, LM.stone);
      gb.box(c.x, y + 1.2, c.z, 1.25, 0.1, 1.25, LM.stoneDark);
      // "First Commit": a bronze node on a rising branch.
      gb.cylinder(c.x - 0.15, y + 1.3, c.z, 0.08, 1.1, LM.bronze, 8, 0.7);
      gb.blob(c.x - 0.15, y + 2.55, c.z, 0.34, 0.34, 0.34, LM.bronze, 1);
      gb.cylinder(c.x + 0.25, y + 1.3, c.z + 0.1, 0.06, 0.6, LM.bronze, 8, 0.7);
      gb.blob(c.x + 0.25, y + 2.0, c.z + 0.1, 0.18, 0.18, 0.18, LM.bronze, 1);
      return;
    }
    case 'gazebo': {
      gb.cylinder(c.x, y, c.z, Math.min(lw, lh) / 2, 0.2, LM.stone, 8);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        gb.cylinder(c.x + Math.cos(a) * (lw / 2 - 0.3), y + 0.2, c.z + Math.sin(a) * (lh / 2 - 0.3), 0.06, 1.6, D.fence, 6);
      }
      gb.cylinder(c.x, y + 1.8, c.z, Math.min(lw, lh) / 2 + 0.2, 0.8, LM.roofSlate, 8, 0.05);
      return;
    }
  }
}

/** Benches, ledges, steps and patio chairs under the outdoor spots people sit at, plus the food truck by a stall. */
function seats(town: CompiledTown, places: TownPlaces, gb: GeoBuilder): void {
  const seat = BODY.seatY;
  for (const s of town.spots) {
    s.def.cells.forEach(([cx, cy], i) => {
      const slot = places.spotSlot(`${s.def.id}#${i}`);
      if (!slot) return;
      const p = at(town, cx, cy);
      const yaw = yawOf(slot.dx, slot.dy);
      // Seats sit in the back half of the cell (behind where people sit).
      const bx = p.x - slot.dx * 0.28;
      const bz = p.z - slot.dy * 0.28;
      switch (s.def.kind) {
        case 'bench':
          gb.box(bx, p.y + seat - 0.05, bz, 0.9, 0.05, 0.36, D.bench, {}, yaw);
          gb.box(p.x - slot.dx * 0.44, p.y + seat, p.z - slot.dy * 0.44, 0.9, 0.3, 0.05, D.bench, {}, yaw);
          for (const side of [-0.38, 0.38]) {
            const ox = Math.cos(yaw) * side;
            const oz = -Math.sin(yaw) * side;
            gb.box(bx + ox, p.y, bz + oz, 0.05, seat - 0.05, 0.3, D.benchLeg, {}, yaw);
          }
          return;
        case 'fountain':
        case 'steps':
          gb.box(bx, p.y, bz, 1.0, seat - p.y + 0.02, 0.48, s.def.kind === 'steps' ? LM.stoneDark : LM.stone, {}, yaw);
          return;
        case 'patio':
          gb.box(bx, p.y + seat - 0.05, bz, 0.4, 0.05, 0.36, '#3f4650', {}, yaw);
          gb.box(p.x - slot.dx * 0.44, p.y + seat, p.z - slot.dy * 0.44, 0.4, 0.34, 0.04, '#3f4650', {}, yaw);
          gb.box(bx, p.y, bz, 0.05, seat - 0.05, 0.05, '#3f4650', {}, yaw);
          // The little table between facing seats.
          if (slot.dx > 0) {
            gb.cylinder(p.x + 0.5, p.y, p.z, 0.04, 0.42, '#3f4650', 6);
            gb.cylinder(p.x + 0.5, p.y + 0.42, p.z, 0.26, 0.04, D.fence, 12);
          }
          return;
        case 'stall':
          if (i === 0) foodTruck(town, gb, s.def.cells, slot.dx, slot.dy);
          return;
        default:
          return;
      }
    });
  }
}

/** The food truck a stall's customers face, parked on the first blocked cells in front of them. */
function foodTruck(town: CompiledTown, gb: GeoBuilder, cells: readonly (readonly [number, number])[], dx: number, dy: number): void {
  let r = 1;
  const [x0, y0] = cells[0]!;
  while (r < 4 && town.walkable[(y0 + dy * r) * town.width + x0 + dx * r]) r++;
  const xs = cells.map((c) => c[0] + dx * r);
  const ys = cells.map((c) => c[1] + dy * r);
  const a = at(town, (Math.min(...xs) + Math.max(...xs)) / 2 + dx * 0.3, (Math.min(...ys) + Math.max(...ys)) / 2 + dy * 0.3);
  const len = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) + 0.6;
  const yaw = yawOf(-dx, -dy);
  const body = '#e9c46a';
  gb.box(a.x, 0.25, a.z, len, 1.25, 1.5, mixHex(body, '#f6eedf', 0.35), {}, yaw);
  gb.box(a.x, 1.5, a.z, len + 0.05, 0.12, 1.55, '#c2674a', {}, yaw);
  // Serving hatch with its awning, wheels.
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  gb.box(a.x + fx * 0.76, 0.7, a.z + fz * 0.76, len * 0.6, 0.5, 0.04, '#46566a', { glow: GLOW_KIND.window, bld: 0 }, yaw);
  gb.box(a.x + fx * 0.95, 1.25, a.z + fz * 0.95, len * 0.65, 0.05, 0.45, '#c2674a', {}, yaw);
  for (const s of [-1, 1]) for (const t of [-1, 1]) gb.cylinder(a.x + Math.cos(yaw) * s * (len / 2 - 0.5) + fx * t * 0.62, 0.0, a.z - Math.sin(yaw) * s * (len / 2 - 0.5) + fz * t * 0.62, 0.22, 0.12, '#2f3238', 10);
  gb.box(a.x, 1.62, a.z, 1.6, 0.42, 0.1, '#f6eedf', {}, yaw);
}

/** Low picket fences round the yards of fenced lots, open where the front walk leaves. */
function fences(town: CompiledTown, gb: GeoBuilder): void {
  const f = { width: town.width, height: town.height };
  for (const lot of town.def.lots) {
    if (!lot.fence) continue;
    const [lx, ly, lw, lh] = lot.rect;
    const walk = new Set<string>();
    for (const b of town.def.buildings) if (b.lotId === lot.id) for (const c of town.walks.get(b.id) ?? []) walk.add(`${c[0]},${c[1]}`);
    const edge = (x: number, y: number, side: 'n' | 's' | 'w' | 'e') => {
      if (walk.has(`${x},${y}`)) return;
      const y0 = cellY(town, x, y);
      const cx = sceneX(f, x);
      const cz = sceneZ(f, y);
      const along = side === 'n' || side === 's';
      const ox = side === 'e' ? 0.42 : side === 'w' ? -0.42 : 0;
      const oz = side === 's' ? 0.42 : side === 'n' ? -0.42 : 0;
      gb.box(cx + ox, y0 + 0.2, cz + oz, along ? 1 : 0.04, 0.05, along ? 0.04 : 1, D.fence, { opt: 0.5 });
      gb.box(cx + ox, y0 + 0.36, cz + oz, along ? 1 : 0.04, 0.05, along ? 0.04 : 1, D.fence, { opt: 0.5 });
      for (const t of [-0.25, 0.25]) gb.box(cx + ox + (along ? t : 0), y0, cz + oz + (along ? 0 : t), 0.07, 0.48, 0.07, D.fenceShade, { opt: 0.5 });
    };
    for (let x = lx; x < lx + lw; x++) {
      edge(x, ly, 'n');
      edge(x, ly + lh - 1, 's');
    }
    for (let y = ly; y < ly + lh; y++) {
      edge(lx, y, 'w');
      edge(lx + lw - 1, y, 'e');
    }
  }
}

/** Empty agent lots read as reserved plots: a painted dashed border and corner posts. */
function agentLots(town: CompiledTown, gb: GeoBuilder): void {
  const f = { width: town.width, height: town.height };
  const paint = mixHex(AGENT_HQ_COLORS.pad, '#ffffff', 0.35);
  for (const lot of town.agentLots) {
    const [lx, ly, lw, lh] = lot.rect;
    const y = cellY(town, lx, ly) + 0.006;
    const x0 = sceneX(f, lx) - 0.5 + 0.35;
    const x1 = sceneX(f, lx + lw - 1) + 0.5 - 0.35;
    const z0 = sceneZ(f, ly) - 0.5 + 0.35;
    const z1 = sceneZ(f, ly + lh - 1) + 0.5 - 0.35;
    const dash = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.floor(len / 0.8);
      for (let i = 0; i < n; i++) {
        const t0 = (i * 0.8) / len;
        const t1 = (i * 0.8 + 0.45) / len;
        const p0 = [ax + (bx - ax) * t0, az + (bz - az) * t0] as const;
        const p1 = [ax + (bx - ax) * t1, az + (bz - az) * t1] as const;
        const nx = (az - bz) / len;
        const nz = (bx - ax) / len;
        const w = 0.05;
        gb.quad(
          new Vector3(p0[0] - nx * w, y, p0[1] - nz * w),
          new Vector3(p1[0] - nx * w, y, p1[1] - nz * w),
          new Vector3(p1[0] + nx * w, y, p1[1] + nz * w),
          new Vector3(p0[0] + nx * w, y, p0[1] + nz * w),
          paint,
        );
      }
    };
    dash(x0, z1, x1, z1);
    dash(x1, z1, x1, z0);
    dash(x1, z0, x0, z0);
    dash(x0, z0, x0, z1);
    for (const [px, pz] of [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ] as const) {
      gb.box(px, y, pz, 0.12, 0.5, 0.12, AGENT_HQ_COLORS.pad);
      gb.box(px, y + 0.5, pz, 0.16, 0.06, 0.16, AGENT_HQ_COLORS.shellLight);
    }
  }
}
