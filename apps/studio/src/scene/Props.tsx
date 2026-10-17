'use client';
import type { Prop } from '@runloop-world/world-engine';
import { memo } from 'react';
import { AdditiveBlending } from 'three';
import { useScene } from './context';
import { cellTop, isWall, toScene, yawFor } from './layout';
import { PALETTE, glow } from './palette';
import { blobShadowTexture, glowTexture } from './textures';

/** Decorative props from the world definition, built from simple primitives. */
export const Props = memo(function Props() {
  const { world } = useScene();
  return (
    <group>
      {world.def.props.map((p, i) => {
        const [x, , z] = toScene(world, p.cell[0], p.cell[1]);
        const [fx, fy] = propFront(world, p);
        return (
          <group key={i} position={[x, cellTop(world, p.cell[0], p.cell[1]), z]} rotation={[0, yawFor(fx, fy), 0]}>
            <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial map={blobShadowTexture()} transparent opacity={0.5} depthWrite={false} />
            </mesh>
            <PropModel kind={p.kind} seed={i} />
          </group>
        );
      })}
    </group>
  );
});

/** Face away from adjacent walls, towards open floor (S, E, N, W preference). */
function propFront(world: ReturnType<typeof useScene>['world'], p: Prop): [number, number] {
  const [px, py] = p.cell;
  for (const [dx, dy] of [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ] as const) {
    if (isWall(world, px - dx, py - dy) && !isWall(world, px + dx, py + dy)) return [dx, dy];
  }
  return [0, 1];
}

function PropModel({ kind, seed }: { kind: Prop['kind']; seed: number }) {
  const accent = seed % 2 ? PALETTE.purple : PALETTE.cyan;
  switch (kind) {
    case 'rack':
      return (
        <group>
          <mesh position={[0, 0.62, 0]}>
            <boxGeometry args={[0.62, 1.24, 0.52]} />
            <meshStandardMaterial color={PALETTE.metalDark} roughness={0.5} metalness={0.6} />
          </mesh>
          <mesh position={[0, 1.26, 0]}>
            <boxGeometry args={[0.66, 0.05, 0.56]} />
            <meshStandardMaterial color={PALETTE.metalLight} roughness={0.4} metalness={0.6} />
          </mesh>
          {[0.3, 0.52, 0.74, 0.96].map((y, i) => (
            <group key={y} position={[0, y, 0.262]}>
              <mesh>
                <planeGeometry args={[0.5, 0.15]} />
                <meshStandardMaterial color="#0d1422" roughness={0.6} />
              </mesh>
              <mesh position={[-0.16, 0, 0.002]}>
                <planeGeometry args={[0.1, 0.025]} />
                <meshBasicMaterial color={glow(i % 2 ? accent : PALETTE.ok, 1.6)} toneMapped={false} />
              </mesh>
              <mesh position={[0.12, 0, 0.002]}>
                <planeGeometry args={[0.18, 0.02]} />
                <meshBasicMaterial color={glow(accent, 1.1)} toneMapped={false} />
              </mesh>
            </group>
          ))}
        </group>
      );
    case 'console':
      return (
        <group>
          <mesh position={[0, 0.3, -0.05]}>
            <boxGeometry args={[0.72, 0.6, 0.42]} />
            <meshStandardMaterial color={PALETTE.metal} roughness={0.45} metalness={0.55} />
          </mesh>
          <mesh position={[0, 0.66, -0.12]} rotation={[-0.5, 0, 0]}>
            <boxGeometry args={[0.66, 0.36, 0.05]} />
            <meshStandardMaterial color={PALETTE.metalDark} roughness={0.4} metalness={0.5} />
          </mesh>
          <mesh position={[0, 0.67, -0.094]} rotation={[-0.5, 0, 0]}>
            <planeGeometry args={[0.58, 0.28]} />
            <meshBasicMaterial color={glow(PALETTE.cyan, 1.1)} toneMapped={false} />
          </mesh>
        </group>
      );
    case 'crate':
      return (
        <group>
          <mesh position={[0, 0.24, 0]}>
            <boxGeometry args={[0.6, 0.48, 0.6]} />
            <meshStandardMaterial color="#3b3326" roughness={0.75} metalness={0.2} />
          </mesh>
          <mesh position={[0.06, 0.62, -0.04]} rotation={[0, 0.35, 0]}>
            <boxGeometry args={[0.38, 0.28, 0.38]} />
            <meshStandardMaterial color="#4a3f2c" roughness={0.75} metalness={0.2} />
          </mesh>
          <mesh position={[0, 0.3, 0.302]}>
            <planeGeometry args={[0.5, 0.05]} />
            <meshBasicMaterial color={glow(PALETTE.amber, 1.5)} toneMapped={false} />
          </mesh>
        </group>
      );
    case 'plant':
      return (
        <group>
          <mesh position={[0, 0.15, 0]}>
            <cylinderGeometry args={[0.2, 0.16, 0.3, 16]} />
            <meshStandardMaterial color={PALETTE.metalLight} roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.3, 0]}>
            <torusGeometry args={[0.19, 0.015, 6, 24]} />
            <meshBasicMaterial color={glow(accent, 1.4)} toneMapped={false} />
          </mesh>
          {[
            [0, 0.5, 0, 0.2],
            [0.1, 0.42, 0.06, 0.15],
            [-0.09, 0.45, -0.05, 0.14],
            [0.02, 0.66, -0.02, 0.12],
          ].map(([px, py, pz, r], i) => (
            <mesh key={i} position={[px!, py!, pz!]}>
              <icosahedronGeometry args={[r!, 0]} />
              <meshStandardMaterial color={i % 2 ? '#15803d' : '#22c55e'} roughness={0.6} flatShading />
            </mesh>
          ))}
        </group>
      );
    case 'lamp':
      return (
        <group>
          <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.8, 1.8]} />
            <meshBasicMaterial map={glowTexture()} color={PALETTE.amber} transparent opacity={0.35} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0.04, 0]}>
            <cylinderGeometry args={[0.16, 0.18, 0.08, 16]} />
            <meshStandardMaterial color={PALETTE.metalDark} roughness={0.5} metalness={0.6} />
          </mesh>
          <mesh position={[0, 0.55, 0]}>
            <cylinderGeometry args={[0.025, 0.025, 1, 8]} />
            <meshStandardMaterial color={PALETTE.metalLight} roughness={0.4} metalness={0.7} />
          </mesh>
          <mesh position={[0, 1.1, 0]}>
            <sphereGeometry args={[0.11, 16, 16]} />
            <meshBasicMaterial color={glow(PALETTE.amber, 2.2)} toneMapped={false} />
          </mesh>
          <mesh position={[0, 1.18, 0]}>
            <cylinderGeometry args={[0.06, 0.16, 0.08, 16]} />
            <meshStandardMaterial color={PALETTE.metal} roughness={0.4} metalness={0.6} />
          </mesh>
        </group>
      );
  }
}
