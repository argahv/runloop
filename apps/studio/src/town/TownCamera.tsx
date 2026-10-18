'use client';
import { MapControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { EntityRef } from '@runloop-world/events';
import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentRef } from 'react';
import { MathUtils, Vector3, type OrthographicCamera } from 'three';
import { cubicBezier, easeOut, frameBounds, parseDurationMs, type Insets } from '../scene/framing';
import { hqLayout } from './AgentHq';
import { gridX, gridY, sceneX, sceneZ } from './coords';
import { useTown } from './context';
import { buildingShape } from './geometry/buildings';
import { projectedHeight, tierFor } from './lod';
import { RESIDENT_HEIGHT } from './rig/residentRig';
import type { TownCam, TownCameraRequest, TownLevel } from './types';

/** View elevation: steeper than the run diorama's 28°, so streets between buildings stay visible. */
export const ELEVATION = (37 * Math.PI) / 180;
/** Default azimuth: looking from the south-east (the cutaway convention: south and east walls nearest). */
export const DEFAULT_AZ = Math.PI / 4;
const DIST = 160;
/** Street level shows about this many cells across. */
const STREET_CELLS = 28;
const MAX_ZOOM_STREET = 2.4;
const CINEMATIC_MS = 2200;
/** How long a focus asked before its entity can be placed (deep links on load) keeps retrying. */
const PENDING_FOCUS_MS = 6000;
const easeInOut = cubicBezier(0.65, 0, 0.35, 1);

const dirOf = (out: Vector3, az: number) => out.set(Math.sin(az) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(az) * Math.cos(ELEVATION));

interface Tween {
  from: { x: number; z: number; zoom: number; az: number };
  to: { x: number; z: number; zoom: number; az: number };
  start: number;
  duration: number;
  ease: (t: number) => number;
}

/** Insets that keep framed things clear of the floating chrome. */
const INSETS: Insets = { top: 64, right: 64, bottom: 64, left: 64 };

/**
 * The town camera (extends the CameraRig ideas): orthographic, pan and zoom
 * with MapControls (rotation in 90° steps on request), four levels (town,
 * district, street, interior), follow, and quick or cinematic transitions.
 * Any viewer input interrupts a move; reduced motion cuts instead of animating.
 */
