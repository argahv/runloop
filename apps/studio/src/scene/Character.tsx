'use client';
import { RoundedBox } from '@react-three/drei';
import { flushSync, useFrame, type ThreeEvent } from '@react-three/fiber';
import type { RunState } from '@runloop-world/replay';
import type { PresentationState } from '@runloop-world/world-engine';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Color, MathUtils, MeshBasicMaterial, type Group, type Mesh, type Vector3 } from 'three';
import { identityColor } from '../state/identity';
import { badgeDetail, compactDetail, presetIcon, usageLine } from './badges';
import { poseAt, useScene } from './context';
import { useLabel } from './labels';
import { ROBOT_HEIGHT, heightAt, toScene, yawForHeading } from './layout';
import { identityHex, mix, mixHex, stateGlow, type ScenePalette } from './palette';
import { blobShadowTexture } from './textures';

/** Model height (feet to antenna tip, model units); the model is scaled to ROBOT_HEIGHT scene units. */
const MODEL_H = 1.1;
const SCALE = ROBOT_HEIGHT / MODEL_H;
/** Badges sit just above the antenna. */
const BADGE_Y = ROBOT_HEIGHT + 0.05;
/** States in which a robot is not facing a task: it turns towards the camera (south-east). */
const FACES_VIEWER: ReadonlySet<PresentationState> = new Set(['idle', 'succeeded', 'failed']);
const VIEWER_YAW = Math.PI / 4;

interface View {
  state: PresentationState;
  detail: string;
  short: string;
  usage: string | null;
  /** A finished subagent: kept in place, quieter. */
  dim: boolean;
}

function viewOf(state: PresentationState, agentId: string, run: RunState, world: Parameters<typeof badgeDetail>[3]): View {
  return {
    state,
    detail: badgeDetail(state, agentId, run, world),
    short: compactDetail(state, agentId, run),
    usage: usageLine(run, agentId),
    dim: run.exec.agents[agentId]?.state === 'done' && run.exec.run.status === 'running',
  };
}

const sameView = (a: View, b: View) => a.state === b.state && a.detail === b.detail && a.short === b.short && a.usage === b.usage && a.dim === b.dim;

/** The floor ring under a robot: what state it is in (semantic colour; lime only while working). */
function ringFor(p: ScenePalette, state: PresentationState, walking: boolean): Color | null {
  if (walking) return null;
  switch (state) {
    case 'working':
      return stateGlow(p, p.active, 1.6);
    case 'failed':
      return stateGlow(p, p.failure, 1.5);
    case 'awaiting_approval':
    case 'waiting':
      return stateGlow(p, p.warning, 1.3);
    case 'succeeded':
      return stateGlow(p, p.success, 1.4);
    default:
      return null;
  }
}

/** Eye colour on the dark visor: the eyes carry state (their shape too), so they may glow. */
function eyeColor(p: ScenePalette, state: PresentationState, dim: boolean): Color {
  const e = p.eyes;
  // On the dark visor the dark-theme values always read; they glow (and bloom) only where glow is allowed.
  const glow = (c: string, k: number) => new Color(c).multiplyScalar(p.glow ? k : 1);
  if (dim || state === 'paused') return new Color(e.off);
  switch (state) {
    case 'working':
      return glow(e.active, 1.7);
    case 'failed':
      return glow(e.failure, 1.8);
    case 'awaiting_approval':
    case 'waiting':
      return glow(e.warning, 1.6);
    case 'succeeded':
      return glow(e.success, 1.6);
    default:
      return glow(e.idle, 1.25);
  }
}

/**
 * One character. Where it is and what state it shows come only from Layer 2
 * (presentationAt at the frame's tick); bobbing, typing and blinking are
 * Layer-3 decoration on top. Its colour is the agent's identity hue (the same
 * token the timeline and Network view use). Re-renders only when the badge changes.
 */
