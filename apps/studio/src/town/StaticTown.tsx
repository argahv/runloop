'use client';
import { useFrame } from '@react-three/fiber';
import { isOpenAt, minuteOfDay } from '@runloop-world/town';
import type { CompiledTown } from '@runloop-world/town';
import { memo, useEffect, useMemo, useRef } from 'react';
import { DoubleSide, FrontSide, type BufferGeometry, type Material, type Vector4 } from 'three';
import { useTown } from './context';
import { cutRect } from './place';
import { buildBuildings, buildingShape } from './geometry/buildings';
import type { SurroundLayout } from './geometry/surroundings';
import { buildDecoration } from './geometry/deco';
import { buildGround, buildRoadPaint, buildWater } from './geometry/ground';
import { GeoBuilder } from './geometry/builder';
import { buildSigns } from './geometry/signs';
import { createSignMaterial, createTownMaterial, createWaterMaterial } from './townMaterial';

/**
 * Everything that does not move: ground chunks, road paint, the pond,
 * buildings, signs and decoration, in a handful of merged meshes. Built once
 * per town; per-frame state reaches them only through the town uniforms
 * (night, lit windows, open signs, the open interior, dimming).
 */
export const StaticTown = memo(function StaticTown({ seed, shadows, layout }: { seed: number; shadows: boolean; layout?: SurroundLayout | undefined }) {
  const { town, places, uniforms, frame, live } = useTown();
  const exits = layout?.exits;

  const built = useMemo(() => {
    const ground = buildGround(town, exits)
      .map((g) => g.build())
      .filter((g): g is BufferGeometry => g !== null);
    const paint = buildRoadPaint(town).build();
    const water = buildWater(town).build();
    const bgb = new GeoBuilder();
    const signs = buildSigns(buildBuildings(town, bgb));
    const buildings = bgb.build();
    const deco = buildDecoration(town, places, seed, exits).build();
    return { ground, paint, water, buildings, deco, signs: signs ? { geometry: signs.geometry.build()!, texture: signs.texture } : null };
  }, [town, places, seed, exits]);

  const mats = useMemo(
    () => ({
      ground: createTownMaterial(uniforms, FrontSide),
      solid: createTownMaterial(uniforms, DoubleSide),
      water: createWaterMaterial(uniforms),
      signs: built.signs ? createSignMaterial(uniforms, built.signs.texture) : null,
    }),
    [uniforms, built],
  );

  useEffect(
    () => () => {
      for (const g of [...built.ground, built.paint, built.water, built.buildings, built.deco, built.signs?.geometry]) g?.dispose();
      built.signs?.texture.dispose();
      for (const m of Object.values(mats)) (m as Material | null)?.dispose();
    },
    [built, mats],
  );

  // Flying in: the open building's roof lifts and dissolves (450 ms) while its walls give way to the cutaway;
  // leaving, the roof settles back. Reduced motion cuts.
  const lift = useRef<{ id: string | null; value: number }>({ id: null, value: 0 });
  useFrame((_, dt) => {
    const L = lift.current;
    const target = frame.entered && town.buildingById.has(frame.entered) ? frame.entered : null;
    if (target && target !== L.id) {
      L.id = target;
      L.value = 0;
      const b = town.buildingById.get(target)!;
      uniforms.uLiftBld.value = b.idx + 1;
      uniforms.uLiftBase.value = Math.max(0.6, buildingShape(b).wallTop - 0.05);
    }
    const goal = target ? 1 : 0;
    const step = live.reducedMotion ? 1 : Math.min(dt, 0.1) / 0.45;
    L.value = goal > L.value ? Math.min(goal, L.value + step) : Math.max(goal, L.value - step);
    uniforms.uRoofLift.value = L.value;
    uniforms.uWallsHidden.value = target ? 1 : 0;
    if (!target && L.value <= 0 && L.id) {
      L.id = null;
      uniforms.uLiftBld.value = 0;
    }
  });

  // Per-building state for the material: occupied (windows lit), hidden (interior open), open now (sign lit).
  useFrame(() => {
    const tex = uniforms.uBld.value;
    const data = tex.image.data as Uint8Array;
    const snap = frame.snapshot;
    const minute = minuteOfDay(Math.floor(frame.tick));
    let changed = false;
    for (const b of town.buildings) {
      const st = snap?.buildings[b.idx]?.id === b.def.id ? snap.buildings[b.idx] : snap?.buildings.find((x) => x.id === b.def.id);
      const lit = st && st.occupancy > 0 ? 255 : 0;
      // The open building is hidden by its lift (roof dissolving, walls replaced by the cutaway).
      const hidden = frame.entered === b.def.id && uniforms.uLiftBld.value !== b.idx + 1 ? 255 : 0;
      const open = st ? (st.open && isOpenAt(b.hours, minute) ? 255 : 0) : 0;
      const o = b.idx * 4;
      if (data[o] !== lit || data[o + 1] !== hidden || data[o + 2] !== open) {
        data[o] = lit;
        data[o + 1] = hidden;
        data[o + 2] = open;
        changed = true;
      }
    }
    if (changed) tex.needsUpdate = true;
    setCut(uniforms.uCut.value, town, frame.entered, frame.camAz);
  });

  return (
    <group>
      {built.ground.map((g, i) => (
        <mesh key={i} geometry={g} material={mats.ground} receiveShadow />
      ))}
      {built.paint && <mesh geometry={built.paint} material={mats.ground} receiveShadow />}
      {built.water && <mesh geometry={built.water} material={mats.water} receiveShadow />}
      {built.buildings && <mesh geometry={built.buildings} material={mats.solid} castShadow={shadows} receiveShadow />}
      {built.deco && <mesh geometry={built.deco} material={mats.solid} castShadow={shadows} receiveShadow />}
      {built.signs && mats.signs && <mesh geometry={built.signs.geometry} material={mats.signs} />}
    </group>
  );
});

function setCut(v: Vector4, town: CompiledTown, entered: string | null, camAz: number): void {
  const r = cutRect(town, entered, camAz);
  if (r) v.set(r[0], r[1], r[2], r[3]);
  else v.set(0, 0, 0, 0);
}
