'use client';
import { useFrame } from '@react-three/fiber';
import { isUnknownEvent } from '@runloop-world/events';
import type { Motion } from '@runloop-world/world-engine';
import { memo, useEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, Color, DoubleSide, NormalBlending, type MeshBasicMaterial } from 'three';
import { poseAt, useScene } from './context';
import { messageRoutes } from './Effects';
import { glowPaths, pathPoints, walkwaysOnRoute } from './layout';
import { desaturate, mixHex, stateGlow } from './palette';
import { ribbonGeometry } from './textures';

/** How long a walkway stays bright after a recorded message crossed it (ms). */
const MESSAGE_MS = 1600;

/**
 * Walkways from the Atrium to each environment: a thin line in the
 * environment's tint, inlaid in the floor. A walkway brightens only while
 * something real travels it: a robot walking it to a task it was handed
 * (Layer 2 motion), or a recorded message whose route crosses it. At rest
 * it stays dim and never blooms (rule zero).
 */
export const Paths = memo(function Paths() {
  const { world, palette, getFrame, subscribeEffects, reducedMotion } = useScene();
  const walkways = useMemo(() => glowPaths(world).filter((p) => !p.branch), [world]);

  const geos = useMemo(
    () =>
      walkways.map((p, i) => {
        // Slightly different lifts so overlapping walkways never z-fight.
        const pts = pathPoints(world, p.cells, 0.012 + (i % 4) * 0.002);
        return { key: p.key, core: ribbonGeometry(pts, 0.09, { extend: true }), halo: ribbonGeometry(pts, 0.36, { extend: true }) };
      }),
    [world, walkways],
  );
  useEffect(
    () => () => {
      for (const g of geos) {
        g.core.dispose();
        g.halo.dispose();
      }
    },
    [geos],
  );

  const light = palette.theme === 'light';
  const colors = useMemo(
    () =>
      walkways.map((p) => {
        const tint = desaturate(p.color, 0.65);
        return light
          ? { rest: new Color(mixHex(palette.path, tint, 0.35)), hot: new Color(mixHex(desaturate(p.color, 0.9), palette.ice, 0.25)) }
          : { rest: new Color(mixHex(palette.path, tint, 0.45)), hot: stateGlow(palette, mixHex(tint, '#ffffff', 0.3), 1.6) };
      }),
    [walkways, palette, light],
  );
  const haloRest = light ? 0 : 0.05;

  const core = useRef<(MeshBasicMaterial | null)[]>([]);
  const halo = useRef<(MeshBasicMaterial | null)[]>([]);
  const level = useRef<number[]>([]);
  const walked = useRef<boolean[]>([]);
  const msgUntil = useRef<number[]>([]);
  /** Walkways each character's current walk covers (recomputed when its motion changes). */
  const routes = useRef(new Map<string, { motion: Motion; hits: number[] }>());

  // Recorded messages light the walkways their route crosses (small forward steps only, never on scrubs).
  useEffect(
    () =>
      subscribeEffects((events) => {
        const frame = getFrame();
        const now = performance.now();
        for (const e of events) {
          if (isUnknownEvent(e) || e.type !== 'agent.message_sent') continue;
          for (const route of messageRoutes(world, frame, e.payload.fromAgentId, e.payload.to)) {
            for (const i of walkwaysOnRoute(walkways, route)) msgUntil.current[i] = now + MESSAGE_MS;
          }
        }
      }),
    [subscribeEffects, getFrame, world, walkways],
  );

  useFrame((_, dt) => {
    const frame = getFrame();
    const now = performance.now();
    const on = walked.current;
    on.fill(false);
    for (const id of frame.state.world.characterOrder) {
      const c = frame.state.world.characters[id];
      if (!c || !poseAt(world, frame, id)?.moving) continue;
      let r = routes.current.get(id);
      if (!r || r.motion !== c.motion) {
        r = { motion: c.motion, hits: walkwaysOnRoute(walkways, c.motion.path) };
        routes.current.set(id, r);
      }
      for (const i of r.hits) on[i] = true;
    }
    for (let i = 0; i < walkways.length; i++) {
      const target = on[i] || (msgUntil.current[i] ?? 0) > now ? 1 : 0;
      const cur = level.current[i] ?? 0;
      // Brighten quickly, fade slowly; reduced motion snaps.
      const next = reducedMotion ? target : cur + (target - cur) * (1 - Math.exp(-dt * (target > cur ? 12 : 2.5)));
      if (Math.abs(next - cur) < 1e-4 && cur === target) continue;
      level.current[i] = Math.abs(next - target) < 1e-3 ? target : next;
      const m = core.current[i];
      if (m) m.color.copy(colors[i]!.rest).lerp(colors[i]!.hot, level.current[i]!);
      const h = halo.current[i];
      if (h) h.opacity = haloRest + level.current[i]! * (light ? 0.22 : 0.28);
    }
  });

  // Colours change with the theme: repaint at the current level.
  useEffect(() => {
    walked.current = walkways.map(() => false);
    for (let i = 0; i < walkways.length; i++) {
      const lv = level.current[i] ?? 0;
      core.current[i]?.color.copy(colors[i]!.rest).lerp(colors[i]!.hot, lv);
      if (halo.current[i]) halo.current[i]!.opacity = haloRest + lv * (light ? 0.22 : 0.28);
    }
  }, [walkways, colors, haloRest, light]);

  return (
    <group>
      {geos.map((g, i) => (
        <group key={g.key}>
          <mesh geometry={g.halo} renderOrder={1}>
            <meshBasicMaterial
              ref={(m) => void (halo.current[i] = m)}
              color={colors[i]!.hot}
              transparent
              opacity={haloRest}
              depthWrite={false}
              toneMapped={false}
              side={DoubleSide}
              blending={light ? NormalBlending : AdditiveBlending}
            />
          </mesh>
          <mesh geometry={g.core} renderOrder={2}>
            <meshBasicMaterial ref={(m) => void (core.current[i] = m)} color={colors[i]!.rest} toneMapped={false} side={DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  );
});
