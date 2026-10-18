/**
 * Building shells, built procedurally from the town file (archetype,
 * footprint, facing, floors, palette, sign) into one merged mesh. Windows
 * carry the `window` glow kind and the building index, so the town material
 * lights them at night when the building is occupied (only state glows), and
 * hides a building whose interior is open.
 *
 * Shapes per archetype: gabled houses with shutters and flower boxes; flats
 * with balconies and a hip roof; café and bakery with a street gable and a
 * striped awning; shops with a false front; a diner with a band and big
 * windows; a tavern with lanterns; flat-roofed offices and a lab with a dome;
 * a sawtooth workshop; a glass greenhouse; a library and a town hall with a
 * portico.
 */
import { interiorDoor, type CompiledBuilding, type CompiledTown, type Archetype } from '@runloop-world/town';
import { Quaternion, Vector3 } from 'three';
import { mixHex, scaleHex } from '../color';
import { STOREY } from '../coords';
import { BUILDING_COLORS as B, DECO_COLORS as D } from '../townPalette';
import { GLOW_KIND, GeoBuilder, type Meta } from './builder';
import { LocalFrame, buildingFrame } from './frame';

/** Outer wall faces sit this far inside the footprint edge. */
export const WALL_INSET = 0.2;
/** Ground-floor base (the footprint's surface). */
export const BASE_Y = 0.1;

const SHOPFRONT: ReadonlySet<Archetype> = new Set(['cafe', 'bakery', 'diner', 'shop', 'tavern']);

export interface SignPlacement {
  bld: number;
  text: string;
  hue: string;
  /** Board centre (world). */
  center: Vector3;
  yaw: number;
  w: number;
  h: number;
}

export interface BuildingShape {
  /** Top of the walls. */
  wallTop: number;
  /** Highest point (roof ridge or rooftop details). */
  top: number;
}

/** Wall height of a building (all floors). */
export function wallHeight(floors: number): number {
  return floors * STOREY + 0.15;
}

/** Heights of a building, for labels and camera framing. */
export function buildingShape(b: CompiledBuilding): BuildingShape {
  const wallTop = BASE_Y + wallHeight(b.def.floors);
  const extra: Partial<Record<Archetype, number>> = { house: 1.3, flats: 1.0, cafe: 1.2, bakery: 1.2, tavern: 1.2, library: 1.0, town_hall: 1.6, greenhouse: 1.0, workshop: 0.9, lab: 0.9, shop: 0.5 };
  return { wallTop, top: wallTop + (extra[b.def.archetype] ?? 0.5) };
}

/** Build every town building into `gb`; returns where the sign boards go. */
export function buildBuildings(town: CompiledTown, gb: GeoBuilder): SignPlacement[] {
  const signs: SignPlacement[] = [];
  for (const b of town.buildings) signs.push(...buildBuilding(town, b, gb));
  return signs;
}

