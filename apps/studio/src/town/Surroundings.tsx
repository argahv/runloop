'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Color, DoubleSide, FrontSide, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry, type Group, type Object3D } from 'three';
import { hexToRgb } from './color';
import { useTown } from './context';
import { timed } from './perf';
import { buildCountryWater, buildFarms, buildFields, buildMillSails, buildMountains, buildRoadsOut, buildTerrain, treeGeometry, TREE_TONES } from './geometry/surroundMeshes';
import { terrainHeight, type SurroundLayout } from './geometry/surroundings';
import { createLandMaterial, createTownMaterial, createWaterMaterial } from './townMaterial';

/** Share of the countryside's trees drawn per quality level (0 high, 1 medium, 2 low / lite). */
const TREE_SHARE = [1, 0.66, 0.33] as const;

/**
 * The land beyond the town (contract §3), as a handful of static meshes:
 * terrain, roads out, fields, farmsteads (and the windmill's sails), the
 * Brook and the lake, far mountains, and the trees in four instanced meshes
 * (one per quadrant, so the ones behind the camera are culled). Decoration
 * only: nothing here is pickable or counted anywhere; the windmill turns only
 * while the world runs and motion is full.
 */
export const Surroundings = memo(function Surroundings({ layout, lite, ambient }: { layout: SurroundLayout; lite: boolean; ambient: boolean }) {
  const { uniforms, frame, live, surround } = useTown();
  const built = useMemo(() => {
    const farms = buildFarms(layout);
    return {
      terrain: buildTerrain(layout, lite),
      roads: buildRoadsOut(layout).build(),
      fields: buildFields(layout).build(),
      farms: farms.gb.build(),
      mill: farms.mill,
      sails: farms.mill ? buildMillSails().build() : null,
      water: buildCountryWater(layout).build(),
      mountains: buildMountains(),
      tree: treeGeometry(),
    };
  }, [layout, lite]);

  const mats = useMemo(
    () => ({
      land: createLandMaterial(uniforms, false),
      trees: createLandMaterial(uniforms, true),
      town: createTownMaterial(uniforms, FrontSide),
      solid: createTownMaterial(uniforms, DoubleSide),
      water: createWaterMaterial(uniforms),
      mountains: mountainMaterial(),
    }),
    [uniforms],
  );

  // Trees per quadrant, nearest-rank first so a lower quality keeps a fair sample.
  const quadrants = useMemo(() => {
    const q: SurroundLayout['trees'][] = [[], [], [], []];
    for (const t of layout.trees) q[(t.x >= 0 ? 1 : 0) + (t.z >= 0 ? 2 : 0)]!.push(t);
    for (const list of q) list.sort((a, b) => a.rank - b.rank);
    return q;
  }, [layout]);
  /** Trees drawn per quadrant at each quality level. */
  const treeCounts = useMemo(() => quadrants.map((list) => TREE_SHARE.map((share) => list.filter((t) => t.rank < share).length)), [quadrants]);
  const treeRefs = useRef<(InstancedMesh | null)[]>([]);
  useLayoutEffect(() => {
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const c = new Color();
    quadrants.forEach((list, qi) => {
      const mesh = treeRefs.current[qi];
      if (!mesh) return;
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.rank * 40);
        m.compose(new Vector3(t.x, terrainHeight(layout, t.x, t.z) - 0.05, t.z), q, new Vector3(t.s, t.h, t.s));
        mesh.setMatrixAt(i, m);
        c.set(TREE_TONES[t.tone] ?? TREE_TONES[0]).multiplyScalar(0.92 + 0.16 * ((t.rank * 7.3) % 1));
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }, [quadrants, layout]);

  const sails = useRef<Group>(null);
  const lastMinute = useRef(-1);
  const group = useRef<Group>(null);
  // Register for the perf meter (surroundCalls).
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const objs: Object3D[] = [];
    g.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) objs.push(o);
    });
    for (const o of objs) surround.add(o);
    return () => {
      for (const o of objs) surround.delete(o);
    };
  }, [built, surround]);

  useEffect(
    () => () => {
      for (const g of Object.values(built)) if (g && typeof (g as BufferGeometry).dispose === 'function') (g as BufferGeometry).dispose();
    },
    [built],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  useFrame(
    timed(() => {
      const level = lite ? 2 : live.quality.level;
      quadrants.forEach((_, qi) => {
        const mesh = treeRefs.current[qi];
        if (mesh) mesh.count = treeCounts[qi]![level]!;
      });
      const s = frame.sky;
      if (s && Math.abs(frame.minute - lastMinute.current) >= 0.1) {
        lastMinute.current = frame.minute;
        const u = mats.mountains.userData.uniforms as { uHaze: { value: Vector3 }; uLight: { value: number } } | undefined;
        if (u) {
          const [r, g, b] = hexToRgb(s.haze);
          u.uHaze.value.set(r, g, b);
          u.uLight.value = 1 - 0.7 * s.night;
        }
      }
      // The windmill turns only while the world runs (ambient time advances) and motion is full.
      if (sails.current) sails.current.rotation.z = ambient ? frame.ambientT * 0.6 : 0;
    }),
  );

  const mill = built.mill;
  return (
    <group ref={group}>
      <mesh geometry={built.terrain} material={mats.land} receiveShadow={false} />
      {built.roads && <mesh geometry={built.roads} material={mats.town} />}
      {built.fields && <mesh geometry={built.fields} material={mats.town} />}
      {built.farms && <mesh geometry={built.farms} material={mats.solid} />}
      {built.water && <mesh geometry={built.water} material={mats.water} />}
      <mesh geometry={built.mountains} material={mats.mountains} frustumCulled={false} />
      {mill && built.sails && (
        <group position={[mill.x, mill.y, mill.z]} rotation={[0, mill.yaw, 0]}>
          <group ref={sails}>
            <mesh geometry={built.sails} material={mats.solid} />
          </group>
        </group>
      )}
      {quadrants.map((list, qi) => (
        <instancedMesh
          key={qi}
          ref={(m) => {
            treeRefs.current[qi] = m;
          }}
          args={[built.tree, mats.trees, Math.max(1, list.length)]}
        />
      ))}
    </group>
  );
});

/** Far mountains: unlit silhouettes mixed into the haze of the hour (peaks a little clearer than their feet). */
function mountainMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    vertexColors: true,
    fog: false,
    toneMapped: false,
  });
  const uniforms = {
    uHaze: { value: new Vector3(0.8, 0.85, 0.9) },
    uLight: { value: 1 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // Haze by height above the land: the foot (where the hazy land hides it) is all haze, the peaks clearer.
    shader.vertexShader = 'varying float vH;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = clamp(position.y / 120.0, 0.0, 1.0);');
    shader.fragmentShader =
      'uniform vec3 uHaze;\nuniform float uLight;\nvarying float vH;\n' +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb * uLight, uHaze, mix(1.0, 0.36, smoothstep(0.0, 0.75, vH)));',
      );
  };
  m.customProgramCacheKey = () => 'town-mountains';
  return m;
}
