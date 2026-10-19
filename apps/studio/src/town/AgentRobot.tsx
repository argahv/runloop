'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  TorusGeometry,
  type Group,
  type Mesh,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DARK_TOKENS } from '../scene/palette';
import { blobShadowTexture } from '../scene/textures';
import type { RobotState } from './status';

/**
 * A real agent in the town: the Studio's chibi robot (scene/Character.tsx:
 * glossy oversized head, dark visor, eyes that carry state, identity hue on
 * the body, ear pods and antenna tip), rebuilt as three merged meshes so up to
 * 12 fit the town's draw-call budget. Residents never look like this.
 *
 * Eyes follow the agent's reported state (shape and colour); lime appears
 * only while it is working. Identity hue never signals state.
 */

/** Robot height in town units (the diorama's robot at 0.5 scale). */
export const ROBOT_TOWN_HEIGHT = 1.1;

const SHELL = '#f3f5f8';
const JOINT = '#7d838f';
const VISOR = '#0d0e11';

let shared: { body: BufferGeometry; bodyHue: BufferGeometry; head: BufferGeometry; headHue: BufferGeometry; eyes: Record<string, BufferGeometry> } | null = null;

function colored(g: BufferGeometry, m: Matrix4, hex: string): BufferGeometry {
  const out = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
  out.deleteAttribute('uv');
  const c = new Color(hex);
  const n = out.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  out.setAttribute('color', new BufferAttribute(col, 3));
  return out;
}

/** Head parts are modelled around the neck pivot (y = 0.665), so the head group can tilt. */
const HEAD_Y = 0.665;
const at = (x: number, y: number, z: number, rz = 0) => new Matrix4().makeRotationZ(rz).setPosition(x, y, z);
const ath = (x: number, y: number, z: number, rz = 0) => at(x, y - HEAD_Y, z, rz);

function geometries() {
  if (shared) return shared;
  const body = mergeGeometries([
    colored(new CapsuleGeometry(0.052, 0.05, 3, 8), at(-0.075, 0.07, 0.005), JOINT),
    colored(new CapsuleGeometry(0.052, 0.05, 3, 8), at(0.075, 0.07, 0.005), JOINT),
    colored(new RoundedBoxGeometry(0.16, 0.1, 0.02, 1, 0.01), at(0, 0.26, 0.12), SHELL),
    colored(new CapsuleGeometry(0.046, 0.06, 3, 8), at(-0.19, 0.27, 0, -0.2), SHELL),
    colored(new CapsuleGeometry(0.046, 0.06, 3, 8), at(0.19, 0.27, 0, 0.2), SHELL),
    colored(new SphereGeometry(0.044, 8, 6), at(-0.205, 0.2, 0), JOINT),
    colored(new SphereGeometry(0.044, 8, 6), at(0.205, 0.2, 0), JOINT),
    colored(new CylinderGeometry(0.045, 0.055, 0.05, 10), at(0, 0.39, 0), JOINT),
  ])!;
  const bodyHue = colored(new RoundedBoxGeometry(0.3, 0.25, 0.24, 2, 0.09), at(0, 0.25, 0), '#ffffff');
  const head = mergeGeometries([
    colored(new RoundedBoxGeometry(0.66, 0.52, 0.54, 3, 0.19), ath(0, 0.665, 0), SHELL),
    colored(new RoundedBoxGeometry(0.52, 0.315, 0.3, 2, 0.1), ath(0, 0.65, 0.136), VISOR),
    colored(new CylinderGeometry(0.012, 0.016, 0.12, 6), ath(0, 0.975, 0), JOINT),
  ])!;
  const headHue = mergeGeometries([
    colored(new RoundedBoxGeometry(0.6, 0.4, 0.3, 2, 0.13), ath(0, 0.65, 0.124), '#ffffff'),
    colored(new CylinderGeometry(0.07, 0.07, 0.05, 14), ath(-0.335, 0.645, -0.03, Math.PI / 2), '#ffffff'),
    colored(new CylinderGeometry(0.07, 0.07, 0.05, 14), ath(0.335, 0.645, -0.03, Math.PI / 2), '#ffffff'),
    colored(new SphereGeometry(0.05, 10, 8), ath(0, 1.05, 0), '#ffffff'),
  ])!;
  // Eye shapes per state, at the visor's front.
  const z = 0.29;
  const pair = (g: () => BufferGeometry, y = 0.65, rz = 0) =>
    mergeGeometries([colored(g(), ath(-0.115, y, z, rz), '#ffffff'), colored(g(), ath(0.115, y, z, -rz), '#ffffff')])!;
  const eyes: Record<string, BufferGeometry> = {
    idle: pair(() => new CapsuleGeometry(0.036, 0.06, 3, 8)),
    working: pair(() => new BoxGeometry(0.13, 0.03, 0.01), 0.65, 0.16),
    waiting: mergeGeometries([-1, 0, 1].map((s) => colored(new SphereGeometry(0.028, 8, 6), ath(s * 0.095, 0.64, z), '#ffffff')))!,
    awaiting_approval: mergeGeometries([
      colored(new TorusGeometry(0.042, 0.016, 6, 14, Math.PI * 1.5), ath(0, 0.68, z, -Math.PI / 2), '#ffffff'),
      colored(new BoxGeometry(0.028, 0.04, 0.01), ath(0, 0.618, z), '#ffffff'),
      colored(new SphereGeometry(0.018, 6, 6), ath(0, 0.57, z), '#ffffff'),
    ])!,
    failed: mergeGeometries([
      colored(new BoxGeometry(0.12, 0.028, 0.01), ath(-0.115, 0.65, z, Math.PI / 4), '#ffffff'),
      colored(new BoxGeometry(0.12, 0.028, 0.01), ath(-0.115, 0.65, z, -Math.PI / 4), '#ffffff'),
      colored(new BoxGeometry(0.12, 0.028, 0.01), ath(0.115, 0.65, z, Math.PI / 4), '#ffffff'),
      colored(new BoxGeometry(0.12, 0.028, 0.01), ath(0.115, 0.65, z, -Math.PI / 4), '#ffffff'),
    ])!,
  };
  eyes.off = eyes.idle!;
  shared = { body, bodyHue, head, headHue, eyes };
  return shared;
}