function buildBuilding(town: CompiledTown, b: CompiledBuilding, gb: GeoBuilder): SignPlacement[] {
  const def = b.def;
  const f = buildingFrame(town, b);
  const meta: Meta = { bld: b.idx + 1 };
  const glass: Meta = { bld: b.idx + 1, glow: GLOW_KIND.window };
  const pal = def.palette;
  const arch = def.archetype;
  const interior = town.interiors[def.interior];
  const door = interior ? interiorDoor(interior) : null;
  const doorU = door ? f.cellU(door[0]) : 0;
  const hw = f.w / 2 - WALL_INSET;
  const hd = f.d / 2 - WALL_INSET;
  const H = wallHeight(def.floors);
  const top = BASE_Y + H;
  const wall = arch === 'greenhouse' ? B.greenhouseGlass : pal.wall;
  const L = new Local(gb, f);

  // Plinth and walls.
  L.box(0, 0, BASE_Y - 0.04, 2 * hw + 0.12, 0.26, 2 * hd + 0.12, mixHex(B.plinth, pal.wall, 0.25), meta);
  L.box(0, 0, BASE_Y, 2 * hw, H, 2 * hd, wall, arch === 'greenhouse' ? glass : meta);
  // Corner pilasters and floor bands in the trim colour.
  if (arch !== 'greenhouse') {
    for (const su of [-1, 1]) for (const sv of [-1, 1]) L.box(su * (hw - 0.05), sv * (hd - 0.05), BASE_Y, 0.16, H, 0.16, pal.trim, meta);
    for (let k = 1; k < def.floors; k++) L.ring(hw + 0.03, hd + 0.03, BASE_Y + k * STOREY - 0.04, 0.08, pal.trim, meta);
    L.ring(hw + 0.04, hd + 0.04, top - 0.1, 0.12, pal.trim, meta);
  }

  // Windows.
  const shopfront = SHOPFRONT.has(arch);
  for (let floor = 0; floor < def.floors; floor++) {
    const y0 = BASE_Y + floor * STOREY;
    // Front.
    if (floor === 0 && shopfront) {
      // Display windows either side of the door.
      for (const [a, b] of [
        [-hw + 0.4, doorU - 0.6],
        [doorU + 0.6, hw - 0.4],
      ] as const) {
        const len = Math.min(3.2, b - a);
        if (len >= 0.8) L.window('front', (a + b) / 2, y0 + 0.3, len, 0.84, pal.trim, glass, meta, true);
      }
    } else if (arch === 'workshop' && floor === 0) {
      // A big garage door beside the entrance.
      const u = doorU > 0 ? doorU - 2.4 : doorU + 2.4;
      L.face('front', u, y0, 2.4, 1.25, scaleHex(pal.roof, 0.9), meta, 0.03);
      for (let i = 0; i < 5; i++) L.face('front', u, y0 + 0.15 + i * 0.22, 2.3, 0.04, scaleHex(pal.roof, 0.75), meta, 0.045);
    } else {
      for (const u of rowPositions(hw, floor === 0 ? doorU : null, arch)) L.window('front', u, y0 + 0.5, windowW(arch), 0.66, pal.trim, glass, meta, false, arch === 'house' ? pal.roof : null);
    }
    // Back and sides.
    for (const u of rowPositions(hw, null, arch)) L.window('back', u, y0 + 0.5, windowW(arch), 0.66, pal.trim, glass, meta);
    for (const v of rowPositions(hd, null, arch)) {
      L.window('left', v, y0 + 0.5, windowW(arch), 0.66, pal.trim, glass, meta);
      L.window('right', v, y0 + 0.5, windowW(arch), 0.66, pal.trim, glass, meta);
    }
  }

  // The door, its frame and step.
  L.face('front', doorU, BASE_Y - 0.02, 0.86, 1.2, pal.trim, meta, 0.03);
  if (shopfront || arch === 'office' || arch === 'lab' || arch === 'library' || arch === 'town_hall') {
    L.face('front', doorU, BASE_Y + 0.02, 0.62, 1.08, mixHex(B.door, pal.trim, 0.15), meta, 0.05);
    L.face('front', doorU, BASE_Y + 0.5, 0.42, 0.5, B.windowDay, glass, 0.065);
  } else {
    L.face('front', doorU, BASE_Y + 0.02, 0.62, 1.08, B.door, meta, 0.05);
    L.box(doorU + 0.2, hd + 0.075, BASE_Y + 0.55, 0.06, 0.06, 0.04, '#d8b46a', meta);
  }
  L.box(doorU, hd + 0.25, 0.02, 1.0, 0.1, 0.5, B.doorstep, meta);

  // Roof and archetype details.
  const sign = roofAndDetails(L, def.archetype, f, hw, hd, top, pal, meta, glass, doorU, def.floors);

  if (!def.sign) return [];
  const textW = Math.min(2 * hw - 0.6, Math.max(1.6, def.sign.text.length * 0.2 + 0.6));
  const at = sign ?? { u: doorU === 0 ? 0 : Math.max(-hw + textW / 2 + 0.2, Math.min(hw - textW / 2 - 0.2, doorU)), y: BASE_Y + Math.min(def.floors, 1) * STOREY - 0.12, v: hd + 0.07 };
  const out: SignPlacement[] = [{ bld: b.idx + 1, text: def.sign.text, hue: def.sign.hue, center: f.p(at.u, at.y, at.v), yaw: f.yaw, w: textW, h: 0.44 }];
  // A blade sign beside the door, so the name reads from along the street (and from behind the façade's back).
  const bladeU = doorU + (doorU > hw - 1.6 ? -1.0 : 1.0);
  const bladeW = Math.min(1.6, Math.max(1.0, def.sign.text.length * 0.11 + 0.3));
  const bladeY = BASE_Y + 1.5;
  L.box(bladeU, hd + 0.06 + bladeW / 2, bladeY + 0.22, 0.04, 0.04, bladeW + 0.12, '#3f4650', meta);
  for (const side of [1, -1]) {
    out.push({ bld: b.idx + 1, text: def.sign.text, hue: def.sign.hue, center: f.p(bladeU + side * 0.025, bladeY, hd + 0.12 + bladeW / 2), yaw: f.yaw + (side * Math.PI) / 2, w: bladeW, h: 0.32 });
  }
  return out;
}

