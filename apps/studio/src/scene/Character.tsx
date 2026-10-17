'use client';
import { RoundedBox } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { PresentationState } from '@runloop-world/world-engine';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Color, MathUtils, MeshBasicMaterial, type Group, type Mesh, type Vector3 } from 'three';
import { badgeDetail, presetIcon } from './badges';
import { poseAt, useScene } from './context';
import { useLabel } from './labels';
import { heightAt, toScene, yawForHeading } from './layout';
import { PALETTE, glow, mix } from './palette';
import { blobShadowTexture } from './textures';

/** Model scale: a chibi robot ~1.9 units tall to the antenna tip (1 cell = 1 unit). */
const SCALE = 1.75;
const BADGE_Y = 1.95;

interface View {
  state: PresentationState;
  detail: string;
}

/**
 * One character. Where it is and what state it shows come only from Layer 2
 * (presentationAt at the frame's tick); bobbing, typing and blinking are
 * Layer-3 decoration on top. Re-renders only when the badge text changes.
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
  const { world, getFrame, reducedMotion } = useScene();
  const info = useMemo(() => {
    const frame = getFrame();
    const c = frame.state.world.characters[agentId];
    const preset = (c && world.presetsById[c.presetId]) || world.presetsById[world.def.defaultPreset]!;
    const name = frame.state.exec.agents[agentId]?.name ?? agentId;
    // Per-agent phase so blinks and bobs are not in lockstep.
    let phase = 0;
    for (const ch of agentId) phase = (phase * 31 + ch.charCodeAt(0)) % 997;
    return { preset, name, phase: (phase / 997) * Math.PI * 2 };
  }, [agentId, getFrame, world]);
  const color = info.preset.color;

  const [view, setView] = useState<View>(() => {
    const frame = getFrame();
    const pose = poseAt(world, frame, agentId);
    const state = pose?.state ?? 'idle';
    return { state, detail: badgeDetail(state, agentId, frame.state, world) };
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
  const ring = useRef<Mesh>(null);
  const dots = useRef<(Mesh | null)[]>([]);
  const yaw = useRef<number | null>(null);

  // One shared material for every eye shape; its colour follows the state.
  const eyeMat = useMemo(() => new MeshBasicMaterial({ toneMapped: false }), []);
  useEffect(() => () => eyeMat.dispose(), [eyeMat]);
  useLayoutEffect(() => {
    eyeMat.color.copy(
      view.state === 'failed'
        ? glow(PALETTE.err, 2.2)
        : view.state === 'awaiting_approval'
          ? glow(PALETTE.warn, 2)
          : view.state === 'paused'
            ? new Color(color).multiplyScalar(0.35)
            : glow(mix(color, '#ffffff', 0.35), 1.9),
    );
  }, [eyeMat, view.state, color]);

  useFrame(({ clock }, dt) => {
    const frame = getFrame();
    const pose = poseAt(world, frame, agentId);
    const g = root.current;
    if (!pose || !g) return;

    // Layer 2: position + heading.
    const [x, , z] = toScene(world, pose.x, pose.y);
    g.position.set(x, heightAt(world, pose.x, pose.y), z);
    const targetYaw = yawForHeading(pose.heading);
    if (yaw.current === null || reducedMotion) yaw.current = targetYaw;
    else {
      const diff = Math.atan2(Math.sin(targetYaw - yaw.current), Math.cos(targetYaw - yaw.current));
      yaw.current += diff * (1 - Math.exp(-dt * 14));
    }
    g.rotation.y = yaw.current;

    // React only hears about badge changes.
    const detail = badgeDetail(pose.state, agentId, frame.state, world);
    if (pose.state !== viewRef.current.state || detail !== viewRef.current.detail) {
      viewRef.current = { state: pose.state, detail };
      setView(viewRef.current);
    }

    // Layer 3 decoration.
    const t = clock.elapsedTime + info.phase;
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 16);
    const walking = pose.moving && frame.advancing;
    animate(pose.state, walking, t, k, reducedMotion);
    if (ring.current) ring.current.rotation.z = reducedMotion ? 0 : clock.elapsedTime * 0.8;
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
          hop = loop ? Math.max(0, Math.sin(t * 7)) * 0.13 : 0;
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
          if (loop) {
            bodyY = Math.sin(t * 2) * 0.008;
            headY = Math.sin(t * 0.6) * 0.18;
            blink = (t % 3.7) < 0.12 ? 0.12 : 1;
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
      color,
      icon: presetIcon(info.preset.icon),
      state: view.state,
      detail: view.detail,
      selected,
    },
    anchor,
  );

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(agentId);
  };
  const shell = PALETTE.robotShell;
  const bodyColor = useMemo(() => mix(shell, color, 0.55), [shell, color]);

  return (
    <group ref={root}>
      <mesh ref={shadow} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[0.8, 0.8]} />
        <meshBasicMaterial map={blobShadowTexture()} transparent opacity={0.75} depthWrite={false} />
      </mesh>
      {selected && (
        <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.46, 0.54, 6]} />
          <meshBasicMaterial color={glow(color, 2)} toneMapped={false} transparent opacity={0.95} />
        </mesh>
      )}
      <group
        scale={SCALE}
        onClick={select}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        {/* Invisible, generous hit box for clicking. */}
        <mesh position={[0, 0.5, 0]} visible={false}>
          <boxGeometry args={[0.7, 1.1, 0.6]} />
        </mesh>
        <group ref={bounce}>
          {/* Legs */}
          {[-1, 1].map((side) => (
            <group key={side} ref={side < 0 ? legL : legR} position={[side * 0.075, 0.15, 0]}>
              <mesh position={[0, -0.07, 0]}>
                <capsuleGeometry args={[0.05, 0.06, 4, 10]} />
                <meshStandardMaterial color={PALETTE.robotJoint} roughness={0.4} metalness={0.5} />
              </mesh>
            </group>
          ))}
          <group ref={body}>
            <RoundedBox args={[0.32, 0.25, 0.25]} radius={0.085} smoothness={4} position={[0, 0.28, 0]}>
              <meshStandardMaterial color={bodyColor} roughness={0.35} metalness={0.15} />
            </RoundedBox>
            <mesh position={[0, 0.29, 0.127]}>
              <circleGeometry args={[0.045, 20]} />
              <meshBasicMaterial color={glow(color, 2)} toneMapped={false} />
            </mesh>
            {/* Arms */}
            {[-1, 1].map((side) => (
              <group key={side} ref={side < 0 ? armL : armR} position={[side * 0.185, 0.35, 0]}>
                <group rotation={[0, 0, side * 0.18]}>
                  <mesh position={[0, -0.07, 0]}>
                    <capsuleGeometry args={[0.042, 0.08, 4, 10]} />
                    <meshStandardMaterial color={shell} emissive="#c8d2e6" emissiveIntensity={0.15} roughness={0.3} metalness={0.1} />
                  </mesh>
                  <mesh position={[0, -0.15, 0]}>
                    <sphereGeometry args={[0.05, 12, 12]} />
                    <meshStandardMaterial color={PALETTE.robotJoint} roughness={0.4} metalness={0.5} />
                  </mesh>
                </group>
              </group>
            ))}
            <mesh position={[0, 0.43, 0]}>
              <cylinderGeometry args={[0.05, 0.06, 0.06, 12]} />
              <meshStandardMaterial color={PALETTE.robotJoint} roughness={0.4} metalness={0.5} />
            </mesh>
            {/* Head */}
            <group ref={head} position={[0, 0.66, 0]}>
              <RoundedBox args={[0.6, 0.46, 0.48]} radius={0.17} smoothness={5}>
                <meshPhysicalMaterial
                  color={shell}
                  emissive="#c8d2e6"
                  emissiveIntensity={0.2}
                  roughness={0.16}
                  metalness={0.05}
                  clearcoat={1}
                  clearcoatRoughness={0.08}
                />
              </RoundedBox>
              {/* Wrap-around visor: pokes through the head's rounded front corners so it reads from the side too. */}
              <RoundedBox args={[0.52, 0.31, 0.3]} radius={0.1} smoothness={4} position={[0, -0.01, 0.1]}>
                <meshPhysicalMaterial color={PALETTE.visor} roughness={0.1} metalness={0.5} clearcoat={1} />
              </RoundedBox>
              <group ref={eyes} position={[0, -0.01, 0.256]}>
                <Eyes state={view.state} mat={eyeMat} dots={dots} />
              </group>
              {[-1, 1].map((side) => (
                <mesh key={side} position={[side * 0.3, -0.02, -0.04]} rotation={[0, 0, Math.PI / 2]}>
                  <cylinderGeometry args={[0.062, 0.062, 0.05, 20]} />
                  <meshStandardMaterial color={color} roughness={0.3} metalness={0.5} />
                </mesh>
              ))}
              <mesh position={[0, 0.3, 0]}>
                <cylinderGeometry args={[0.013, 0.013, 0.14, 8]} />
                <meshStandardMaterial color={PALETTE.robotJoint} roughness={0.4} metalness={0.6} />
              </mesh>
              <mesh position={[0, 0.39, 0]}>
                <sphereGeometry args={[0.048, 14, 14]} />
                <meshBasicMaterial color={glow(color, 2.2)} toneMapped={false} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
});

