/**
 * Baking a static subtree into one mesh per distinct material (MergeStatic):
 * transforms and material colours go into the vertices, so the subtree draws
 * in a few calls and looks the same.
 */
import { BufferAttribute, Matrix4, Mesh, type BufferGeometry, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type AnyMaterial = Material & {
  color?: { r: number; g: number; b: number; set: (c: number) => void };
  map?: { uuid: string } | null;
  roughness?: number;
  metalness?: number;
  flatShading?: boolean;
  emissive?: { getHex: () => number };
  emissiveIntensity?: number;
  vertexColors: boolean;
};

function signature(m: AnyMaterial, mesh: Mesh): string {
  return [
    m.type,
    m.side,
    m.transparent,
    m.opacity,
    m.depthWrite,
    m.depthTest,
    m.toneMapped,
    m.blending,
    m.map?.uuid ?? '',
    m.roughness ?? '',
    m.metalness ?? '',
    m.flatShading ?? '',
    m.emissive?.getHex() ?? '',
    m.emissiveIntensity ?? '',
    mesh.castShadow,
    mesh.receiveShadow,
    mesh.renderOrder,
  ].join('|');
}

/** One mesh per distinct material, in `root`'s local frame; null when the subtree holds something that cannot be baked. */
export function mergeMeshes(root: Object3D): Mesh[] | null {
  root.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const rel = new Matrix4();
  const groups = new Map<string, { material: AnyMaterial; mesh: Mesh; geos: BufferGeometry[] }>();
  let ok = true;
  root.traverse((o) => {
    if (!ok || o === root) return;
    const mesh = o as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    if (!mesh.isMesh) {
      // Groups are fine; lines, points, sprites and the like are not baked.
      if (o.type !== 'Group' && o.type !== 'Object3D') ok = false;
      return;
    }
    if (mesh.isInstancedMesh || mesh.isSkinnedMesh || Array.isArray(mesh.material) || mesh.morphTargetInfluences) {
      ok = false;
      return;
    }
    if (!isShown(mesh, root)) return;
    const m = mesh.material as AnyMaterial;
    const src = mesh.geometry;
    const g = src.index ? src.toNonIndexed() : src.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
    // Bake the material colour (times any vertex colour) into a colour attribute.
    const c = m.color ?? { r: 1, g: 1, b: 1 };
    const prev = m.vertexColors ? g.getAttribute('color') : undefined;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r * (prev ? prev.getX(i) : 1);
      col[i * 3 + 1] = c.g * (prev ? prev.getY(i) : 1);
      col[i * 3 + 2] = c.b * (prev ? prev.getZ(i) : 1);
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.applyMatrix4(rel.multiplyMatrices(inv, mesh.matrixWorld));
    g.morphAttributes = {};
    g.clearGroups();
    const key = signature(m, mesh);
    let grp = groups.get(key);
    if (!grp) groups.set(key, (grp = { material: m, mesh, geos: [] }));
    grp.geos.push(g);
  });
  if (!ok) {
    for (const grp of groups.values()) for (const g of grp.geos) g.dispose();
    return null;
  }
  const out: Mesh[] = [];
  for (const grp of groups.values()) {
    const geometry = mergeGeometries(grp.geos, false);
    for (const g of grp.geos) g.dispose();
    if (!geometry) return null;
    const material = grp.material.clone() as AnyMaterial;
    material.color?.set(0xffffff);
    material.vertexColors = true;
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = grp.mesh.castShadow;
    mesh.receiveShadow = grp.mesh.receiveShadow;
    mesh.renderOrder = grp.mesh.renderOrder;
    mesh.frustumCulled = false;
    out.push(mesh);
  }
  return out;
}

function isShown(o: Object3D, root: Object3D): boolean {
  for (let p: Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}
