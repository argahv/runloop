'use client';
import { memo, useEffect, useMemo } from 'react';
import { DoubleSide } from 'three';
import { useScene } from './context';
import { glowPaths, pathPoints } from './layout';
import { ribbonGeometry } from './textures';

/**
 * Walkways from the Atrium to each room door, inlaid in the floor. Static
 * Layer-3 geometry derived from world-engine BFS: no glow and no motion,
 * because nothing is happening on them (rule zero).
 */
export const Paths = memo(function Paths() {
  const { world, palette } = useScene();

  const ribbons = useMemo(
    () =>
      glowPaths(world)
        .filter((p) => !p.branch)
        .map((p, i) => ({ key: p.key, geo: ribbonGeometry(pathPoints(world, p.cells, 0.004 + (i % 4) * 0.0015), 0.16, { extend: true }) })),
    [world],
  );

  useEffect(
    () => () => {
      for (const r of ribbons) r.geo.dispose();
    },
    [ribbons],
  );

  return (
    <group>
      {ribbons.map((r) => (
        <mesh key={r.key} geometry={r.geo}>
          <meshLambertMaterial color={palette.inlay} side={DoubleSide} />
        </mesh>
      ))}
    </group>
  );
});