export const Character = memo(function Character({
  agentId,
  selected,
  onSelect,
}: {
  agentId: string;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const { world, getFrame, reducedMotion, palette, labels } = useScene();
  const info = useMemo(() => {
    const frame = getFrame();
    const c = frame.state.world.characters[agentId];
    const preset = (c && world.presetsById[c.presetId]) || world.presetsById[world.def.defaultPreset]!;
    const exec = frame.state.exec;
    const name = exec.agents[agentId]?.name ?? agentId;
    // Per-agent phase so blinks and bobs are not in lockstep.
    let phase = 0;
    for (const ch of agentId) phase = (phase * 31 + ch.charCodeAt(0)) % 997;
    return { preset, name, hex: identityHex(palette, exec, agentId), css: identityColor(exec, agentId), phase: (phase / 997) * Math.PI * 2 };
  }, [agentId, getFrame, world, palette]);
  const color = info.hex;

  const [view, setView] = useState<View>(() => {
    const frame = getFrame();
    const pose = poseAt(world, frame, agentId);
    return viewOf(pose?.state ?? 'idle', agentId, frame.state, world);
  });
  const viewRef = useRef(view);
  viewRef.current = view;

  const root = useRef<Group>(null);
  const bounce = useRef<Group>(null);
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const eyes = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const legL = useRef<Group>(null);
  const legR = useRef<Group>(null);
  const shadow = useRef<Mesh>(null);
  const select = useRef<Mesh>(null);
  const stateRing = useRef<Mesh>(null);
  const stateMat = useMemo(() => new MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.95 }), []);
  const dots = useRef<(Mesh | null)[]>([]);
  const yaw = useRef<number | null>(null);
  const ringState = useRef<string>('');

  // One shared material for every eye shape; its colour follows the state.
  const eyeMat = useMemo(() => new MeshBasicMaterial({ toneMapped: false }), []);
  useEffect(
    () => () => {
      eyeMat.dispose();
      stateMat.dispose();
    },
    [eyeMat, stateMat],
  );
  useLayoutEffect(() => {
    eyeMat.color.copy(eyeColor(palette, view.state, view.dim));
  }, [eyeMat, view.state, view.dim, palette]);

  useFrame(({ clock }, dt) => {
    const frame = getFrame();
    const pose = poseAt(world, frame, agentId);
    const g = root.current;
    if (!pose || !g) return;

    // Layer 2: position + heading.
    const [x, , z] = toScene(world, pose.x, pose.y);
    g.position.set(x, heightAt(world, pose.x, pose.y), z);
    // Walking and working follow the Layer-2 heading; a robot standing at rest turns to the viewer (presentation only).
    const targetYaw = !pose.moving && FACES_VIEWER.has(pose.state) ? VIEWER_YAW : yawForHeading(pose.heading);
    if (yaw.current === null || reducedMotion) yaw.current = targetYaw;
    else {
      const diff = Math.atan2(Math.sin(targetYaw - yaw.current), Math.cos(targetYaw - yaw.current));
      yaw.current += diff * (1 - Math.exp(-dt * 14));
    }
    g.rotation.y = yaw.current;

    // React only hears about badge changes. They are rare, so commit them
    // synchronously: the badge then paints in the same frame as this pose.
    const next = viewOf(pose.state, agentId, frame.state, world);
    if (!sameView(next, viewRef.current)) {
      viewRef.current = next;
      flushSync(() => setView(next));
    }

    const walking = pose.moving && frame.advancing;
    // State ring (only its colour/visibility changes; a quiet breath while working).
    const rk = `${pose.state}|${walking}`;
    if (rk !== ringState.current) {
      ringState.current = rk;
      const c = ringFor(palette, pose.state, walking);
      if (stateRing.current) stateRing.current.visible = c !== null;
      if (c) stateMat.color.copy(c);
    }
    if (pose.state === 'working' && !walking && !reducedMotion) stateMat.opacity = 0.75 + 0.2 * Math.sin(clock.elapsedTime * 4 + info.phase);
    else stateMat.opacity = 0.95;

    // Layer 3 decoration.
    const t = clock.elapsedTime + info.phase;
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 16);
    animate(pose.state, walking, t, k, reducedMotion);
    if (select.current) select.current.rotation.z = reducedMotion ? 0 : clock.elapsedTime * 0.6;
  });

  function animate(state: PresentationState, walking: boolean, t: number, k: number, still: boolean) {
    const b = body.current;
    const h = head.current;
    const aL = armL.current;
    const aR = armR.current;
    const lL = legL.current;
    const lR = legR.current;
    const bo = bounce.current;
    if (!b || !h || !aL || !aR || !lL || !lR || !bo) return;
    // Targets (defaults = relaxed standing pose).
    let bodyY = 0;
    let bodyTiltZ = 0;
    let bodyTiltX = 0;
    let headX = 0;
    let headY = 0;
    let headZ = 0;
    let armLX = 0;
    let armRX = 0;
    let legLX = 0;
    let legRX = 0;
    let hop = 0;
    let blink = 1;
    const loop = !still;

    if (walking && loop) {
      const c = t * 11;
      legLX = Math.sin(c) * 0.6;
      legRX = -legLX;
      armLX = -Math.sin(c) * 0.55;
      armRX = -armLX;
      bodyY = Math.abs(Math.sin(c)) * 0.035;
      bodyTiltZ = Math.sin(c) * 0.04;
      bodyTiltX = 0.06;
    } else {
      switch (state) {
        case 'working':
          armLX = -1.05 + (loop ? Math.sin(t * 16) * 0.2 : 0);
          armRX = -1.05 + (loop ? Math.sin(t * 16 + Math.PI) * 0.2 : 0);
          headX = 0.14 + (loop ? Math.sin(t * 4) * 0.035 : 0);
          bodyTiltX = 0.07;
          break;
        case 'succeeded':
          hop = loop ? Math.max(0, Math.sin(t * 7)) * 0.1 : 0;
          armLX = -2.5 + (loop ? Math.sin(t * 7) * 0.25 : 0);
          armRX = armLX;
          headX = -0.12;
          break;
        case 'failed':
          bodyTiltZ = 0.22;
          headX = 0.32;
          headZ = 0.14;
          armLX = 0.12;
          armRX = 0.12;
          break;
        case 'waiting':
          armLX = -0.45;
          armRX = -0.45;
          headZ = loop ? Math.sin(t * 1.2) * 0.08 : 0.06;
          break;
        case 'awaiting_approval':
          headZ = 0.2 + (loop ? Math.sin(t * 1.5) * 0.04 : 0);
          armRX = -2.6;
          break;
        case 'paused':
          headX = 0.08;
          break;
        default:
          // Idle stays restrained: a slow glance and an occasional blink.
          if (loop) {
            headY = Math.sin(t * 0.5) * 0.12;
            blink = t % 4.3 < 0.12 ? 0.12 : 1;
          }
      }
    }
    const L = MathUtils.lerp;
    b.position.y = L(b.position.y, bodyY, k);
    b.rotation.z = L(b.rotation.z, bodyTiltZ, k);
    b.rotation.x = L(b.rotation.x, bodyTiltX, k);
    h.rotation.x = L(h.rotation.x, headX, k);
    h.rotation.y = L(h.rotation.y, headY, k);
    h.rotation.z = L(h.rotation.z, headZ, k);
    aL.rotation.x = L(aL.rotation.x, armLX, k);
    aR.rotation.x = L(aR.rotation.x, armRX, k);
    lL.rotation.x = L(lL.rotation.x, legLX, k);
    lR.rotation.x = L(lR.rotation.x, legRX, k);
    bo.position.y = hop;
    if (shadow.current) shadow.current.scale.setScalar(1 - hop * 1.6);
    if (eyes.current) eyes.current.scale.y = blink;
    dots.current.forEach((d, i) => {
      if (d) d.scale.setScalar(loop ? 0.7 + 0.5 * Math.max(0, Math.sin(t * 5 - i * 0.9)) : 1);
    });
  }

  // Badge: follows the Layer-2 position (evaluated by the label projector each frame).
  const anchor = useMemo(
    () => (out: Vector3) => {
      const pose = poseAt(world, getFrame(), agentId);
      if (!pose) return null;
      const [x, , z] = toScene(world, pose.x, pose.y);
      return out.set(x, heightAt(world, pose.x, pose.y) + BADGE_Y, z);
    },
    [world, getFrame, agentId],
  );
  useLabel(
    `agent:${agentId}`,
    {
      kind: 'agent',
      agentId,
      name: info.name,
      color: info.css,
      icon: presetIcon(info.preset.icon),
      state: view.state,
      detail: view.detail,
      short: view.short,
      usage: view.usage,
      selected,
      dim: view.dim,
    },
    anchor,
  );

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(agentId);
  };
  const shell = view.dim ? mixHex(palette.robotShell, palette.muted, 0.45) : palette.robotShell;
  // Identity hue: body, visor rim, ear pods and antenna tip (identity never signals state).
  const accent = useMemo(() => (view.dim ? mix(color, palette.muted, 0.6) : new Color(color)), [color, palette, view.dim]);
  const rim = useMemo(() => (view.dim ? mix(color, palette.muted, 0.6) : mix(color, '#ffffff', palette.theme === 'light' ? 0 : 0.12)), [color, palette, view.dim]);
  const light = palette.theme === 'light';

  return (
    <group ref={root}>
      <mesh ref={shadow} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[1.15, 1.15]} />
        <meshBasicMaterial map={blobShadowTexture()} transparent opacity={light ? 0.32 : 0.75} depthWrite={false} />
      </mesh>
      <mesh ref={stateRing} position={[0, 0.016, 0]} rotation={[-Math.PI / 2, 0, 0]} material={stateMat} visible={false}>
        <ringGeometry args={[0.5, 0.58, 48]} />
      </mesh>
      {selected && (
        <mesh ref={select} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.66, 0.72, 6]} />
          <meshBasicMaterial color={palette.ice} transparent opacity={0.95} />
        </mesh>
      )}
      <group
        scale={SCALE}
        onClick={onClick}
        onPointerOver={(e) => {
          e.stopPropagation();
          labels.hovered = `agent:${agentId}`;
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          if (labels.hovered === `agent:${agentId}`) labels.hovered = null;
          document.body.style.cursor = '';
        }}
      >
        {/* Invisible, generous hit box for clicking. */}
        <mesh position={[0, 0.52, 0]} visible={false}>
          <boxGeometry args={[0.72, 1.08, 0.62]} />
        </mesh>
        <group ref={bounce}>
          {/* Stub legs */}
          {[-1, 1].map((side) => (
            <group key={side} ref={side < 0 ? legL : legR} position={[side * 0.075, 0.13, 0]}>
              <mesh position={[0, -0.06, 0.005]}>
                <capsuleGeometry args={[0.052, 0.05, 4, 10]} />
                <meshStandardMaterial color={palette.robotJoint} roughness={0.4} metalness={0.35} />
              </mesh>
            </group>
          ))}
          <group ref={body}>
            {/* Small body in the identity hue, with a light chest plate */}
            <RoundedBox args={[0.3, 0.25, 0.24]} radius={0.09} smoothness={4} position={[0, 0.25, 0]}>
              <meshStandardMaterial color={accent} roughness={0.32} metalness={0.05} />
            </RoundedBox>
            <RoundedBox args={[0.16, 0.1, 0.02]} radius={0.01} smoothness={2} position={[0, 0.26, 0.12]}>
              <meshStandardMaterial color={shell} roughness={0.3} metalness={0.05} />
            </RoundedBox>
            {/* Stub arms */}
            {[-1, 1].map((side) => (
              <group key={side} ref={side < 0 ? armL : armR} position={[side * 0.18, 0.33, 0]}>
                <group rotation={[0, 0, side * 0.2]}>
                  <mesh position={[0, -0.06, 0]}>
                    <capsuleGeometry args={[0.046, 0.06, 4, 10]} />
                    <meshStandardMaterial color={shell} roughness={0.28} metalness={0.02} />
                  </mesh>
                  <mesh position={[0, -0.13, 0]}>
                    <sphereGeometry args={[0.044, 12, 12]} />
                    <meshStandardMaterial color={palette.robotJoint} roughness={0.4} metalness={0.35} />
                  </mesh>
                </group>
              </group>
            ))}
            <mesh position={[0, 0.39, 0]}>
              <cylinderGeometry args={[0.045, 0.055, 0.05, 12]} />
              <meshStandardMaterial color={palette.robotJoint} roughness={0.4} metalness={0.4} />
            </mesh>
            {/* Oversized glossy head */}
            <group ref={head} position={[0, 0.665, 0]}>
              <RoundedBox args={[0.66, 0.52, 0.54]} radius={0.19} smoothness={5}>
                <meshPhysicalMaterial color={shell} roughness={0.2} metalness={0.02} clearcoat={1} clearcoatRoughness={0.08} />
              </RoundedBox>
              {/* Visor rim in the identity hue, then the dark glass visor (pokes through the rounded front so it reads from the side). */}
              <RoundedBox args={[0.6, 0.4, 0.3]} radius={0.13} smoothness={4} position={[0, -0.015, 0.124]}>
                <meshStandardMaterial color={rim} roughness={0.35} metalness={0.1} />
              </RoundedBox>
              <RoundedBox args={[0.52, 0.315, 0.3]} radius={0.1} smoothness={4} position={[0, -0.015, 0.136]}>
                <meshPhysicalMaterial color={palette.visor} roughness={0.08} metalness={0.3} clearcoat={1} clearcoatRoughness={0.05} />
              </RoundedBox>
              <group ref={eyes} position={[0, -0.015, 0.287]}>
                <Eyes state={view.state} mat={eyeMat} dots={dots} />
              </group>
              {/* Ear pods */}
              {[-1, 1].map((side) => (
                <mesh key={side} position={[side * 0.335, -0.02, -0.03]} rotation={[0, 0, Math.PI / 2]}>
                  <cylinderGeometry args={[0.07, 0.07, 0.05, 20]} />
                  <meshStandardMaterial color={accent} roughness={0.35} metalness={0.15} />
                </mesh>
              ))}
              {/* Antenna, its tip in the identity hue */}
              <mesh position={[0, 0.31, 0]}>
                <cylinderGeometry args={[0.012, 0.016, 0.12, 8]} />
                <meshStandardMaterial color={palette.robotJoint} roughness={0.4} metalness={0.5} />
              </mesh>
              <mesh position={[0, 0.385, 0]}>
                <sphereGeometry args={[0.05, 16, 16]} />
                <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={light ? 0 : 0.35} roughness={0.3} metalness={0.1} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
});

