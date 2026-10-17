'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo } from 'react';
import { DoubleSide } from 'three';
import { useScene } from './context';
import { glowPaths, pathPoints } from './layout';
import { PALETTE, glow } from './palette';
import { chevronTexture, ribbonGeometry } from './textures';

/**
 * Glowing conveyor lines from the hub to each room door (and on to its
 * stations). Purely decorative Layer-3 geometry derived from world-engine BFS.
 */
export const Paths = memo(function Paths() {
  const { world, reducedMotion } = useScene();
  const tex = useMemo(() => chevronTexture(), []);

  const ribbons = useMemo(() => {
    return glowPaths(world).map((p, i) => {
      const lift = 0.004 + (i % 4) * 0.0015;
      const pts = pathPoints(world, p.cells, lift);
      const ptsMid = pathPoints(world, p.cells, lift + 0.002);
      const ptsTop = pathPoints(world, p.cells, lift + 0.004);
      const wide = p.branch ? 0.2 : 0.32;
      return {
        key: p.key,
        branch: p.branch,
        color: p.color,
        track: ribbonGeometry(pts, wide, { extend: true }),
        line: ribbonGeometry(ptsMid, p.branch ? 0.045 : 0.06, { extend: true }),
        chevrons: ribbonGeometry(ptsTop, wide * 0.62, { uPerUnit: 2.2 }),
      };
    });
  }, [world]);

  useEffect(
    () => () => {
      for (const r of ribbons) {
        r.track.dispose();
        r.line.dispose();
        r.chevrons.dispose();
      }
    },
    [ribbons],
  );

  useFrame((_, dt) => {
    if (reducedMotion) return;
    tex.offset.x = (tex.offset.x - dt * 0.9) % 1;
  });

  return (
    <group>
      {ribbons.map((r) => (
        <group key={r.key}>
          <mesh geometry={r.track}>
            <meshBasicMaterial color={PALETTE.track} side={DoubleSide} />
          </mesh>
          <mesh geometry={r.line}>
            <meshBasicMaterial color={glow(r.color, r.branch ? 1.1 : 1.7)} side={DoubleSide} toneMapped={false} />
          </mesh>
          <mesh geometry={r.chevrons}>
            <meshBasicMaterial
              map={tex}
              color={glow(r.color, r.branch ? 0.9 : 1.5)}
              transparent
              opacity={r.branch ? 0.55 : 0.9}
              depthWrite={false}
              side={DoubleSide}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
});