/** Eye shapes per presentation state (all emissive, on the dark visor). */
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
            <mesh key={s} position={[s * 0.1, 0, 0]} rotation={[0, 0, s * 0.16]} material={mat}>
              <boxGeometry args={[0.11, 0.024, 0.01]} />
            </mesh>
          ))}
        </>
      );
    case 'succeeded':
      // Happy arcs ^ ^.
      return (
        <>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.1, -0.02, 0]} material={mat}>
              <torusGeometry args={[0.042, 0.015, 6, 16, Math.PI]} />
            </mesh>
          ))}
        </>
      );
    case 'failed':
      // Red X X.
      return (
        <>
          {[-1, 1].map((s) =>
            [1, -1].map((r) => (
              <mesh key={`${s}${r}`} position={[s * 0.1, 0, 0]} rotation={[0, 0, (r * Math.PI) / 4]} material={mat}>
                <boxGeometry args={[0.1, 0.024, 0.01]} />
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
              position={[s * 0.085, -0.01, 0]}
              material={mat}
            >
              <sphereGeometry args={[0.024, 10, 10]} />
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
            <mesh key={s} position={[s * 0.1, 0, 0]} material={mat}>
              <capsuleGeometry args={[0.03, 0.045, 4, 10]} />
            </mesh>
          ))}
        </>
      );
  }
}
