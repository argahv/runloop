/**
 * A building's local frame: u along the façade (left → right seen from the
 * street), v towards the street (the facing side), y up. It is the interior's
 * authoring frame, centred: interior cell (ix, iy) sits at u = ix − (w−1)/2,
 * v = iy − (h−1)/2, so outside and inside line up exactly (the door is on the
 * v = max row).
 */
import type { CompiledBuilding, CompiledTown, Dir } from '@runloop-world/town';
import { interiorSize, rotatedSize } from '@runloop-world/town';
import { Vector3 } from 'three';
import { sceneX, sceneZ } from '../coords';

export const FACING_YAW: Record<Dir, number> = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 };

export class LocalFrame {
  readonly cos: number;
  readonly sin: number;
  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly yaw: number,
    /** Authoring size [w (along u), d (along v)]. */
    readonly w: number,
    readonly d: number,
  ) {
    this.cos = Math.cos(yaw);
    this.sin = Math.sin(yaw);
  }

  /** World x/z of local (u, v). */
  x(u: number, v: number): number {
    return this.cx + u * this.cos + v * this.sin;
  }
  z(u: number, v: number): number {
    return this.cz - u * this.sin + v * this.cos;
  }
  p(u: number, y: number, v: number): Vector3 {
    return new Vector3(this.x(u, v), y, this.z(u, v));
  }
  /** Local u/v of interior cell (ix, iy). */
  cellU(ix: number): number {
    return ix - (this.w - 1) / 2;
  }
  cellV(iy: number): number {
    return iy - (this.d - 1) / 2;
  }
}

/** The local frame of a town building (its footprint is the interior's size, rotated by its facing). */
export function buildingFrame(town: CompiledTown, b: CompiledBuilding): LocalFrame {
  const f = { width: town.width, height: town.height };
  const [fx, fy, fw, fh] = b.def.footprint;
  const interior = town.interiors[b.def.interior];
  const size: [number, number] = interior ? interiorSize(interior) : rotatedSize([fw, fh], b.def.facing);
  return new LocalFrame(sceneX(f, fx + (fw - 1) / 2), sceneZ(f, fy + (fh - 1) / 2), FACING_YAW[b.def.facing], size[0], size[1]);
}

/** The local frame of a lot rect fronting `facing` (agent lots). */
export function rectFrame(town: CompiledTown, rect: readonly [number, number, number, number], facing: Dir): LocalFrame {
  const f = { width: town.width, height: town.height };
  const [x, y, w, h] = rect;
  const [aw, ad] = rotatedSize([w, h], facing);
  return new LocalFrame(sceneX(f, x + (w - 1) / 2), sceneZ(f, y + (h - 1) / 2), FACING_YAW[facing], aw, ad);
}
