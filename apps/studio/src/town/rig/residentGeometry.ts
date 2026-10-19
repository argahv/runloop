/**
 * The resident body: one merged low-poly mesh (≈ 400 triangles) whose
 * vertices carry the part they move with (`aPart`) and the colour slot they
 * take from the instance (`aMat`, plus 16 × the outfit style an accessory
 * belongs to; accessories of other styles collapse in the shader).
 * Residents never have visors or glowing eyes (robots are the agents).
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, IcosahedronGeometry, Matrix4, type BufferGeometry as BG } from 'three';
import { BODY } from './residentRig';

export const PART = { torso: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5 } as const;
export const MAT = { top: 0, bottom: 1, skin: 2, hair: 3, shoe: 4, eye: 5, apron: 6, bag: 7, accent: 8 } as const;
/** Outfit styles in the order of OutfitStyleSchema (the instance's aInst.z). */
export const STYLES = ['casual', 'apron', 'hoodie', 'labcoat', 'vest', 'backpack', 'blazer', 'overalls', 'cardigan'] as const;
const STYLE_ID = Object.fromEntries(STYLES.map((s, i) => [s, i])) as Record<(typeof STYLES)[number], number>;

export function styleId(style: string): number {
  return (STYLE_ID as Record<string, number>)[style] ?? 0;
}

interface Piece {
  g: BG;
  m: Matrix4;
  part: number;
  mat: number;
  /** Style id + 1 for accessories (0 = always drawn). */
  acc?: number;
}

const T = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => new Matrix4().makeScale(sx, sy, sz).setPosition(x, y, z);

/** The full body, feet at y = 0, facing +z. */
export function residentGeometry(): BufferGeometry {
  const box = new BoxGeometry(1, 1, 1);
  const limb = new CylinderGeometry(1, 1, 1, 6);
  const torso = new CylinderGeometry(0.85, 1, 1, 8);
  const head = new IcosahedronGeometry(1, 1);
  const lowSphere = new IcosahedronGeometry(1, 0);
  const { hipY, shoulderY, shoulderX, hipX } = BODY;
  const pieces: Piece[] = [
    // Legs (pivot at the hips) and shoes.
    { g: box, m: T(-hipX, hipY / 2, 0, 0.11, hipY, 0.12), part: PART.legL, mat: MAT.bottom },
    { g: box, m: T(hipX, hipY / 2, 0, 0.11, hipY, 0.12), part: PART.legR, mat: MAT.bottom },
    { g: box, m: T(-hipX, 0.035, 0.025, 0.12, 0.07, 0.18), part: PART.legL, mat: MAT.shoe },
    { g: box, m: T(hipX, 0.035, 0.025, 0.12, 0.07, 0.18), part: PART.legR, mat: MAT.shoe },
    // Hips and torso.
    { g: box, m: T(0, hipY + 0.01, 0, 0.27, 0.09, 0.16), part: PART.torso, mat: MAT.bottom },
    { g: torso, m: T(0, hipY + 0.17, 0, 0.155, 0.28, 0.1), part: PART.torso, mat: MAT.top },
    { g: limb, m: T(0, shoulderY + 0.02, 0, 0.045, 0.06, 0.045), part: PART.head, mat: MAT.skin },
    // Arms (pivot at the shoulders): sleeve, then the hand.
    { g: limb, m: T(-shoulderX, shoulderY - 0.12, 0, 0.045, 0.24, 0.045), part: PART.armL, mat: MAT.top },
    { g: limb, m: T(shoulderX, shoulderY - 0.12, 0, 0.045, 0.24, 0.045), part: PART.armR, mat: MAT.top },
    { g: lowSphere, m: T(-shoulderX, shoulderY - 0.27, 0, 0.045, 0.045, 0.045), part: PART.armL, mat: MAT.skin },
    { g: lowSphere, m: T(shoulderX, shoulderY - 0.27, 0, 0.045, 0.045, 0.045), part: PART.armR, mat: MAT.skin },
    // Head, hair cap and eyes.
    { g: head, m: T(0, 0.82, 0, 0.13, 0.13, 0.125), part: PART.head, mat: MAT.skin },
    { g: lowSphere, m: T(0, 0.855, -0.018, 0.142, 0.118, 0.14), part: PART.head, mat: MAT.hair },
    { g: box, m: T(-0.045, 0.825, 0.118, 0.026, 0.036, 0.02), part: PART.head, mat: MAT.eye },
    { g: box, m: T(0.045, 0.825, 0.118, 0.026, 0.036, 0.02), part: PART.head, mat: MAT.eye },
    // Accessories by outfit style.
    { g: box, m: T(0, hipY + 0.06, 0.09, 0.24, 0.34, 0.02), part: PART.torso, mat: MAT.apron, acc: STYLE_ID.apron + 1 },
    { g: box, m: T(0, shoulderY - 0.02, -0.105, 0.2, 0.12, 0.07), part: PART.torso, mat: MAT.accent, acc: STYLE_ID.hoodie + 1 },
    { g: box, m: T(0, hipY - 0.06, 0, 0.3, 0.2, 0.19), part: PART.torso, mat: MAT.top, acc: STYLE_ID.labcoat + 1 },
    { g: box, m: T(0, hipY + 0.17, 0.088, 0.2, 0.22, 0.02), part: PART.torso, mat: MAT.accent, acc: STYLE_ID.vest + 1 },
    { g: box, m: T(0, hipY + 0.17, -0.11, 0.21, 0.24, 0.09), part: PART.torso, mat: MAT.bag, acc: STYLE_ID.backpack + 1 },
    { g: box, m: T(0, hipY + 0.2, 0.09, 0.07, 0.2, 0.02), part: PART.torso, mat: MAT.apron, acc: STYLE_ID.blazer + 1 },
    { g: box, m: T(0, hipY + 0.1, 0.088, 0.17, 0.16, 0.02), part: PART.torso, mat: MAT.bottom, acc: STYLE_ID.overalls + 1 },
    { g: box, m: T(0, hipY + 0.17, 0.092, 0.035, 0.26, 0.02), part: PART.torso, mat: MAT.accent, acc: STYLE_ID.cardigan + 1 },
  ];
  return merge(pieces);
}

/** The far-zoom stand-in: a body block in the top colour, legs and a head (≈ 36 triangles). */
export function residentDotGeometry(): BufferGeometry {
  const box = new BoxGeometry(1, 1, 1);
  return merge([
    // A little larger than life, so a crowd still reads from the far zoom.
    { g: box, m: T(0, 0.26, 0, 0.3, 0.52, 0.2), part: PART.torso, mat: MAT.bottom },
    { g: box, m: T(0, 0.72, 0, 0.4, 0.42, 0.27), part: PART.torso, mat: MAT.top },
    { g: box, m: T(0, 1.07, 0, 0.29, 0.29, 0.29), part: PART.torso, mat: MAT.skin },
  ]);
}

function merge(pieces: readonly Piece[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const part: number[] = [];
  const mat: number[] = [];
  const nm = new Matrix4();
  for (const p of pieces) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    g.computeVertexNormals();
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    const geo = new BufferGeometry();
    geo.setAttribute('position', pa.clone());
    geo.setAttribute('normal', na.clone());
    geo.applyMatrix4(p.m);
    nm.copy(p.m);
    const P = geo.getAttribute('position');
    const N = geo.getAttribute('normal');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      part.push(p.part);
      mat.push(p.mat + 16 * (p.acc ?? 0));
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 1));
  out.setAttribute('aMat', new BufferAttribute(new Float32Array(mat), 1));
  out.computeBoundingSphere();
  return out;
}