const windowW = (arch: Archetype) => (arch === 'office' || arch === 'lab' ? 0.86 : arch === 'flats' ? 0.56 : 0.5);

/** Window centres along a wall of half-length `half`, every 1.6 cells, clear of the door and the corners. */
function rowPositions(half: number, doorU: number | null, arch: Archetype): number[] {
  const step = arch === 'office' || arch === 'lab' ? 1.25 : 1.6;
  const n = Math.max(1, Math.floor((2 * half - 0.9) / step));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = -((n - 1) * step) / 2 + i * step;
    if (doorU !== null && Math.abs(u - doorU) < 0.95) continue;
    out.push(u);
  }
  return out;
}

type Side = 'front' | 'back' | 'left' | 'right';

/** Drawing helpers in a building's local frame. */
class Local {
  hw = 0;
  hd = 0;
  constructor(
    readonly gb: GeoBuilder,
    readonly f: LocalFrame,
  ) {}

  box(u: number, v: number, y0: number, su: number, sy: number, sv: number, color: string, meta: Meta, yawOffset = 0): void {
    this.gb.box(this.f.x(u, v), y0, this.f.z(u, v), su, sy, sv, color, meta, this.f.yaw + yawOffset);
  }

  /** A band around the walls at height y. */
  ring(hw: number, hd: number, y: number, h: number, color: string, meta: Meta): void {
    this.box(0, hd - 0.04, y, 2 * hw, h, 0.08, color, meta);
    this.box(0, -hd + 0.04, y, 2 * hw, h, 0.08, color, meta);
    this.box(hw - 0.04, 0, y, 0.08, h, 2 * hd, color, meta);
    this.box(-hw + 0.04, 0, y, 0.08, h, 2 * hd, color, meta);
  }

  private hwhd(): [number, number] {
    return [this.f.w / 2 - WALL_INSET, this.f.d / 2 - WALL_INSET];
  }

  /** A thin box flat on a wall face: `t` along the face, centred at `t`, bottom y0, `out` proud of the wall. */
  face(side: Side, t: number, y0: number, w: number, h: number, color: string, meta: Meta, out = 0.03): void {
    const [hw, hd] = this.hwhd();
    const depth = 2 * out;
    switch (side) {
      case 'front':
        return this.box(t, hd, y0, w, h, depth, color, meta);
      case 'back':
        return this.box(-t, -hd, y0, w, h, depth, color, meta);
      case 'left':
        return this.box(-hw, t, y0, depth, h, w, color, meta);
      case 'right':
        return this.box(hw, -t, y0, depth, h, w, color, meta);
    }
  }