const EYE: Record<RobotState, string> = {
  working: DARK_TOKENS.lime,
  waiting: DARK_TOKENS.warning,
  awaiting_approval: DARK_TOKENS.warning,
  failed: DARK_TOKENS.failure,
  idle: DARK_TOKENS.ice,
  off: '#4b4f58',
};

/** The floor ring: what state the agent is in (semantic colour; lime only while working; none when idle or off). */
const RING: Partial<Record<RobotState, string>> = {
  working: DARK_TOKENS.lime,
  waiting: DARK_TOKENS.warning,
  awaiting_approval: DARK_TOKENS.warning,
  failed: DARK_TOKENS.failure,
};

export const AgentRobot = memo(function AgentRobot({
  hue,
  state,
  selected,
  reducedMotion,
  dim,
}: {
  hue: string;
  state: RobotState;
  selected: boolean;
  reducedMotion: boolean;
  /** Not connected yet, or offline: quieter, desaturated. */
  dim: boolean;
}) {
  const g = geometries();
  // The identity hue is baked into a per-robot copy of the body and head (two draws instead of four).
  const baked = useMemo(() => {
    const tint = dim ? new Color(hue).lerp(new Color('#9297a2'), 0.6) : new Color(hue);
    const paint = (geo: BufferGeometry) => {
      const out = geo.clone();
      const col = out.getAttribute('color');
      for (let i = 0; i < col.count; i++) col.setXYZ(i, tint.r, tint.g, tint.b);
      return out;
    };
    return { body: mergeGeometries([g.body, paint(g.bodyHue)])!, head: mergeGeometries([g.head, paint(g.headHue)])! };
  }, [g, hue, dim]);
  const shell = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), []);
  const eyeMat = useMemo(() => new MeshBasicMaterial({ toneMapped: false }), []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }), []);
  useEffect(() => () => void (baked.body.dispose(), baked.head.dispose()), [baked]);
  useEffect(
    () => () => {
      shell.dispose();
      eyeMat.dispose();
      ringMat.dispose();
    },
    [shell, eyeMat, ringMat],
  );
  useEffect(() => {
    shell.color.set(dim ? '#c9ccd2' : '#ffffff');
    // State colours glow a little (state-carrying elements may).
    eyeMat.color.set(EYE[state]).multiplyScalar(state === 'off' ? 1 : 1.5);
    const ring = RING[state];
    if (ring) ringMat.color.set(ring).multiplyScalar(1.4);
  }, [dim, state, shell, eyeMat, ringMat]);

  const head = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const sel = useRef<Mesh>(null);
  const phase = useMemo(() => {
    let h = 0;
    for (const ch of hue) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return (h / 997) * Math.PI * 2;
  }, [hue]);
  useFrame(({ clock }) => {
    const t = reducedMotion ? 0 : clock.elapsedTime + phase;
    if (head.current) {
      // Restrained: a slow glance while idle, a focused tilt while working, a puzzled tilt while waiting for approval.
      head.current.rotation.y = state === 'idle' ? Math.sin(t * 0.5) * 0.12 : 0;
      head.current.rotation.x = state === 'working' ? 0.14 : state === 'failed' ? 0.3 : 0;
      head.current.rotation.z = state === 'awaiting_approval' ? 0.2 : state === 'failed' ? 0.14 : 0;
    }
    if (ring.current) ringMat.opacity = state === 'working' && !reducedMotion ? 0.75 + 0.2 * Math.sin(t * 4) : 0.95;
    if (sel.current) sel.current.rotation.z = reducedMotion ? 0 : clock.elapsedTime * 0.6;
  });

  return (
    <group>
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[0.95, 0.95]} />
        <meshBasicMaterial map={blobShadowTexture()} transparent opacity={0.45} depthWrite={false} />
      </mesh>
      {RING[state] && (
        <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} material={ringMat} renderOrder={2}>
          <ringGeometry args={[0.42, 0.5, 40]} />
        </mesh>
      )}
      {selected && (
        <mesh ref={sel} position={[0, 0.024, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3}>
          <ringGeometry args={[0.56, 0.62, 6]} />
          <meshBasicMaterial color="#e8ebf0" transparent opacity={0.95} depthWrite={false} />
        </mesh>
      )}
      <mesh geometry={baked.body} material={shell} castShadow />
      <group ref={head} position={[0, HEAD_Y, 0]}>
        <mesh geometry={baked.head} material={shell} castShadow />
        <mesh geometry={g.eyes[state] ?? g.eyes.idle} material={eyeMat} />
      </group>
    </group>
  );
});
