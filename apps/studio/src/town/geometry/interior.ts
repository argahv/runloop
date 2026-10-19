/**
 * A building's interior as a cutaway (plan §5: only the open building mounts
 * it): the floor, walls along the edge cells (tall at the back, cut low on
 * the sides facing the camera, open at the door, glazed at 'w' cells) and
 * every piece of furniture from the interior file. Built in the building's
 * local frame, so furniture and the residents' slots line up exactly.
 */
import type { Furniture, GridInterior } from '@runloop-world/town';
import { mixHex, scaleHex } from '../color';
import { STOREY } from '../coords';
import { BODY } from '../rig/residentRig';
import { BUILDING_COLORS as B, DECO_COLORS as D } from '../townPalette';
import { GLOW_KIND, GeoBuilder } from './builder';
import type { LocalFrame } from './frame';
import { noise2 } from './ground';

/** Top of interior floors (residents inside stand here). */
export const INTERIOR_FLOOR_Y = 0.16;
const H_BACK = STOREY + 0.05;
const H_CUT = 0.32;

export type WallSide = 'front' | 'back' | 'left' | 'right';

const FLOORS: Record<string, [string, string]> = {
  house: ['#c9a27a', '#bf9670'],
  flats: ['#c9a27a', '#bf9670'],
  cafe: ['#b98a62', '#ad7f58'],
  bakery: ['#e8dcc6', '#d9c9ad'],
  diner: ['#efe8dc', '#cf6a5a'],
  tavern: ['#a77a55', '#9c704c'],
  shop: ['#d8c6a6', '#cdb898'],
  office: ['#aab4bf', '#a3adb8'],
  lab: ['#e6eaee', '#d9dfe5'],
  library: ['#b08560', '#a67b57'],
  town_hall: ['#d9cdb5', '#cfc2a8'],
  workshop: ['#b5b0a6', '#aaa59b'],
  greenhouse: ['#cdbf9f', '#c2b392'],
};

export function buildInterior(interior: GridInterior, f: LocalFrame, wall: string, trim: string, cut: ReadonlySet<WallSide>): GeoBuilder {
  const gb = new GeoBuilder();
  const y0 = INTERIOR_FLOOR_Y;
  const g = interior.grid;
  const h = g.length;
  const w = g[0]!.length;
  const [fa, fb] = FLOORS[interior.archetype] ?? ['#cdbfa6', '#c2b49b'];
  const box = (u: number, v: number, y: number, su: number, sy: number, sv: number, color: string, glow = 0) =>
    gb.box(f.x(u, v), y, f.z(u, v), su, sy, sv, color, { glow }, f.yaw);

  // Floor: planks or tiles, one quad per cell (edge cells under the walls too).
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const u = f.cellU(ix);
      const v = f.cellV(iy);
      const tile = interior.archetype === 'diner' ? (ix + iy) % 2 === 0 : interior.archetype === 'lab' || interior.archetype === 'bakery' || interior.archetype === 'office' ? true : ix % 2 === 0;
      const c = scaleHex(tile ? fa : fb, 0.97 + 0.06 * noise2(ix, iy, 5));
      box(u, v, y0 - 0.06, 1.0, 0.06, 1.0, c);
    }
  }

  // Walls on the edge cells, from the outer face (0.3 out from the cell centre) to the cell centre.
  const sideOf = (ix: number, iy: number): WallSide[] => {
    const out: WallSide[] = [];
    if (iy === h - 1) out.push('front');
    if (iy === 0) out.push('back');
    if (ix === 0) out.push('left');
    if (ix === w - 1) out.push('right');
    return out;
  };
  const wallSection = scaleHex(wall, 0.86);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const ch = g[iy]![ix]!;
      if (ch === '.') continue;
      for (const side of sideOf(ix, iy)) {
        const u = f.cellU(ix);
        const v = f.cellV(iy);
        const low = cut.has(side);
        const height = low ? H_CUT : H_BACK;
        const [cu, cv, su, sv] =
          side === 'front' ? [u, v + 0.15, 1.0, 0.3] : side === 'back' ? [u, v - 0.15, 1.0, 0.3] : side === 'left' ? [u - 0.15, v, 0.3, 1.0] : [u + 0.15, v, 0.3, 1.0];
        if (ch === 'D') {
          box(cu, cv, y0 - 0.02, su, 0.04, sv, B.doorstep);
          if (!low) box(cu, cv, y0 + 1.15, su, height - 1.15, sv, wall);
          continue;
        }
        if (ch === 'w' && !low) {
          box(cu, cv, y0, su, 0.5, sv, wall);
          box(cu, cv, y0 + 0.5, su * (side === 'front' || side === 'back' ? 0.92 : 1), 0.62, sv * (side === 'left' || side === 'right' ? 0.92 : 1), B.windowDay, GLOW_KIND.window);
          box(cu, cv, y0 + 1.12, su, height - 1.12, sv, wall);
          continue;
        }
        box(cu, cv, y0, su, height, sv, wall);
        box(cu, cv, y0 + height, su + 0.02, 0.04, sv + 0.02, low ? wallSection : trim);
      }
    }
  }

  for (const fu of interior.furniture) furniture(gb, f, fu, y0, interior.archetype);
  return gb;
}

