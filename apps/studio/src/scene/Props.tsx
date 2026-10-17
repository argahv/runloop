'use client';
import type { Prop } from '@runloop-world/world-engine';
import { memo, useMemo } from 'react';
import { useScene } from './context';
import { cellTop, isWall, toScene, yawFor } from './layout';
import { desaturate, mixHex, type ScenePalette } from './palette';
import { blobShadowTexture } from './textures';

/** Decorative props from the world definition: simple primitives in the architecture's tones, never glowing. */
export const Props = memo(function Props() {
  const { world, palette } = useScene();
  const tones = useMemo(() => propTones(palette), [palette]);
  return (
    <group>
      {world.def.props.map((p, i) => {
        const [x, , z] = toScene(world, p.cell[0], p.cell[1]);
        const [fx, fy] = propFront(world, p);
        return (
          <group key={i} position={[x, cellTop(world, p.cell[0], p.cell[1]), z]} rotation={[0, yawFor(fx, fy), 0]}>
            <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial map={blobShadowTexture()} transparent opacity={palette.theme === 'light' ? 0.22 : 0.45} depthWrite={false} />
            </mesh>
            <PropModel kind={p.kind} t={tones} />
          </group>
        );
      })}
    </group>
  );
});

interface Tones {
  dark: string;
  body: string;
  light: string;
  face: string;
  detail: string;
  leaf: string;
  leafDark: string;
  wood: string;
  woodDark: string;
}

function propTones(p: ScenePalette): Tones {
  return {
    dark: p.metalDark,
    body: p.metal,
    light: p.metalLight,
    face: p.screenOff,
    detail: mixHex(p.metal, p.muted, 0.5),
    leaf: desaturate(mixHex(p.metal, p.success, 0.5), 0.55),
    leafDark: desaturate(mixHex(p.metalDark, p.success, 0.4), 0.55),
    wood: desaturate(mixHex(p.metal, p.warning, 0.28), 0.5),
    woodDark: desaturate(mixHex(p.metalDark, p.warning, 0.22), 0.5),
  };
}

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

function PropModel({ kind, t }: { kind: Prop['kind']; t: Tones }) {
  switch (kind) {
    case 'rack':
      return (
        <group>
          <mesh position={[0, 0.62, 0]}>
            <boxGeometry args={[0.62, 1.24, 0.52]} />
            <meshStandardMaterial color={t.dark} roughness={0.55} metalness={0.4} />
          </mesh>
          <mesh position={[0, 1.26, 0]}>
            <boxGeometry args={[0.66, 0.04, 0.56]} />
            <meshStandardMaterial color={t.light} roughness={0.45} metalness={0.4} />
          </mesh>
          {[0.3, 0.52, 0.74, 0.96].map((y) => (
            <group key={y} position={[0, y, 0.262]}>
              <mesh>
                <planeGeometry args={[0.5, 0.15]} />
                <meshStandardMaterial color={t.face} roughness={0.6} />
              </mesh>
              <mesh position={[0.1, 0, 0.002]}>
                <planeGeometry args={[0.22, 0.018]} />
                <meshBasicMaterial color={t.detail} />
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
            <meshStandardMaterial color={t.body} roughness={0.5} metalness={0.35} />
          </mesh>
          <mesh position={[0, 0.66, -0.12]} rotation={[-0.5, 0, 0]}>
            <boxGeometry args={[0.66, 0.36, 0.05]} />
            <meshStandardMaterial color={t.dark} roughness={0.45} metalness={0.35} />
          </mesh>
          <mesh position={[0, 0.67, -0.094]} rotation={[-0.5, 0, 0]}>
            <planeGeometry args={[0.58, 0.28]} />
            <meshStandardMaterial color={t.face} roughness={0.2} metalness={0.2} />
          </mesh>
        </group>
      );
    case 'crate':
      return (
        <group>
          <mesh position={[0, 0.24, 0]}>
            <boxGeometry args={[0.6, 0.48, 0.6]} />
            <meshStandardMaterial color={t.wood} roughness={0.8} metalness={0.05} />
          </mesh>
          <mesh position={[0.06, 0.62, -0.04]} rotation={[0, 0.35, 0]}>
            <boxGeometry args={[0.38, 0.28, 0.38]} />
            <meshStandardMaterial color={t.woodDark} roughness={0.8} metalness={0.05} />
          </mesh>
        </group>
      );
    case 'plant':
      return (
        <group>
          <mesh position={[0, 0.15, 0]}>
            <cylinderGeometry args={[0.2, 0.16, 0.3, 20]} />
            <meshStandardMaterial color={t.light} roughness={0.55} metalness={0.25} />
          </mesh>
          {[
            [0, 0.5, 0, 0.2],
            [0.1, 0.42, 0.06, 0.15],
            [-0.09, 0.45, -0.05, 0.14],
            [0.02, 0.66, -0.02, 0.12],
          ].map(([px, py, pz, r], i) => (
            <mesh key={i} position={[px!, py!, pz!]}>
              <icosahedronGeometry args={[r!, 0]} />
              <meshStandardMaterial color={i % 2 ? t.leafDark : t.leaf} roughness={0.7} flatShading />
            </mesh>
          ))}
        </group>
      );
    case 'lamp':
      return (
        <group>
          <mesh position={[0, 0.04, 0]}>
            <cylinderGeometry args={[0.16, 0.18, 0.08, 16]} />
            <meshStandardMaterial color={t.dark} roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.55, 0]}>
            <cylinderGeometry args={[0.022, 0.022, 1, 8]} />
            <meshStandardMaterial color={t.light} roughness={0.4} metalness={0.5} />
          </mesh>
          <mesh position={[0, 1.1, 0]}>
            <sphereGeometry args={[0.1, 16, 16]} />
            <meshStandardMaterial color={t.light} roughness={0.3} metalness={0.1} />
          </mesh>
        </group>
      );
  }
}
