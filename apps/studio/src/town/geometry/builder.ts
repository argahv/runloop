/**
 * A small mesh builder for the town's static geometry. Everything static
 * (ground, buildings, trees, props) is appended into a few large buffers with
 * vertex colours, so the whole town draws in a handful of calls.
 *
 * Per-vertex `aMeta` (vec4):
 *   x = glow kind (GLOW_KIND), y = building index + 1 (0 = none),
 *   z = optional rank (0 = always drawn; 0–1 = decoration dropped first at
 *       low quality), w = anchor: the item's town cell index + 1 (0 = none),
 *       so a whole item can be hidden when it stands in front of an open
 *       interior (the `uCut` rectangle).
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, IcosahedronGeometry, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

export const GLOW_KIND = {
  none: 0,
  /** Lit at night (and faintly by day) when its building is occupied. */
  window: 1,
  /** A street lamp: on from dusk to dawn. */
  lamp: 2,
  /** A shop sign: glows at night while the shop is open. */
  sign: 3,
} as const;

export interface Meta {
  glow?: number;
  /** Building index + 1 (0 = none). */
  bld?: number;
  opt?: number;
}

const tmpV = new Vector3();
const tmpN = new Vector3();
const tmpC = new Color();
const normalM = new Matrix3();

/** Unit primitives, shared and never disposed (they are only read). */
const UNIT_BOX = new BoxGeometry(1, 1, 1).toNonIndexed();
const cylinders = new Map<string, BufferGeometry>();
const icos = new Map<number, BufferGeometry>();

function unitCylinder(segments: number, topRatio: number): BufferGeometry {
  const key = `${segments}:${topRatio}`;
  let g = cylinders.get(key);
  if (!g) {
    g = new CylinderGeometry(topRatio, 1, 1, segments, 1, false).toNonIndexed();
    g.computeVertexNormals();
    // Flat shading on the sides reads better at town scale.
    flatten(g);
    cylinders.set(key, g);
  }
  return g;
}

function unitIco(detail: number): BufferGeometry {
  let g = icos.get(detail);
  if (!g) {
    const ico = new IcosahedronGeometry(1, detail);
    g = ico.index ? ico.toNonIndexed() : ico;
    flatten(g);
    icos.set(detail, g);
  }
  return g;
}