export function TownCamera({
  request,
  follow,
  entered,
  initialCam,
  reducedMotion,
  onCamChange,
  onFollowBroken,
}: {
  request: TownCameraRequest | null;
  follow: EntityRef | null;
  entered: string | null;
  initialCam: TownCam | null | undefined;
  reducedMotion: boolean;
  onCamChange?: (cam: TownCam, level: TownLevel) => void;
  onFollowBroken?: () => void;
}) {
  const ctx = useTown();
  const { town, frame } = ctx;
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const size = useThree((s) => s.size);
  const az = useRef(DEFAULT_AZ);
  const tween = useRef<Tween | null>(null);
  const fit = useRef(10);
  const placed = useRef(false);
  const lastReq = useRef<number | null>(null);
  /** A focus or enter whose entity could not be placed yet (no snapshot or positions): retried each frame for a while. */
  const pending = useRef<{ ref: EntityRef; kind: 'enter' | 'focus'; motion: TownCameraRequest['motion']; until: number } | null>(null);
  const before = useRef<{ x: number; z: number; zoom: number; az: number } | null>(null);
  const tierRef = useRef<0 | 1 | 2 | null>(null);
  const dir = useRef(new Vector3());
  const tmp = useRef(new Vector3()).current;
  const reported = useRef({ key: '', at: 0, moving: true });
  const f = { width: town.width, height: town.height };

  /**
   * Zoom (px per cell) and ground target that fit a set of world points. frameBounds returns a target in the
   * view plane; sliding it along the view direction onto y = 0 shows the same picture with a ground target.
   */
  const fitPoints = useCallback(
    (pts: Vector3[], insets: Insets = INSETS) => {
      const d = dirOf(new Vector3(), az.current);
      const v = frameBounds(pts, d, size.width, size.height, insets);
      v.target.addScaledVector(d, -v.target.y / d.y);
      return v;
    },
    [size.width, size.height],
  );
  const rectPoints = useCallback(
    (x0: number, y0: number, x1: number, y1: number, h = 0) => {
      const pts: Vector3[] = [];
      for (const gx of [x0 - 0.5, x1 + 0.5]) for (const gy of [y0 - 0.5, y1 + 0.5]) for (const y of [0, h]) pts.push(new Vector3(sceneX(f, gx), y, sceneZ(f, gy)));
      return pts;
    },
    [f.width, f.height],
  );
  const townFit = useCallback(() => fitPoints(rectPoints(0, 0, town.width - 1, town.height - 1, 3), { top: 40, right: 24, bottom: 40, left: 24 }), [fitPoints, rectPoints, town]);
  const streetZoom = () => Math.max(fit.current * 1.5, size.width / STREET_CELLS);

  /** Where an entity is, and the zoom that frames it. */
  const entityView = useCallback(
    (ref: EntityRef, level?: TownLevel): { x: number; z: number; zoom: number } | null => {
      switch (ref.kind) {
        case 'resident': {
          const i = frame.snapshot?.residents.findIndex((r) => r.id === ref.id) ?? -1;
          if (i < 0) return null;
          const r = frame.snapshot!.residents[i]!;
          // Inside a building that is not open: frame the building.
          if (!ctx.residentVisible[i] && r.place.kind === 'building') return entityView({ kind: 'building', id: r.place.buildingId });
          // Outdoors but not drawn yet (the first frames): no position to frame yet.
          if (!ctx.residentVisible[i]) return null;
          return { x: ctx.residentPos[i * 3]!, z: ctx.residentPos[i * 3 + 2]!, zoom: streetZoom() * 1.2 };
        }
        case 'agent': {
          const p = ctx.agentPos.get(ref.id);
          return p ? { x: p.x, z: p.z, zoom: streetZoom() * 1.3 } : null;
        }
        case 'building': {
          const b = town.buildingById.get(ref.id);
          if (b) {
            const [x, y, w, h] = b.def.footprint;
            const v = fitPoints(rectPoints(x, y, x + w - 1, y + h - 1, buildingShape(b).top), level === 'interior' ? { top: 90, right: 420, bottom: 90, left: 90 } : { top: 120, right: 440, bottom: 120, left: 120 });
            return { x: v.target.x, z: v.target.z, zoom: Math.min(v.zoom, streetZoom() * MAX_ZOOM_STREET) };
          }
          // An agent's headquarters.
          const agent = frame.snapshot?.agents.find((a) => a.buildingId === ref.id);
          const lot = agent ? town.lotById.get(agent.lotId) : town.agentLots.find((l) => l.buildingId === ref.id);
          if (!lot) return null;
          const [x, y, w, h] = lot.rect;
          const v = fitPoints(rectPoints(x, y, x + w - 1, y + h - 1, hqLayout(town, lot).top), { top: 90, right: 420, bottom: 90, left: 90 });
          return { x: v.target.x, z: v.target.z, zoom: v.zoom };
        }
        case 'lot': {
          const lot = town.lotById.get(ref.id);
          if (!lot) return null;
          const [x, y, w, h] = lot.rect;
          const v = fitPoints(rectPoints(x, y, x + w - 1, y + h - 1, 2));
          return { x: v.target.x, z: v.target.z, zoom: v.zoom };
        }
        case 'district': {
          const d = town.def.districts.find((x) => x.id === ref.id);
          if (!d) return null;
          const pts = d.rects.flatMap(([x, y, w, h]) => rectPoints(x, y, x + w - 1, y + h - 1, 2));
          const v = fitPoints(pts, { top: 80, right: 420, bottom: 80, left: 80 });
          return { x: v.target.x, z: v.target.z, zoom: v.zoom };
        }
        case 'spot': {
          const s = town.spotById.get(ref.id);
          if (!s) return null;
          const xs = s.def.cells.map((c) => c[0]);
          const ys = s.def.cells.map((c) => c[1]);
          const v = fitPoints(rectPoints(Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3, 1));
          return { x: v.target.x, z: v.target.z, zoom: v.zoom };
        }
      }
    },
    [ctx, frame, town, fitPoints, rectPoints, size.width],
  );

  const durationFor = (motion: TownCameraRequest['motion']) => {
    if (reducedMotion || motion === 'cut') return 0;
    if (motion === 'cinematic') return CINEMATIC_MS;
    if (typeof document === 'undefined') return 550;
    return parseDurationMs(getComputedStyle(document.documentElement).getPropertyValue('--rl-dur-camera'), 550);
  };

  const moveTo = useCallback(
    (to: { x: number; z: number; zoom: number; az?: number }, motion: TownCameraRequest['motion'] = 'quick') => {
      const c = controls.current;
      if (!c) return;
      tween.current = {
        from: { x: c.target.x, z: c.target.z, zoom: camera.zoom, az: az.current },
        to: { x: to.x, z: to.z, zoom: to.zoom, az: to.az ?? az.current },
        start: performance.now(),
        duration: durationFor(motion),
        ease: motion === 'cinematic' ? easeInOut : easeOut,
      };
      reported.current.moving = true;
    },
    [camera, reducedMotion],
  );

  // First layout: the deep-linked camera, or the whole town.
  useLayoutEffect(() => {
    const c = controls.current;
    if (!c || placed.current || size.width === 0 || size.height === 0) return;
    placed.current = true;
    const t = townFit();
    fit.current = t.zoom;
    const start = initialCam ? { x: sceneX(f, initialCam.x), z: sceneZ(f, initialCam.z), zoom: initialCam.zoom } : { x: t.target.x, z: t.target.z, zoom: t.zoom };
    c.target.set(start.x, 0, start.z);
    camera.zoom = start.zoom;
    camera.updateProjectionMatrix();
    dirOf(dir.current, az.current);
    camera.position.copy(c.target).addScaledVector(dir.current, DIST);
    camera.lookAt(c.target);
  }, [size.width, size.height]);

  // Keep the fit current on resize (zoom limits follow it).
  useEffect(() => {
    if (!placed.current) return;
    fit.current = townFit().zoom;
  }, [size.width, size.height, townFit]);

  // Requests from the shell.
  useEffect(() => {
    if (!request || request.id === lastReq.current) return;
    lastReq.current = request.id;
    pending.current = null;
    const c = controls.current;
    if (!c) return;
    const motion = request.motion ?? 'quick';
    switch (request.kind) {
      case 'overview': {
        const t = townFit();
        moveTo({ x: t.target.x, z: t.target.z, zoom: t.zoom }, motion);
        return;
      }
      case 'rotate':
        moveTo({ x: c.target.x, z: c.target.z, zoom: camera.zoom, az: az.current + ((request.dir ?? 1) * Math.PI) / 2 }, motion);
        return;
      case 'level': {
        const zoom = request.level === 'street' ? streetZoom() : request.level === 'district' ? fit.current * 2.1 : fit.current;
        moveTo({ x: c.target.x, z: c.target.z, zoom }, motion);
        return;
      }
      case 'cam':
        if (request.cam) moveTo({ x: sceneX(f, request.cam.x), z: sceneZ(f, request.cam.z), zoom: request.cam.zoom }, motion);
        return;
      case 'exit':
        if (before.current) moveTo(before.current, motion);
        before.current = null;
        return;
      case 'enter':
      case 'focus': {
        if (!request.ref) return;
        const v = entityView(request.ref, request.kind === 'enter' ? 'interior' : undefined);
        // Not placeable yet (a deep link before the first snapshot or positions): keep it and retry.
        if (!v) {
          pending.current = { ref: request.ref, kind: request.kind, motion, until: performance.now() + PENDING_FOCUS_MS };
          return;
        }
        if (request.kind === 'enter' && !before.current) before.current = { x: c.target.x, z: c.target.z, zoom: camera.zoom, az: az.current };
        moveTo(v, motion);
        return;
      }
    }
  }, [request]);

  // Entering by prop alone (the shell set `entered` without a request): frame the building; leaving restores.
  const prevEntered = useRef<string | null>(entered);
  useEffect(() => {
    const prev = prevEntered.current;
    prevEntered.current = entered;
    if (entered === prev) return;
    const c = controls.current;
    if (!c) return;
    if (entered) {
      if (!before.current) before.current = { x: c.target.x, z: c.target.z, zoom: camera.zoom, az: az.current };
      const v = entityView({ kind: 'building', id: entered }, 'interior');
      if (v) moveTo(v, 'quick');
    } else if (before.current) {
      moveTo(before.current, 'quick');
      before.current = null;
    }
  }, [entered]);

  // Viewer input interrupts any move and breaks a follow.
  const onUserStart = useCallback(() => {
    tween.current = null;
    pending.current = null;
    reported.current.moving = true;
    if (follow) onFollowBroken?.();
  }, [follow, onFollowBroken]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const p = pending.current;
    if (p) {
      if (performance.now() > p.until) pending.current = null;
      else {
        const v = entityView(p.ref, p.kind === 'enter' ? 'interior' : undefined);
        if (v) {
          pending.current = null;
          if (p.kind === 'enter' && !before.current) before.current = { x: c.target.x, z: c.target.z, zoom: camera.zoom, az: az.current };
          moveTo(v, p.motion);
        }
      }
    }
    const minZoom = fit.current * 0.8;
    const maxZoom = streetZoom() * MAX_ZOOM_STREET;
    c.minZoom = minZoom;
    c.maxZoom = maxZoom;
    const tw = tween.current;
    if (tw) {
      const raw = tw.duration <= 0 ? 1 : Math.min(1, (performance.now() - tw.start) / tw.duration);
      const k = tw.ease(raw);
      // Following during a move: the goal moves with the entity.
      if (follow) {
        const v = followPoint(follow);
        if (v) {
          tw.to.x = v.x;
          tw.to.z = v.z;
        }
      }
      c.target.set(MathUtils.lerp(tw.from.x, tw.to.x, k), 0, MathUtils.lerp(tw.from.z, tw.to.z, k));
      // Zoom eases in log space, so far-to-near moves feel even.
      camera.zoom = Math.exp(MathUtils.lerp(Math.log(tw.from.zoom), Math.log(Math.min(maxZoom, Math.max(minZoom, tw.to.zoom))), k));
      az.current = MathUtils.lerp(tw.from.az, tw.to.az, k);
      camera.updateProjectionMatrix();
      if (raw >= 1) tween.current = null;
    } else if (follow) {
      const v = followPoint(follow);
      if (v) {
        tmp.set(v.x, 0, v.z);
        c.target.lerp(tmp, reducedMotion ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 5));
      }
    }
    // Keep the view over the town.
    const hx = town.width / 2 + 2;
    const hz = town.height / 2 + 2;
    c.target.x = Math.min(hx, Math.max(-hx, c.target.x));
    c.target.z = Math.min(hz, Math.max(-hz, c.target.z));
    c.target.y = 0;
    dirOf(dir.current, az.current);
    camera.position.copy(c.target).addScaledVector(dir.current, DIST);
    camera.lookAt(c.target);

    // Publish for the rest of the scene.
    frame.zoom = camera.zoom;
    frame.camAz = az.current;
    frame.level = entered ? 'interior' : camera.zoom >= streetZoom() * 0.8 ? 'street' : camera.zoom >= fit.current * 1.6 ? 'district' : 'town';
    const t = tierFor(projectedHeight(RESIDENT_HEIGHT, camera.zoom, ELEVATION), tierRef.current, ctx.live.quality.t0Px);
    tierRef.current = t;
    frame.tier = t;

    // Report the camera once it has settled.
    if (onCamChange) {
      const key = `${c.target.x.toFixed(1)},${c.target.z.toFixed(1)},${camera.zoom.toFixed(1)}`;
      const now = performance.now();
      if (key !== reported.current.key) {
        reported.current.key = key;
        reported.current.at = now;
        reported.current.moving = true;
      } else if (reported.current.moving && now - reported.current.at > 300 && !tween.current) {
        reported.current.moving = false;
        onCamChange({ x: round(gridX(f, c.target.x)), z: round(gridY(f, c.target.z)), zoom: round(camera.zoom) }, frame.level);
      }
    }
  });

  function followPoint(ref: EntityRef): { x: number; z: number } | null {
    if (ref.kind === 'resident') {
      const i = frame.snapshot?.residents.findIndex((r) => r.id === ref.id) ?? -1;
      if (i < 0 || !ctx.residentVisible[i]) return null;
      return { x: ctx.residentPos[i * 3]!, z: ctx.residentPos[i * 3 + 2]! };
    }
    if (ref.kind === 'agent') {
      const p = ctx.agentPos.get(ref.id);
      return p ? { x: p.x, z: p.z } : null;
    }
    return null;
  }

  return <MapControls ref={controls} makeDefault enableRotate={false} enableDamping={!reducedMotion} dampingFactor={0.15} zoomToCursor screenSpacePanning={false} onStart={onUserStart} />;
}

const round = (n: number) => Math.round(n * 100) / 100;
