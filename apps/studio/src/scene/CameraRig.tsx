'use client';
import { MapControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { CompiledWorld } from '@runloop-world/world-engine';
import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentRef } from 'react';
import { MathUtils, Vector3, type OrthographicCamera } from 'three';
import { poseAt, useScene } from './context';
import { cellTop, heightAt, toScene } from './layout';
import type { CameraMode } from './types';

/** View directions (from target towards the camera). Iso looks from the south-east, so north/west walls are at the back. */
const ISO = new Vector3(1, 1.2, 1).normalize();
const TOP = new Vector3(0, 1, 0.002).normalize();
/** The same views as spherical angles, so transitions tilt and turn smoothly (no spin near the pole). */
const ANGLES = {
  iso: { azimuth: Math.atan2(ISO.x, ISO.z), polar: Math.acos(ISO.y) },
  top: { azimuth: 0, polar: Math.acos(TOP.y) },
} as const;
const fromAngles = (out: Vector3, a: { azimuth: number; polar: number }) =>
  out.set(Math.sin(a.polar) * Math.sin(a.azimuth), Math.cos(a.polar), Math.sin(a.polar) * Math.cos(a.azimuth));
const DIST = 80;
const UP = new Vector3(0, 1, 0);

/** Zoom and target that frame the whole board for a view direction. */
export function frameBoard(world: CompiledWorld, dir: Vector3, w: number, h: number): { zoom: number; center: Vector3 } {
  const fwd = dir.clone().negate();
  const right = new Vector3().crossVectors(fwd, UP).normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();
  const hx = world.width / 2 + 0.8;
  const hz = world.height / 2 + 0.8;
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  const p = new Vector3();
  for (const x of [-hx, hx])
    for (const z of [-hz, hz])
      for (const y of [-0.7, 2.2]) {
        p.set(x, y, z);
        const r = p.dot(right);
        const u = p.dot(up);
        r0 = Math.min(r0, r);
        r1 = Math.max(r1, r);
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
      }
  const zoom = Math.min(w / ((r1 - r0) * 1.04), h / ((u1 - u0) * 1.08));
  const center = right.multiplyScalar((r0 + r1) / 2).add(up.multiplyScalar((u0 + u1) / 2));
  center.y = Math.max(0, center.y);
  return { zoom: Math.max(4, zoom), center };
}

/**
 * Orthographic camera: isometric or top-down, pan/zoom with MapControls
 * (rotation disabled), smooth transitions (instant under reduced motion),
 * follow the selected character, focus the selected station.
 */
export function CameraRig({
  cameraMode,
  follow,
  selectedAgentId,
  selectedStationId,
}: {
  cameraMode: CameraMode;
  follow: boolean;
  selectedAgentId: string | null;
  selectedStationId: string | null;
}) {
  const { world, getFrame, reducedMotion } = useScene();
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const size = useThree((s) => s.size);
  const angles = useRef({ ...ANGLES[cameraMode] });
  const dir = useRef(fromAngles(new Vector3(), angles.current));
  const goalTarget = useRef<Vector3 | null>(null);
  const goalZoom = useRef<number | null>(null);
  const placed = useRef(false);
  const tmp = useRef(new Vector3()).current;

  // First layout: frame the board instantly.
  useLayoutEffect(() => {
    const c = controls.current;
    if (!c || placed.current || size.width === 0) return;
    placed.current = true;
    const f = frameBoard(world, dir.current, size.width, size.height);
    camera.zoom = f.zoom;
    camera.updateProjectionMatrix();
    c.target.copy(f.center);
    camera.position.copy(f.center).addScaledVector(dir.current, DIST);
    camera.lookAt(f.center);
  }, [camera, size.width, size.height, world]);

  // Re-frame on mode change or resize.
  const firstFrame = useRef(true);
  useEffect(() => {
    if (firstFrame.current) {
      firstFrame.current = false;
      return;
    }
    const f = frameBoard(world, cameraMode === 'top' ? TOP : ISO, size.width, size.height);
    goalZoom.current = f.zoom;
    if (!(follow && selectedAgentId)) goalTarget.current = f.center;
    // Only on mode/size changes (not when the selection changes).
  }, [cameraMode, size.width, size.height, world]);

  // Following someone: move in a little closer (never zooms out).
  useEffect(() => {
    if (!follow || !selectedAgentId) return;
    const fit = frameBoard(world, cameraMode === 'top' ? TOP : ISO, size.width, size.height).zoom;
    goalZoom.current = Math.max(camera.zoom, fit * 1.7);
    // Only when follow is switched on or the followed agent changes.
  }, [follow, selectedAgentId]);

  // Focus the selected station.
  useEffect(() => {
    if (!selectedStationId) return;
    const s = world.stationsById[selectedStationId];
    if (!s) return;
    goalTarget.current = new Vector3(...toScene(world, s.cell[0], s.cell[1], cellTop(world, s.cell[0], s.cell[1]) + 0.5));
  }, [selectedStationId, world]);

  // The user took over: drop any pending camera animation. (Stable, so drei does not reconnect the controls.)
  const onUserStart = useCallback(() => {
    goalTarget.current = null;
    goalZoom.current = null;
  }, []);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
    const want = ANGLES[cameraMode];
    angles.current.azimuth = MathUtils.lerp(angles.current.azimuth, want.azimuth, k);
    angles.current.polar = MathUtils.lerp(angles.current.polar, want.polar, k);
    fromAngles(dir.current, angles.current);

    if (follow && selectedAgentId) {
      const pose = poseAt(world, getFrame(), selectedAgentId);
      if (pose) {
        tmp.set(...toScene(world, pose.x, pose.y, heightAt(world, pose.x, pose.y) + 0.5));
        c.target.lerp(tmp, reducedMotion ? 1 : 1 - Math.exp(-dt * 4));
      }
    } else if (goalTarget.current) {
      c.target.lerp(goalTarget.current, k);
      if (c.target.distanceTo(goalTarget.current) < 0.005) goalTarget.current = null;
    }
    if (goalZoom.current !== null) {
      camera.zoom = MathUtils.lerp(camera.zoom, goalZoom.current, k);
      camera.updateProjectionMatrix();
      if (Math.abs(camera.zoom - goalZoom.current) < 0.01) goalZoom.current = null;
    }
    camera.position.copy(c.target).addScaledVector(dir.current, DIST);
    camera.lookAt(c.target);
  });

  return (
    <MapControls
      ref={controls}
      makeDefault
      enableRotate={false}
      enableDamping
      dampingFactor={0.15}
      minZoom={6}
      maxZoom={220}
      zoomToCursor
      onStart={onUserStart}
    />
  );
}