  /** A framed window with a sill (and optional shutters in `shutter` colour). */
  window(side: Side, t: number, y0: number, w: number, h: number, trim: string, glass: Meta, meta: Meta, display = false, shutter: string | null = null): void {
    this.face(side, t, y0 - 0.06, w + 0.14, h + 0.12, trim, meta, 0.035);
    this.face(side, t, y0, w, h, B.windowDay, glass, 0.06);
    if (!display) this.face(side, t, y0 + h / 2 - 0.02, 0.04, h - 0.04, trim, meta, 0.065);
    this.face(side, t, y0 - 0.1, w + 0.22, 0.06, trim, meta, 0.09);
    if (shutter) {
      for (const s of [-1, 1]) this.face(side, t + s * (w / 2 + 0.13), y0, 0.16, h, shutter, meta, 0.05);
      // A flower box under the window.
      this.face(side, t, y0 - 0.22, w + 0.1, 0.12, D.planter, meta, 0.1);
      for (let i = 0; i < 3; i++) this.face(side, t - w / 3 + (i * w) / 3, y0 - 0.1, 0.1, 0.08, i % 2 ? D.flowerRed : D.flowerGold, meta, 0.12);
    }
  }

  /** A triangular prism: profile (v, y) points extruded along u from u0 to u1. */
  prism(u0: number, u1: number, y0: number, profile: [number, number][], color: string, meta: Meta): void {
    const P = (u: number, [v, y]: [number, number]) => this.f.p(u, y0 + y, v);
    const [a, b, c] = profile as [[number, number], [number, number], [number, number]];
    this.gb.tri(P(u1, a), P(u1, b), P(u1, c), color, meta);
    this.gb.tri(P(u0, a), P(u0, c), P(u0, b), color, meta);
    const edges: [[number, number], [number, number]][] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [p, q] of edges) this.gb.quad(P(u0, p), P(u1, p), P(u1, q), P(u0, q), color, meta);
  }
}

