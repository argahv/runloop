'use client';
import { MapControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentRef } from 'react';
import { MathUtils, Vector3, type OrthographicCamera } from 'three';
import { poseAt, useScene, type CameraRequest } from './context';
import { ISO_DIR, TOP_DIR, easeOut, frameBoard, parseDurationMs } from './framing';
import { cellTop, heightAt, toScene } from './layout';
import type { CameraMode } from './types';

/** The two views as spherical angles, so transitions tilt and turn smoothly (no spin near the pole). */
const ANGLES = {
  iso: { azimuth: Math.atan2(ISO_DIR.x, ISO_DIR.z), polar: Math.acos(ISO_DIR.y) },
  top: { azimuth: 0, polar: Math.acos(TOP_DIR.y) },
} as const;
type Angles = { azimuth: number; polar: number };
const fromAngles = (out: Vector3, a: Angles) =>
  out.set(Math.sin(a.polar) * Math.sin(a.azimuth), Math.cos(a.polar), Math.sin(a.polar) * Math.cos(a.azimuth));
const DIST = 80;
/** Zoom relative to the fitted board when focusing one entity, and when following. */
const FOCUS_ZOOM = 2.2;
const FOLLOW_ZOOM = 1.7;
/** Zoom limits relative to the fitted board: never lose the board in the stage, never closer than a robot's face. */
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 6;

/** overview: the whole board, re-fitted on resize. free: the viewer (or a focus) set the view. follow: tracking the selected agent. */
type Mode = 'overview' | 'free' | 'follow';

interface Tween {
  fromTarget: Vector3;
  toTarget: Vector3;
  fromZoom: number;
  toZoom: number;
  fromAngles: Angles;
  toAngles: Angles;
  start: number;
  duration: number;
}

/** Camera move duration from the motion token (0 under reduced motion, where the tokens are zeroed). */
function cameraDurationMs(reducedMotion: boolean): number {
  if (reducedMotion || typeof document === 'undefined') return 0;
  return parseDurationMs(getComputedStyle(document.documentElement).getPropertyValue('--rl-dur-camera'), 550);
}

