'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { MeshLambertMaterial } from 'three';
import { useTown } from './context';
import { buildingFrame } from './geometry/frame';
import { INTERIOR_FLOOR_Y, buildInterior, type WallSide } from './geometry/interior';
import { gridInteriorOf } from './place';

export function interiorFloorY(): number {
  return INTERIOR_FLOOR_Y;
}

/** Interior lights: rooms glow warmly at night (they are occupied when someone is inside to see). */
function interiorMaterial(night: { value: number }): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = night;
    shader.vertexShader = 'attribute vec4 aMeta;\nvarying float vGlowKind;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlowKind = aMeta.x;');
    shader.fragmentShader =
      'uniform float uNight;\nvarying float vGlowKind;\n' +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (0.22 * uNight + (vGlowKind > 0.5 ? 0.25 + 0.45 * uNight : 0.0));',
      );
  };
  m.customProgramCacheKey = () => 'town-interior';
  return m;
}

/**
 * The open building's interior, cut away on the sides facing the camera.
 * The town dims around it (uniform uDim) and its residents are drawn at their
 * furniture slots by <Residents>. Rebuilt when the camera turns to another side.
 */
export const Interior = memo(function Interior({ buildingId }: { buildingId: string }) {
  const { town, frame, uniforms } = useTown();
  const [cut, setCut] = useState<string>(() => cutKey(town, buildingId, frame.camAz));
  const material = useMemo(() => interiorMaterial(uniforms.uNight), [uniforms]);
  const built = useMemo(() => {
    const b = town.buildingById.get(buildingId);
    const interior = gridInteriorOf(town, buildingId);
    if (!b || !interior) return null;
    const sides = new Set(cut.split(',').filter(Boolean) as WallSide[]);
    return buildInterior(interior, buildingFrame(town, b), b.def.palette.wall, b.def.palette.trim, sides).build();
  }, [town, buildingId, cut]);
  useEffect(() => () => built?.dispose(), [built]);
  useEffect(() => () => material.dispose(), [material]);
  const last = useRef(cut);
  useFrame(() => {
    const k = cutKey(town, buildingId, frame.camAz);
    if (k !== last.current) {
      last.current = k;
      setCut(k);
    }
  });
  if (!built) return null;
  return <mesh geometry={built} material={material} castShadow receiveShadow />;
});

/** Which wall sides face the camera (cut low), as a stable key. */
function cutKey(town: ReturnType<typeof useTown>['town'], buildingId: string, camAz: number): string {
  const b = town.buildingById.get(buildingId);
  if (!b) return '';
  const f = buildingFrame(town, b);
  const cam = [Math.sin(camAz), Math.cos(camAz)] as const;
  const normals: [WallSide, number, number][] = [
    ['front', f.sin, f.cos],
    ['back', -f.sin, -f.cos],
    ['right', f.cos, -f.sin],
    ['left', -f.cos, f.sin],
  ];
  return normals
    .filter(([, x, z]) => x * cam[0] + z * cam[1] > 0.2)
    .map(([s]) => s)
    .join(',');
}