/** Local u/v of an interior cell. */
const at = (f: LocalFrame, c: readonly [number, number]) => [f.cellU(c[0]), f.cellV(c[1])] as const;

function bounds(f: LocalFrame, cells: readonly (readonly [number, number])[]) {
  const us = cells.map((c) => f.cellU(c[0]));
  const vs = cells.map((c) => f.cellV(c[1]));
  const u0 = Math.min(...us) - 0.5;
  const u1 = Math.max(...us) + 0.5;
  const v0 = Math.min(...vs) - 0.5;
  const v1 = Math.max(...vs) + 0.5;
  return { u: (u0 + u1) / 2, v: (v0 + v1) / 2, su: u1 - u0, sv: v1 - v0 };
}

const DIR: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** Direction (local du, dv) from the furniture towards its first use beside it (where people stand or sit). */
function frontOf(fu: Furniture): [number, number] {
  const own = new Set(fu.cells.map((c) => `${c[0]},${c[1]}`));
  for (const u of fu.uses) {
    if (own.has(`${u.cell[0]},${u.cell[1]}`)) continue;
    for (const c of fu.cells) {
      const dx = u.cell[0] - c[0];
      const dy = u.cell[1] - c[1];
      if (Math.abs(dx) + Math.abs(dy) === 1) return [dx, dy];
    }
  }
  return [0, 1];
}

const WOOD = '#a87a52';
const WOOD_DARK = '#7f5b3d';
const METAL = '#9aa1ab';
const FABRIC = ['#c96f53', '#5a87b0', '#6f9e5a', '#b5835a', '#8f6f9b'];