/**
 * Orthographic camera: isometric or top-down, pan/zoom with MapControls
 * (rotation disabled). Fits the whole board to the canvas (any aspect, with
 * room for the floating controls) and keeps it fitted on resize until the
 * viewer takes over. Presets (overview, focus, follow) ease with the camera
 * motion token and snap under reduced motion.
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
  const { world, getFrame, reducedMotion, camera: bus } = useScene();
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const size = useThree((s) => s.size);
  const angles = useRef<Angles>({ ...ANGLES[cameraMode] });
  const dir = useRef(fromAngles(new Vector3(), angles.current));
  const tween = useRef<Tween | null>(null);
  const mode = useRef<Mode>('overview');
  const fitZoom = useRef(1);
  const placed = useRef(false);
  const tmp = useRef(new Vector3()).current;

  /** Remember the overview's zoom and keep the viewer's zoom limits relative to it. */
  const setFit = useCallback((zoom: number) => {
    fitZoom.current = zoom;
    const c = controls.current;
    if (!c) return;
    c.minZoom = zoom * MIN_ZOOM;
    c.maxZoom = zoom * MAX_ZOOM;
  }, []);

  const setMode = useCallback(
    (m: Mode) => {
      mode.current = m;
      bus.setOverview(m === 'overview');
    },
    [bus],
  );

  /** Start an eased move to `target`/`zoom` (and the view direction of `toMode`). */
  const moveTo = useCallback(
    (target: Vector3, zoom: number, toMode: CameraMode = cameraMode) => {
      const c = controls.current;
      if (!c) return;
      tween.current = {
        fromTarget: c.target.clone(),
        toTarget: target.clone(),
        fromZoom: camera.zoom,
        toZoom: zoom,
        fromAngles: { ...angles.current },
        toAngles: { ...ANGLES[toMode] },
        start: performance.now(),
        duration: cameraDurationMs(reducedMotion),
      };
    },
    [camera, cameraMode, reducedMotion],
  );

  /** Where an entity is: an agent's current position, else a station. */
  const entityPoint = useCallback(
    (agentId: string | null, stationId: string | null): Vector3 | null => {
      if (agentId) {
        const pose = poseAt(world, getFrame(), agentId);
        if (pose) return new Vector3(...toScene(world, pose.x, pose.y, heightAt(world, pose.x, pose.y) + 0.6));
      }
      const s = stationId ? world.stationsById[stationId] : undefined;
      return s ? new Vector3(...toScene(world, s.cell[0], s.cell[1], cellTop(world, s.cell[0], s.cell[1]) + 0.6)) : null;
    },
    [world, getFrame],
  );

  // First layout: frame the board instantly.
  useLayoutEffect(() => {
    const c = controls.current;
    if (!c || placed.current || size.width === 0 || size.height === 0) return;
    placed.current = true;
    const f = frameBoard(world, dir.current, size.width, size.height);
    setFit(f.zoom);
    camera.zoom = f.zoom;
    camera.updateProjectionMatrix();
    c.target.copy(f.target);
    camera.position.copy(f.target).addScaledVector(dir.current, DIST);
    camera.lookAt(f.target);
  }, [camera, size.width, size.height, world, setFit]);

  // Resize: the overview re-fits at once; a custom view keeps its target and scales with the fit.
  useEffect(() => {
    if (!placed.current || size.width === 0 || size.height === 0) return;
    const c = controls.current;
    if (!c) return;
    const f = frameBoard(world, fromAngles(new Vector3(), ANGLES[cameraMode]), size.width, size.height);
    const ratio = f.zoom / fitZoom.current;
    setFit(f.zoom);
    if (mode.current === 'overview') {
      if (tween.current) {
        tween.current.toTarget.copy(f.target);
        tween.current.toZoom = f.zoom;
      } else {
        c.target.copy(f.target);
        camera.zoom = f.zoom;
        camera.updateProjectionMatrix();
      }
    } else {
      camera.zoom *= ratio;
      camera.updateProjectionMatrix();
      if (tween.current) tween.current.toZoom *= ratio;
    }
    // Only on size changes.
  }, [size.width, size.height]);

  // Iso ↔ top: turn the camera; the overview re-fits for the new view.
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    const c = controls.current;
    if (!c) return;
    const f = frameBoard(world, fromAngles(new Vector3(), ANGLES[cameraMode]), size.width, size.height);
    const ratio = f.zoom / fitZoom.current;
    setFit(f.zoom);
    if (mode.current === 'overview') moveTo(f.target, f.zoom, cameraMode);
    else moveTo(c.target, camera.zoom * ratio, cameraMode);
  }, [cameraMode]);

  // Presets from the camera rail.
  useEffect(
    () =>
      bus.listen((r: CameraRequest) => {
        const fit = frameBoard(world, fromAngles(new Vector3(), ANGLES[cameraMode]), size.width, size.height);
        setFit(fit.zoom);
        if (r.kind === 'overview') {
          setMode('overview');
          moveTo(fit.target, fit.zoom);
          return;
        }
        const p = r.kind === 'focusAgent' ? entityPoint(r.agentId, null) : entityPoint(null, r.stationId);
        if (!p) return;
        setMode('free');
        moveTo(p, Math.max(camera.zoom, fit.zoom * FOCUS_ZOOM));
      }),
    [bus, world, cameraMode, size.width, size.height, moveTo, entityPoint, setMode, setFit, camera],
  );

  // Follow: move in a little closer, then track the selected agent every frame.
  useEffect(() => {
    if (follow && selectedAgentId) {
      setMode('follow');
      const p = entityPoint(selectedAgentId, null);
      if (p) moveTo(p, Math.max(camera.zoom, fitZoom.current * FOLLOW_ZOOM));
    } else if (mode.current === 'follow') {
      setMode('free');
    }
  }, [follow, selectedAgentId]);

  // Selection from the timeline or inspector: when zoomed in, bring the entity into view (the overview already shows it).
  useEffect(() => {
    if (mode.current !== 'free') return;
    const p = entityPoint(selectedAgentId, selectedStationId);
    if (p) moveTo(p, camera.zoom);
  }, [selectedAgentId, selectedStationId]);

  // The viewer took over: drop any pending move. (Stable, so drei does not reconnect the controls.)
  const onUserStart = useCallback(() => {
    tween.current = null;
    if (mode.current !== 'follow') setMode('free');
  }, [setMode]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const tw = tween.current;
    if (tw) {
      const t = tw.duration <= 0 ? 1 : easeOut(Math.min(1, (performance.now() - tw.start) / tw.duration));
      angles.current.azimuth = MathUtils.lerp(tw.fromAngles.azimuth, tw.toAngles.azimuth, t);
      angles.current.polar = MathUtils.lerp(tw.fromAngles.polar, tw.toAngles.polar, t);
      // While following, the goal moves with the agent.
      if (mode.current === 'follow' && selectedAgentId) {
        const p = entityPoint(selectedAgentId, null);
        if (p) tw.toTarget.copy(p);
      }
      c.target.lerpVectors(tw.fromTarget, tw.toTarget, t);
      camera.zoom = MathUtils.lerp(tw.fromZoom, tw.toZoom, t);
      camera.updateProjectionMatrix();
      if (t >= 1) tween.current = null;
    } else if (mode.current === 'follow' && selectedAgentId) {
      const pose = poseAt(world, getFrame(), selectedAgentId);
      if (pose) {
        tmp.set(...toScene(world, pose.x, pose.y, heightAt(world, pose.x, pose.y) + 0.6));
        c.target.lerp(tmp, reducedMotion ? 1 : 1 - Math.exp(-dt * 5));
      }
    }
    fromAngles(dir.current, angles.current);
    camera.position.copy(c.target).addScaledVector(dir.current, DIST);
    camera.lookAt(c.target);
  });

  return (
    <MapControls
      ref={controls}
      makeDefault
      enableRotate={false}
      enableDamping={!reducedMotion}
      dampingFactor={0.15}
      zoomToCursor
      onStart={onUserStart}
    />
  );
}