/** Roofs and the details that make each archetype read; returns a sign position when the archetype places it. */
function roofAndDetails(
  L: Local,
  arch: Archetype,
  f: LocalFrame,
  hw: number,
  hd: number,
  top: number,
  pal: { wall: string; roof: string; trim: string },
  meta: Meta,
  glass: Meta,
  doorU: number,
  floors: number,
): { u: number; y: number; v: number } | null {
  const gb = L.gb;
  const o = 0.28; // roof overhang
  const alongU = (x: number, z: number, w: number, d: number, rise: number, color: string, gableColor: string) =>
    gb.gable(f.x(x, z), top, f.z(x, z), Math.abs(f.cos) > 0.5 ? w : d, Math.abs(f.cos) > 0.5 ? d : w, rise, color, gableColor, Math.abs(f.cos) > 0.5, meta);
  const alongV = (x: number, z: number, w: number, d: number, rise: number, color: string, gableColor: string) =>
    gb.gable(f.x(x, z), top, f.z(x, z), Math.abs(f.cos) > 0.5 ? w : d, Math.abs(f.cos) > 0.5 ? d : w, rise, color, gableColor, Math.abs(f.cos) <= 0.5, meta);
  const flatRoof = (cap: string) => {
    // A gravel roof behind a capped parapet, with vents and a hatch so it never reads as a blank slab.
    L.box(0, 0, top - 0.02, 2 * hw - 0.1, 0.06, 2 * hd - 0.1, mixHex(pal.wall, '#8f8a82', 0.55), meta);
    L.ring(hw + 0.02, hd + 0.02, top - 0.02, 0.3, cap, meta);
    L.box(-hw * 0.62, hd * 0.45, top + 0.04, 0.5, 0.22, 0.5, '#c9ccd1', meta);
    L.box(-hw * 0.62 + 0.7, hd * 0.45, top + 0.04, 0.5, 0.22, 0.5, '#c9ccd1', meta);
    L.box(hw * 0.55, hd * 0.5, top + 0.04, 0.7, 0.12, 0.6, scaleHex(pal.wall, 0.75), meta);
    gb.cylinder(f.x(-hw * 0.2, -hd * 0.55), top + 0.04, f.z(-hw * 0.2, -hd * 0.55), 0.12, 0.35, '#a7abb2', 8);
  };
  const awning = (hue: string) => {
    const len = Math.min(2 * hw - 0.4, 6.2);
    const stripes = Math.max(4, Math.round(len / 0.36));
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.42);
    const yawQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), f.yaw);
    const rot = yawQ.multiply(q);
    for (let i = 0; i < stripes; i++) {
      const u = -len / 2 + (i + 0.5) * (len / stripes);
      const c = f.p(u, BASE_Y + STOREY - 0.08, hd + 0.34);
      gb.boxRot(c.x, c.y, c.z, len / stripes + 0.005, 0.04, 0.72, rot, i % 2 ? B.awningCream : hue, meta);
      // Scalloped valance.
      L.box(u, hd + 0.68, BASE_Y + STOREY - 0.42, len / stripes - 0.03, 0.14, 0.03, i % 2 ? B.awningCream : hue, meta);
    }
  };

  switch (arch) {
    case 'house': {
      alongU(0, 0, 2 * hw + 2 * o, 2 * hd + 2 * o, 1.25, pal.roof, pal.wall);
      // Chimney and a porch canopy.
      L.box(hw * 0.55, -hd * 0.25, top + 0.2, 0.42, 1.25, 0.42, B.chimney, meta);
      L.box(hw * 0.55, -hd * 0.25, top + 1.42, 0.5, 0.08, 0.5, scaleHex(B.chimney, 0.8), meta);
      L.box(doorU, hd + 0.32, BASE_Y + 1.28, 1.15, 0.08, 0.6, pal.roof, meta);
      return null;
    }
    case 'flats': {
      gb.hip(f.x(0, 0), top, f.z(0, 0), Math.abs(f.cos) > 0.5 ? 2 * hw + 2 * o : 2 * hd + 2 * o, Math.abs(f.cos) > 0.5 ? 2 * hd + 2 * o : 2 * hw + 2 * o, 1.0, pal.roof, meta);
      // Balconies on the upper floors, an entrance canopy, rooftop vents.
      for (let k = 1; k < floors; k++) {
        for (const u of [-hw * 0.55, hw * 0.55]) {
          if (Math.abs(u - doorU) < 1) continue;
          const y = BASE_Y + k * STOREY;
          L.box(u, hd + 0.3, y, 1.5, 0.08, 0.62, pal.trim, meta);
          L.box(u, hd + 0.58, y + 0.08, 1.5, 0.42, 0.05, mixHex(pal.trim, pal.roof, 0.25), meta);
          for (const s of [-1, 1]) L.box(u + s * 0.72, hd + 0.33, y + 0.08, 0.05, 0.42, 0.55, mixHex(pal.trim, pal.roof, 0.25), meta);
          L.box(u - 0.45, hd + 0.4, y + 0.08, 0.18, 0.16, 0.18, D.planter, meta);
          gb.blob(f.x(u - 0.45, hd + 0.4), y + 0.32, f.z(u - 0.45, hd + 0.4), 0.16, 0.14, 0.16, D.bush, 0, meta);
        }
      }
      L.box(doorU, hd + 0.4, BASE_Y + 1.22, 1.4, 0.1, 0.8, pal.roof, meta);
      return null;
    }
    case 'cafe':
    case 'bakery': {
      alongV(0, 0, 2 * hw + 2 * o, 2 * hd + 2 * o, 1.35, pal.roof, pal.wall);
      awning(arch === 'cafe' ? '#c2674a' : '#d9963b');
      if (arch === 'bakery') {
        L.box(-hw * 0.5, -hd * 0.4, top + 0.3, 0.4, 1.3, 0.4, B.chimney, meta);
      }
      // The sign sits on the street gable.
      return { u: 0, y: top + 0.36, v: hd + o + 0.02 };
    }
    case 'shop': {
      // A false front rising above a low gable.
      alongV(0, -0.2, 2 * hw + 0.2, 2 * hd + 0.2, 0.7, pal.roof, pal.wall);
      L.box(0, hd - 0.05, top - 0.05, 2 * hw + 0.1, 0.85, 0.16, pal.wall, meta);
      L.box(0, hd + 0.02, top + 0.78, 2 * hw + 0.3, 0.1, 0.3, pal.trim, meta);
      awning(pal.roof);
      return { u: 0, y: top + 0.36, v: hd + 0.06 };
    }
    case 'diner': {
      flatRoof(pal.trim);
      L.ring(hw + 0.05, hd + 0.05, top - 0.55, 0.22, '#4a86b8', meta);
      awning('#4a86b8');
      L.box(hw * 0.4, -hd * 0.3, top + 0.2, 0.9, 0.35, 0.7, '#b9bec6', meta);
      return { u: 0, y: top + 0.42, v: hd + 0.06 };
    }
    case 'tavern': {
      alongU(0, 0, 2 * hw + 2 * o, 2 * hd + 2 * o, 1.3, pal.roof, pal.wall);
      for (const s of [-1, 1]) L.box(s * hw * 0.7, 0, top + 0.3, 0.44, 1.4, 0.44, B.chimney, meta);
      // Lanterns either side of the door (street lamps: lit from dusk).
      for (const s of [-1, 1]) {
        L.box(doorU + s * 0.62, hd + 0.08, BASE_Y + 1.0, 0.07, 0.07, 0.2, D.lampPost, meta);
        L.box(doorU + s * 0.62, hd + 0.2, BASE_Y + 0.82, 0.16, 0.22, 0.16, D.lampHead, { ...meta, glow: GLOW_KIND.lamp });
      }
      return null;
    }
    case 'office': {
      flatRoof(pal.roof);
      L.box(-hw * 0.4, -hd * 0.2, top + 0.24, 1.2, 0.45, 0.9, '#b9bec6', meta);
      L.box(hw * 0.35, hd * 0.1, top + 0.24, 0.8, 0.35, 0.8, '#aeb4bd', meta);
      L.box(hw * 0.7, -hd * 0.45, top + 0.24, 0.9, 0.8, 0.9, scaleHex(pal.wall, 0.9), meta);
      L.box(doorU, hd + 0.35, BASE_Y + 1.3, 1.6, 0.1, 0.7, pal.roof, meta);
      return { u: 0, y: top + 0.42, v: hd + 0.07 };
    }
    case 'lab': {
      flatRoof(pal.roof);
      gb.blob(f.x(hw * 0.45, -hd * 0.2), top + 0.24, f.z(hw * 0.45, -hd * 0.2), 1.1, 1.0, 1.1, '#f1f0ea', 1, meta);
      L.box(hw * 0.45, -hd * 0.2, top + 0.2, 2.3, 0.12, 2.3, scaleHex(pal.wall, 0.9), meta);
      gb.cylinder(f.x(-hw * 0.6, -hd * 0.4), top + 0.24, f.z(-hw * 0.6, -hd * 0.4), 0.04, 1.6, '#8a8f98', 6);
      for (const u of [-hw * 0.4, -hw * 0.1]) L.box(u, hd * 0.25, top + 0.22, 0.8, 0.18, 0.9, B.windowDay, glass);
      L.box(doorU, hd + 0.35, BASE_Y + 1.3, 1.6, 0.1, 0.7, pal.roof, meta);
      return { u: 0, y: top + 0.42, v: hd + 0.07 };
    }
    case 'workshop': {
      // Sawtooth roof: teeth along the depth, glazed faces looking back.
      const teeth = Math.max(2, Math.round((2 * hd) / 2.2));
      const step = (2 * hd + 0.2) / teeth;
      for (let i = 0; i < teeth; i++) {
        const v0 = -hd - 0.1 + i * step;
        const v1 = v0 + step;
        L.prism(-hw - 0.15, hw + 0.15, top, [[v0, 0], [v1, 0], [v0, 0.95]], pal.roof, meta);
        L.box(0, v0 + 0.02, top, 2 * hw + 0.1, 0.85, 0.04, B.windowDay, glass);
      }
      L.box(hw * 0.75, -hd * 0.5, top, 0.35, 2.2, 0.35, B.chimney, meta);
      return { u: 0, y: BASE_Y + STOREY - 0.05, v: hd + 0.07 };
    }
    case 'greenhouse': {
      alongU(0, 0, 2 * hw + 0.1, 2 * hd + 0.1, 1.0, B.greenhouseGlass, B.greenhouseGlass);
      // White frame ribs over the glass.
      for (let u = -hw; u <= hw + 1e-6; u += 0.6) {
        L.box(u, hd + 0.02, BASE_Y, 0.05, top - BASE_Y, 0.05, pal.trim, meta);
        L.box(u, -hd - 0.02, BASE_Y, 0.05, top - BASE_Y, 0.05, pal.trim, meta);
      }
      for (let v = -hd; v <= hd + 1e-6; v += 0.6) {
        L.box(hw + 0.02, v, BASE_Y, 0.05, top - BASE_Y, 0.05, pal.trim, meta);
        L.box(-hw - 0.02, v, BASE_Y, 0.05, top - BASE_Y, 0.05, pal.trim, meta);
      }
      L.box(0, 0, top + 0.98, 2 * hw + 0.2, 0.06, 0.08, pal.trim, meta);
      return null;
    }
    case 'library':
    case 'town_hall': {
      gb.hip(f.x(0, -0.1), top, f.z(0, -0.1), Math.abs(f.cos) > 0.5 ? 2 * hw + 2 * o : 2 * hd + 2 * o, Math.abs(f.cos) > 0.5 ? 2 * hd + 2 * o : 2 * hw + 2 * o, arch === 'town_hall' ? 1.5 : 1.1, pal.roof, meta);
      // Portico: columns, an entablature and a pediment over the door.
      const pw = 3.2;
      const depth = 1.0;
      for (let i = 0; i < 4; i++) {
        const u = doorU - pw / 2 + (i * pw) / 3;
        gb.cylinder(f.x(u, hd + depth - 0.15), BASE_Y, f.z(u, hd + depth - 0.15), 0.13, top - BASE_Y - 0.6, pal.trim, 10);
      }
      L.box(doorU, hd + depth / 2 - 0.05, top - 0.6, pw + 0.6, 0.32, depth + 0.1, pal.trim, meta);
      L.prism(doorU - pw / 2 - 0.3, doorU + pw / 2 + 0.3, top - 0.28, [[hd - 0.1, 0], [hd + depth + 0.05, 0], [hd + depth / 2, 0.01]], pal.trim, meta);
      gb.gable(f.x(doorU, hd + depth / 2 - 0.05), top - 0.28, f.z(doorU, hd + depth / 2 - 0.05), Math.abs(f.cos) > 0.5 ? pw + 0.7 : depth + 0.2, Math.abs(f.cos) > 0.5 ? depth + 0.2 : pw + 0.7, 0.6, pal.roof, pal.trim, Math.abs(f.cos) <= 0.5, meta);
      L.box(doorU, hd + depth / 2, BASE_Y - 0.06, pw + 0.9, 0.1, depth + 0.5, mixHex(B.doorstep, pal.trim, 0.3), meta);
      if (arch === 'town_hall') {
        // A cupola and a flag.
        L.box(0, -0.4, top + 1.0, 1.1, 1.0, 1.1, pal.trim, meta);
        gb.hip(f.x(0, -0.4), top + 2.0, f.z(0, -0.4), 1.4, 1.4, 0.9, pal.roof, meta);
        gb.cylinder(f.x(0, -0.4), top + 2.8, f.z(0, -0.4), 0.03, 1.1, '#8a8f98', 6);
        L.box(0.28, -0.4, top + 3.55, 0.5, 0.32, 0.03, '#c2674a', meta);
      }
      return { u: doorU, y: top - 0.44, v: hd + depth + 0.02 };
    }
    default:
      flatRoof(pal.roof);
      return null;
  }
}