/** Per-face normals on a non-indexed geometry. */
function flatten(g: BufferGeometry): void {
  const pos = g.getAttribute('position');
  const normals = new Float32Array(pos.count * 3);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    for (let k = 0; k < 3; k++) normals.set([n.x, n.y, n.z], (i + k) * 3);
  }
  g.setAttribute('normal', new BufferAttribute(normals, 3));
}

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private meta: number[] = [];
  private uv: number[] | null;
  /** Town cell index + 1 written to every vertex appended while set (aMeta.w); 0 = none. */
  anchor = 0;

  constructor(opts: { uv?: boolean } = {}) {
    this.uv = opts.uv ? [] : null;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Append a non-indexed geometry transformed by `m`, in one colour. Faces whose normal points down are skipped when `noBottom`. */
  append(g: BufferGeometry, m: Matrix4, color: string | Color, meta: Meta = {}, noBottom = false): this {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    normalM.getNormalMatrix(m);
    const c = typeof color === 'string' ? tmpC.set(color) : color;
    const glow = meta.glow ?? 0;
    const bld = meta.bld ?? 0;
    const opt = meta.opt ?? 0;
    for (let i = 0; i < p.count; i += 3) {
      if (noBottom) {
        tmpN.fromBufferAttribute(n, i).applyMatrix3(normalM);
        if (tmpN.y < -0.9) continue;
      }
      for (let k = 0; k < 3; k++) {
        tmpV.fromBufferAttribute(p, i + k).applyMatrix4(m);
        tmpN.fromBufferAttribute(n, i + k).applyMatrix3(normalM).normalize();
        this.pos.push(tmpV.x, tmpV.y, tmpV.z);
        this.nor.push(tmpN.x, tmpN.y, tmpN.z);
        this.col.push(c.r, c.g, c.b);
        this.meta.push(glow, bld, opt, this.anchor);
        this.uv?.push(0, 0);
      }
    }
    return this;
  }

  /** An axis-aligned (then yawed) box: centre x/z, bottom y0, size sx × sy × sz. */
  box(x: number, y0: number, z: number, sx: number, sy: number, sz: number, color: string | Color, meta: Meta = {}, yaw = 0, noBottom = true): this {
    const m = compose(x, y0 + sy / 2, z, yaw, sx, sy, sz);
    return this.append(UNIT_BOX, m, color, meta, noBottom);
  }

  /** A box rotated about an arbitrary centre with pitch/yaw (for hands, signs on angles…). */
  boxRot(x: number, y: number, z: number, sx: number, sy: number, sz: number, q: Quaternion, color: string | Color, meta: Meta = {}): this {
    const m = new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz));
    return this.append(UNIT_BOX, m, color, meta);
  }

  /** A cylinder or cone frustum: base centre x/z at y0, height h, base radius r, top radius r·topRatio. */
  cylinder(x: number, y0: number, z: number, r: number, h: number, color: string | Color, segments = 8, topRatio = 1, meta: Meta = {}, yaw = 0): this {
    const m = compose(x, y0 + h / 2, z, yaw, r, h, r);
    return this.append(unitCylinder(segments, topRatio), m, color, meta, true);
  }

  /** A low-poly blob (icosahedron), radii rx/ry/rz. */
  blob(x: number, y: number, z: number, rx: number, ry: number, rz: number, color: string | Color, detail = 0, meta: Meta = {}, yaw = 0): this {
    const m = compose(x, y, z, yaw, rx, ry, rz);
    return this.append(unitIco(detail), m, color, meta);
  }

  /**
   * A gable roof (triangular prism) over a w × d rectangle centred at x/z, eaves at y0,
   * ridge `rise` higher, ridge along x when `alongX` (else along z). Includes the two gable ends.
   */
  gable(x: number, y0: number, z: number, w: number, d: number, rise: number, roof: string, gableColor: string, alongX: boolean, meta: Meta = {}, thick = 0.08): this {
    // Work in local coordinates with the ridge along x, then rotate.
    const yaw = alongX ? 0 : Math.PI / 2;
    const L = alongX ? w : d;
    const D = alongX ? d : w;
    const hw = L / 2;
    const hd = D / 2;
    const tri = (a: number[], b: number[], c: number[], color: string) => this.triLocal(x, y0, z, yaw, a, b, c, color, meta);
    // Two roof planes (with a little thickness on the eaves via an under-face).
    tri([-hw, 0, hd], [hw, 0, hd], [hw, rise, 0], roof);
    tri([-hw, 0, hd], [hw, rise, 0], [-hw, rise, 0], roof);
    tri([hw, 0, -hd], [-hw, 0, -hd], [-hw, rise, 0], roof);
    tri([hw, 0, -hd], [-hw, rise, 0], [hw, rise, 0], roof);
    // Eave fascia (thickness).
    tri([-hw, -thick, hd], [hw, -thick, hd], [hw, 0, hd], roof);
    tri([-hw, -thick, hd], [hw, 0, hd], [-hw, 0, hd], roof);
    tri([hw, -thick, -hd], [-hw, -thick, -hd], [-hw, 0, -hd], roof);
    tri([hw, -thick, -hd], [-hw, 0, -hd], [hw, 0, -hd], roof);
    // Gable ends (inset slightly under the overhang).
    const gi = 0.02;
    tri([hw - gi, 0, hd - 0.25], [hw - gi, 0, -hd + 0.25], [hw - gi, rise - 0.05, 0], gableColor);
    tri([-hw + gi, 0, -hd + 0.25], [-hw + gi, 0, hd - 0.25], [-hw + gi, rise - 0.05, 0], gableColor);
    return this;
  }

  /** A hip roof: four planes up to a ridge (or a point when square). */
  hip(x: number, y0: number, z: number, w: number, d: number, rise: number, roof: string, meta: Meta = {}): this {
    const alongX = w >= d;
    const yaw = alongX ? 0 : Math.PI / 2;
    const L = alongX ? w : d;
    const D = alongX ? d : w;
    const hw = L / 2;
    const hd = D / 2;
    const r = Math.max(0, hw - hd);
    const tri = (a: number[], b: number[], c: number[]) => this.triLocal(x, y0, z, yaw, a, b, c, roof, meta);
    tri([-hw, 0, hd], [hw, 0, hd], [r, rise, 0]);
    tri([-hw, 0, hd], [r, rise, 0], [-r, rise, 0]);
    tri([hw, 0, -hd], [-hw, 0, -hd], [-r, rise, 0]);
    tri([hw, 0, -hd], [-r, rise, 0], [r, rise, 0]);
    tri([hw, 0, hd], [hw, 0, -hd], [r, rise, 0]);
    tri([-hw, 0, -hd], [-hw, 0, hd], [-r, rise, 0]);
    return this;
  }

  /** A flat quad (two triangles) given four corners in order, facing by winding. */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, color: string | Color, meta: Meta = {}, uvs?: [number, number][]): this {
    this.tri(a, b, c, color, meta, uvs ? [uvs[0]!, uvs[1]!, uvs[2]!] : undefined);
    this.tri(a, c, d, color, meta, uvs ? [uvs[0]!, uvs[2]!, uvs[3]!] : undefined);
    return this;
  }

  tri(a: Vector3, b: Vector3, c: Vector3, color: string | Color, meta: Meta = {}, uvs?: [number, number][]): this {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
    const col = typeof color === 'string' ? tmpC.set(color) : color;
    for (const [i, v] of [a, b, c].entries()) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(col.r, col.g, col.b);
      this.meta.push(meta.glow ?? 0, meta.bld ?? 0, meta.opt ?? 0, this.anchor);
      if (this.uv) this.uv.push(...(uvs?.[i] ?? [0, 0]));
    }
    return this;
  }

  private triLocal(x: number, y0: number, z: number, yaw: number, a: number[], b: number[], c: number[], color: string, meta: Meta): void {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const tr = (p: number[]) => new Vector3(x + p[0]! * cs + p[2]! * sn, y0 + p[1]!, z - p[0]! * sn + p[2]! * cs);
    this.tri(tr(a), tr(b), tr(c), color, meta);
  }

  /** The finished geometry (or null when empty). */
  build(): BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aMeta', new BufferAttribute(new Float32Array(this.meta), 4));
    if (this.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const q = new Quaternion();
const yAxis = new Vector3(0, 1, 0);
function compose(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): Matrix4 {
  q.setFromAxisAngle(yAxis, yaw);
  return new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz));
}