function furniture(gb: GeoBuilder, f: LocalFrame, fu: Furniture, y0: number, arch: string): void {
  const b = bounds(f, fu.cells);
  const box = (u: number, v: number, y: number, su: number, sy: number, sv: number, color: string, glow = 0) =>
    gb.box(f.x(u, v), y0 + y, f.z(u, v), su, sy, sv, color, { glow }, f.yaw);
  const [fdu, fdv] = frontOf(fu);
  const fabric = FABRIC[Math.floor(noise2(fu.cells[0]![0], fu.cells[0]![1], fu.id.length) * FABRIC.length)]!;
  const own = new Set(fu.cells.map((c) => `${c[0]},${c[1]}`));
  // Chairs (or stools) at sit uses beside the furniture, back away from it.
  const chairs = () => {
    for (const use of fu.uses) {
      if (use.pose !== 'sit' || own.has(`${use.cell[0]},${use.cell[1]}`)) continue;
      const [u, v] = at(f, use.cell);
      const [dx, dy] = DIR[use.facing ?? 'n'] ?? [0, -1];
      const cu = u - dx * 0.12;
      const cv = v - dy * 0.12;
      box(cu, cv, 0, 0.4, BODY.seatY, 0.4, WOOD_DARK);
      box(cu, cv, BODY.seatY - 0.04, 0.44, 0.05, 0.44, fu.kind === 'desk' ? '#4a5160' : WOOD);
      box(cu - dx * 0.2, cv - dy * 0.2, BODY.seatY, dx ? 0.05 : 0.44, 0.42, dy ? 0.05 : 0.44, fu.kind === 'desk' ? '#4a5160' : WOOD);
    }
  };
  const seatBack = (height: number, color: string) => {
    // Seating furniture: the back is on the side away from where people face.
    const use = fu.uses[0];
    const [dx, dy] = DIR[use?.facing ?? 's'] ?? [0, 1];
    box(b.u - dx * (b.su / 2 - 0.1), b.v - dy * (b.sv / 2 - 0.1), 0, dx ? 0.2 : b.su, height, dy ? 0.2 : b.sv, color);
  };
  switch (fu.kind) {
    case 'bed':
    case 'double_bed': {
      const use = fu.uses[0];
      const [dx, dy] = DIR[use?.facing ?? 's'] ?? [0, 1];
      box(b.u, b.v, 0, b.su - 0.08, 0.2, b.sv - 0.08, WOOD);
      box(b.u, b.v, 0.2, b.su - 0.14, 0.1, b.sv - 0.14, '#f4efe6');
      // Blanket towards the feet, pillows and the headboard at the head.
      box(b.u + dx * 0.15, b.v + dy * 0.15, 0.24, (b.su - 0.1) * (dx ? 0.7 : 1), 0.08, (b.sv - 0.1) * (dy ? 0.7 : 1), fabric);
      box(b.u - dx * (b.su / 2 - 0.25), b.v - dy * (b.sv / 2 - 0.25), 0.3, dx ? 0.22 : b.su - 0.3, 0.07, dy ? 0.22 : b.sv - 0.3, '#ffffff');
      box(b.u - dx * (b.su / 2 - 0.05), b.v - dy * (b.sv / 2 - 0.05), 0, dx ? 0.1 : b.su, 0.62, dy ? 0.1 : b.sv, WOOD_DARK);
      return;
    }
    case 'sofa':
    case 'armchair':
    case 'booth':
      box(b.u, b.v, 0, b.su - 0.08, BODY.seatY - 0.02, b.sv - 0.08, scaleHex(fabric, 0.85));
      box(b.u, b.v, BODY.seatY - 0.06, b.su - 0.12, 0.06, b.sv - 0.12, fabric);
      seatBack(fu.kind === 'booth' ? 0.78 : 0.56, scaleHex(fabric, 0.9));
      if (fu.kind === 'booth') box(b.u, b.v, 0, 0.5, 0.45, 0.5, WOOD);
      return;
    case 'table':
      box(b.u, b.v, 0.42, b.su - 0.16, 0.05, b.sv - 0.16, WOOD);
      for (const su of [-1, 1]) for (const sv of [-1, 1]) box(b.u + su * (b.su / 2 - 0.15), b.v + sv * (b.sv / 2 - 0.15), 0, 0.06, 0.42, 0.06, WOOD_DARK);
      box(b.u, b.v, 0.47, 0.12, 0.08, 0.12, '#f4efe6');
      chairs();
      return;
    case 'desk': {
      box(b.u, b.v, 0.44, b.su - 0.1, 0.05, b.sv - 0.1, arch === 'office' || arch === 'office_small' ? '#e9e4da' : WOOD);
      box(b.u, b.v, 0, b.su - 0.2, 0.44, b.sv - 0.2, scaleHex(WOOD, 0.85));
      // A monitor facing the seat.
      box(b.u - fdu * 0.2, b.v - fdv * 0.2, 0.49, fdu ? 0.05 : 0.46, 0.3, fdv ? 0.05 : 0.46, '#2b2f36');
      box(b.u - fdu * 0.17, b.v - fdv * 0.17, 0.53, fdu ? 0.02 : 0.4, 0.22, fdv ? 0.02 : 0.4, '#7fa2c4', GLOW_KIND.window);
      box(b.u + fdu * 0.15, b.v + fdv * 0.15, 0.49, fdu ? 0.14 : 0.32, 0.02, fdv ? 0.14 : 0.32, '#3a3e47');
      chairs();
      return;
    }
    case 'counter':
    case 'bar':
      box(b.u, b.v, 0, b.su - 0.06, 0.56, b.sv - 0.06, fu.kind === 'bar' ? WOOD_DARK : mixHex(WOOD, '#e9e1d2', 0.4));
      box(b.u, b.v, 0.56, b.su, 0.05, b.sv, fu.kind === 'bar' ? WOOD : '#efe8dc');
      if (fu.kind === 'bar') for (let i = 0; i < 3; i++) box(b.u + (i - 1) * 0.3, b.v, 0.61, 0.06, 0.18, 0.06, ['#7a9a6a', '#b5835a', '#5a87b0'][i]!);
      chairs();
      return;
    case 'stove':
    case 'oven':
      box(b.u, b.v, 0, b.su - 0.08, 0.56, b.sv - 0.08, '#d9d6cf');
      box(b.u + fdu * (b.sv / 2 - 0.03), b.v + fdv * (b.sv / 2 - 0.03), 0.12, fdu ? 0.02 : 0.6, 0.3, fdv ? 0.02 : 0.6, fu.kind === 'oven' ? '#3a3e47' : '#5a5f69');
      for (const s of [-1, 1]) box(b.u + s * 0.18 * (fdv ? 1 : 0), b.v + s * 0.18 * (fdu ? 1 : 0), 0.56, 0.18, 0.02, 0.18, '#2f3238');
      return;
    case 'espresso':
      box(b.u, b.v, 0, b.su - 0.06, 0.56, b.sv - 0.06, mixHex(WOOD, '#e9e1d2', 0.4));
      box(b.u, b.v, 0.56, b.su, 0.05, b.sv, '#efe8dc');
      box(b.u, b.v, 0.61, 0.6, 0.4, 0.42, METAL);
      box(b.u + fdu * 0.22, b.v + fdv * 0.22, 0.63, 0.2, 0.06, 0.2, '#2f3238');
      return;
    case 'fridge':
      box(b.u, b.v, 0, b.su - 0.12, 1.15, b.sv - 0.12, '#eef0f2');
      return;
    case 'shelf':
    case 'bookcase': {
      const tall = fu.kind === 'bookcase' ? 1.15 : 0.95;
      box(b.u, b.v, 0, b.su - 0.08, tall, b.sv - 0.08, WOOD_DARK);
      const goods = arch === 'bakery' ? ['#d9a35a', '#c98a4a', '#e8c37a'] : arch === 'shop' ? ['#c96f53', '#5a87b0', '#6f9e5a', '#e8c37a'] : ['#c96f53', '#5a87b0', '#6f9e5a', '#b996d6', '#efc067'];
      for (let row = 0; row < 3; row++) {
        const n = Math.max(2, Math.round(Math.max(b.su, b.sv) / 0.22));
        for (let i = 0; i < n; i++) {
          const t = -0.5 + (i + 0.5) / n;
          const long = Math.max(b.su, b.sv) - 0.2;
          const along = b.su >= b.sv;
          box(b.u + (along ? t * long : fdu * (b.su / 2 - 0.12)), b.v + (along ? fdv * (b.sv / 2 - 0.12) : t * long), 0.12 + row * (tall / 3.2), along ? long / n - 0.03 : 0.12, 0.2, along ? 0.12 : long / n - 0.03, goods[(i + row * 2) % goods.length]!);
        }
      }
      return;
    }
    case 'workbench':
      box(b.u, b.v, 0.48, b.su - 0.06, 0.08, b.sv - 0.06, WOOD);
      for (const su of [-1, 1]) for (const sv of [-1, 1]) box(b.u + su * (b.su / 2 - 0.12), b.v + sv * (b.sv / 2 - 0.12), 0, 0.08, 0.48, 0.08, WOOD_DARK);
      box(b.u - 0.25, b.v, 0.56, 0.24, 0.12, 0.18, '#c4553e');
      box(b.u + 0.25, b.v, 0.56, 0.3, 0.06, 0.1, METAL);
      return;
    case 'lab_bench':
      box(b.u, b.v, 0, b.su - 0.08, 0.5, b.sv - 0.08, '#e9eef2');
      box(b.u, b.v, 0.5, b.su, 0.04, b.sv, '#cfd8df');
      for (let i = 0; i < 3; i++) gb.cylinder(f.x(b.u + (i - 1) * 0.3, b.v), y0 + 0.54, f.z(b.u + (i - 1) * 0.3, b.v), 0.05, 0.18, i % 2 ? '#7fb8c8' : '#9ec9a8', 6);
      chairs();
      return;
    case 'whiteboard':
      box(b.u, b.v, 0.3, b.su - 0.1, 0.8, 0.06, '#f7f7f4');
      box(b.u, b.v, 0, 0.05, 0.3, 0.05, METAL);
      for (let i = 0; i < 3; i++) box(b.u - 0.2 + i * 0.15, b.v + 0.035, 0.55 + i * 0.15, 0.4 - i * 0.1, 0.03, 0.01, ['#5a87b0', '#c96f53', '#6f9e5a'][i]!);
      return;
    case 'server_rack':
      box(b.u, b.v, 0, b.su - 0.14, 1.2, b.sv - 0.14, '#2a2d34');
      for (let i = 0; i < 6; i++) box(b.u + fdu * (b.sv / 2 - 0.06), b.v + fdv * (b.sv / 2 - 0.06), 0.15 + i * 0.17, fdu ? 0.02 : 0.5, 0.04, fdv ? 0.02 : 0.5, i % 2 ? '#5a87b0' : '#8fa4bf');
      return;
    case 'plant_bed':
      box(b.u, b.v, 0, b.su - 0.1, 0.25, b.sv - 0.1, WOOD_DARK);
      box(b.u, b.v, 0.25, b.su - 0.2, 0.03, b.sv - 0.2, '#6f553f');
      for (const c of fu.cells) {
        const [u, v] = at(f, c);
        gb.blob(f.x(u, v), y0 + 0.42, f.z(u, v), 0.3, 0.22, 0.3, noise2(c[0], c[1], 9) < 0.5 ? D.leafA : D.leafC, 0);
        if (noise2(c[0], c[1], 3) < 0.4) gb.blob(f.x(u + 0.15, v), y0 + 0.6, f.z(u + 0.15, v), 0.08, 0.08, 0.08, D.flowerRed, 0);
      }
      return;
    case 'display':
      box(b.u, b.v, 0, b.su - 0.12, 0.38, b.sv - 0.12, WOOD);
      for (let i = 0; i < 4; i++) box(b.u + ((i % 2) - 0.5) * 0.35, b.v + (Math.floor(i / 2) - 0.5) * 0.35, 0.38, 0.22, 0.1, 0.16, ['#c96f53', '#5a87b0', '#efc067', '#6f9e5a'][i]!);
      return;
    case 'register':
      box(b.u, b.v, 0, b.su - 0.08, 0.56, b.sv - 0.08, WOOD_DARK);
      box(b.u, b.v, 0.56, b.su, 0.04, b.sv, WOOD);
      box(b.u, b.v, 0.6, 0.3, 0.18, 0.25, '#3a3e47');
      return;
    case 'piano':
      box(b.u, b.v, 0, b.su - 0.08, 0.62, b.sv - 0.3, '#2b2622');
      box(b.u + fdu * 0.25, b.v + fdv * 0.25, 0.44, fdu ? 0.2 : b.su - 0.2, 0.04, fdv ? 0.2 : b.sv - 0.2, '#f4efe6');
      return;
    case 'lectern':
      box(b.u, b.v, 0, 0.12, 0.8, 0.12, WOOD_DARK);
      box(b.u, b.v, 0.8, 0.5, 0.06, 0.4, WOOD);
      return;
    case 'plant':
      gb.cylinder(f.x(b.u, b.v), y0, f.z(b.u, b.v), 0.18, 0.3, D.planter, 8, 0.8);
      gb.blob(f.x(b.u, b.v), y0 + 0.55, f.z(b.u, b.v), 0.3, 0.32, 0.3, D.leafB, 0);
      return;
  }
}