/** Eye shapes per presentation state (state carried by shape and colour). */
function Eyes({
  state,
  mat,
  dots,
}: {
  state: PresentationState;
  mat: MeshBasicMaterial;
  dots: React.RefObject<(Mesh | null)[]>;
}) {
  switch (state) {
    case 'working':
      // Focus slits.
      return (
        <>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.115, 0, 0]} rotation={[0, 0, s * 0.16]} material={mat}>
              <boxGeometry args={[0.13, 0.03, 0.01]} />
            </mesh>
          ))}
        </>
      );
    case 'succeeded':
      // Happy arcs ^ ^.
      return (
        <>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.115, -0.02, 0]} material={mat}>
              <torusGeometry args={[0.05, 0.018, 6, 16, Math.PI]} />
            </mesh>
          ))}
        </>
      );
    case 'failed':
      // X X.
      return (
        <>
          {[-1, 1].map((s) =>
            [1, -1].map((r) => (
              <mesh key={`${s}${r}`} position={[s * 0.115, 0, 0]} rotation={[0, 0, (r * Math.PI) / 4]} material={mat}>
                <boxGeometry args={[0.12, 0.028, 0.01]} />
              </mesh>
            )),
          )}
        </>
      );
    case 'waiting':
      // "..."
      return (
        <>
          {[-1, 0, 1].map((s, i) => (
            <mesh
              key={s}
              ref={(m) => {
                dots.current[i] = m;
              }}
              position={[s * 0.095, -0.01, 0]}
              material={mat}
            >
              <sphereGeometry args={[0.028, 10, 10]} />
            </mesh>
          ))}
        </>
      );
    case 'awaiting_approval':
      // "?"
      return (
        <group position={[0, 0.03, 0]}>
          <mesh rotation={[0, 0, -Math.PI / 2]} material={mat}>
            <torusGeometry args={[0.042, 0.016, 6, 18, Math.PI * 1.5]} />
          </mesh>
          <mesh position={[0, -0.062, 0]} material={mat}>
            <boxGeometry args={[0.028, 0.04, 0.01]} />
          </mesh>
          <mesh position={[0, -0.11, 0]} material={mat}>
            <sphereGeometry args={[0.018, 8, 8]} />
          </mesh>
        </group>
      );
    default:
      // idle / moving / paused: round pill eyes (dim when paused).
      return (
        <>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.115, 0, 0]} material={mat}>
              <capsuleGeometry args={[0.036, 0.06, 4, 10]} />
            </mesh>
          ))}
        </>
      );
  }
}
