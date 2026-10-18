'use client';
import { useFrame, useThree } from '@react-three/fiber';
import type { EntityRef } from '@runloop-world/events';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { PerspectiveCamera } from 'three';
import { hqLayout } from './AgentHq';
import { CameraController, type Motion } from './cameraController';
import {
  DEG,
  DEFAULT_AZ_DEG,
  DEFAULT_TILT_DEG,
  TILT_FLY_IN_DEG,
  TILT_INTERIOR_DEG,
  TILT_MIN_DEG,
  clipPlanes,
  fitPoints,
  footprint,
  groundHit,
  type CamPose,
  type FitInsets,
} from './cameraMath';
import { gridX, gridY, sceneX, sceneZ } from './coords';
import { useTown, type TownCtx } from './context';
import { buildingShape } from './geometry/buildings';
import { projectedHeightPersp, tierFor } from './lod';
import { RESIDENT_HEIGHT } from './rig/residentRig';
import type { Insets, TownCam, TownCamState, TownCameraRequest, TownLevel } from './types';

/** Default azimuth (radians): looking from the south-east (the cutaway convention: south and east walls nearest). */
export const DEFAULT_AZ = DEFAULT_AZ_DEG * DEG;
/** Street level shows about this many cells across. */
const STREET_CELLS = 28;
const MAX_ZOOM_STREET = 2.4;
/** How long a focus asked before its entity can be placed (deep links on load) keeps retrying. */
const PENDING_FOCUS_MS = 6000;
/** Margins (px) around framed things, on top of the HUD's insets; the right side leaves room for an anchored card. */
const MARGIN: FitInsets = { top: 64, right: 64, bottom: 64, left: 64 };
const CARD: FitInsets = { top: 110, right: 400, bottom: 120, left: 110 };
const INTERIOR: FitInsets = { top: 90, right: 400, bottom: 110, left: 90 };
const DISTRICT: FitInsets = { top: 80, right: 400, bottom: 100, left: 80 };
const TOWN: FitInsets = { top: 40, right: 24, bottom: 40, left: 24 };
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The camera's per-frame state shared with the scene (labels, picking, fog, the HUD's API). */
export interface TownCamRuntime {
  ctl: CameraController;
  /** Reference zooms: the whole town at the default angle, and street level. */
  fit: number;
  street: number;
  fogNear: number;
  fogFar: number;
  state: TownCamState;
  listeners: Set<(s: TownCamState) => void>;
  /** Double-click on open ground: fly there and zoom one level in (set by TownCamera). */
  flyToPixel: ((px: number, py: number) => void) | null;
}

export function createCamRuntime(): TownCamRuntime {
  const ctl = new CameraController({ onUserInput: () => {}, onInteraction: () => {}, onFly: () => {} });
  return {
    ctl,
    fit: 10,
    street: 40,
    fogNear: 400,
    fogFar: 800,
    state: { x: 0, z: 0, zoom: 10, az: DEFAULT_AZ_DEG, tilt: DEFAULT_TILT_DEG, fovY: 20, level: 'town', moving: false, footprint: [] },
    listeners: new Set(),
    flyToPixel: null,
  };
}

const addInsets = (a: FitInsets, b: Insets): FitInsets => ({ top: a.top + b.top, right: a.right + b.right, bottom: a.bottom + b.bottom, left: a.left + b.left });

/** World points of a cell rectangle (inclusive), from the ground to height h. */
function rectPoints(ctx: TownCtx, x0: number, y0: number, x1: number, y1: number, h = 0): [number, number, number][] {
  const f = { width: ctx.town.width, height: ctx.town.height };
  const pts: [number, number, number][] = [];
  for (const gx of [x0 - 0.5, x1 + 0.5]) for (const gy of [y0 - 0.5, y1 + 0.5]) for (const y of [0, h]) pts.push([sceneX(f, gx), y, sceneZ(f, gy)]);
  return pts;
}

/**
 * The town camera (immersive contract §2): a perspective camera with a narrow
 * field of view, driven by CameraController (pan with inertia, zoom to the
 * cursor, free rotation, limited tilt, keys, touch, soft bounds), four levels
 * (town, district, street, interior), follow, fly-in, and quick or cinematic
 * moves that any viewer input interrupts. Reduced motion cuts.
 */
export function TownCamera({
  request,
  follow,
  entered,
  initialCam,
  reducedMotion,
  viewInsets,
  keyboard,
  onCamChange,
  onFollowBroken,
  onInteraction,
  onFly,
}: {
  request: TownCameraRequest | null;
  follow: EntityRef | null;
  entered: string | null;
  initialCam: TownCam | null | undefined;
  reducedMotion: boolean;
  viewInsets?: Insets | undefined;
  keyboard: boolean;
  onCamChange?: ((cam: TownCam, level: TownLevel) => void) | undefined;
  onFollowBroken?: (() => void) | undefined;
  onInteraction?: ((active: boolean) => void) | undefined;
  onFly?: ((durationMs: number, pan: number) => void) | undefined;
}) {
  const ctx = useTown();
  const { town, frame, cam } = ctx;
  const ctl = cam.ctl;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const placed = useRef(false);
  const lastReq = useRef<number | null>(null);
  /** A focus or enter whose entity could not be placed yet (no snapshot or positions): retried each frame for a while. */
  const pending = useRef<{ ref: EntityRef; kind: 'enter' | 'focus'; motion: Motion; until: number } | null>(null);
  const before = useRef<CamPose | null>(null);
  const tierRef = useRef<0 | 1 | 2 | null>(null);
  const reported = useRef({ key: '', at: 0, moving: true });
  const frameCount = useRef(0);
  const f = { width: town.width, height: town.height };

  // Latest callbacks, without re-creating the controller.
  const followRef = useRef(follow);
  followRef.current = follow;
  const cb = useRef({ onFollowBroken, onInteraction, onFly });
  cb.current = { onFollowBroken, onInteraction, onFly };
  useLayoutEffect(() => {
    ctl.setHooks({
      onUserInput: () => {
        pending.current = null;
        if (followRef.current) cb.current.onFollowBroken?.();
      },
      onInteraction: (a) => cb.current.onInteraction?.(a),
      onFly: (ms, pan) => cb.current.onFly?.(ms, pan),
    });
  }, [ctl]);
  ctl.reducedMotion = reducedMotion;
  ctl.keyboard = keyboard;
  ctl.goalInsets = { ...NO_INSETS, ...(viewInsets ?? {}) };
  // An open interior keeps the view steep.
  ctl.tiltMin = (entered ? TILT_INTERIOR_DEG : TILT_MIN_DEG) * DEG;

  const vp = () => {
    const i = ctl.goalInsets;
    return { width: size.width, height: size.height, cx: (i.left + size.width - i.right) / 2, cy: (i.top + size.height - i.bottom) / 2 };
  };

  /** Fit world points at the current (or given) angles, clear of the HUD and `margins`. */
  const fit = useCallback(
    (pts: [number, number, number][], margins: FitInsets, az = ctl.destination().az, tilt = ctl.destination().tilt) => {
      const r = fitPoints(pts, az, tilt, vp(), addInsets(margins, ctl.goalInsets), cam.street * MAX_ZOOM_STREET);
      return { x: r.x, z: r.z, zoom: r.zoom };
    },
    [size.width, size.height, ctl, cam],
  );

  const townPoints = () => rectPoints(ctx, -6, -6, town.width + 5, town.height + 5, 3);
  const refreshLimits = () => {
    const ref = fitPoints(townPoints(), DEFAULT_AZ, DEFAULT_TILT_DEG * DEG, { width: size.width, height: size.height }, TOWN);
    cam.fit = ref.zoom;
    cam.street = Math.max(ref.zoom * 1.5, size.width / STREET_CELLS);
    ctl.zoomMin = cam.fit * 0.6;
    ctl.zoomMax = cam.street * MAX_ZOOM_STREET;
    ctl.boundX = town.width / 2 + 20;
    ctl.boundZ = town.height / 2 + 20;
  };

  /** Where an entity is, and the camera that frames it. */
  const entityView = useCallback(
    (ref: EntityRef, interior = false): Partial<CamPose> | null => {
      const snap = frame.snapshot;
      switch (ref.kind) {
        case 'resident': {
          const i = snap?.residents.findIndex((r) => r.id === ref.id) ?? -1;
          if (i < 0) return null;
          const r = snap!.residents[i]!;
          // Inside a building that is not open: frame the building.
          if (!ctx.residentVisible[i] && r.place.kind === 'building') return entityView({ kind: 'building', id: r.place.buildingId });
          // Outdoors but not drawn yet (the first frames): no position to frame yet.
          if (!ctx.residentVisible[i]) return null;
          return { x: ctx.residentPos[i * 3]!, z: ctx.residentPos[i * 3 + 2]!, zoom: cam.street * 1.2 };
        }
        case 'agent': {
          const p = ctx.agentPos.get(ref.id);
          return p ? { x: p.x, z: p.z, zoom: cam.street * 1.3 } : null;
        }
        case 'building': {
          const tilt = interior ? Math.max(ctl.destination().tilt, TILT_FLY_IN_DEG * DEG) : undefined;
          const b = town.buildingById.get(ref.id);
          if (b) {
            const [x, y, w, h] = b.def.footprint;
            const v = fit(rectPoints(ctx, x, y, x + w - 1, y + h - 1, interior ? 1.2 : buildingShape(b).top), interior ? INTERIOR : CARD, undefined, tilt);
            return { ...v, zoom: Math.min(v.zoom, cam.street * MAX_ZOOM_STREET), ...(tilt !== undefined ? { tilt } : {}) };
          }
          // An agent's headquarters.
          const agent = snap?.agents.find((a) => a.buildingId === ref.id);
          const lot = agent ? town.lotById.get(agent.lotId) : town.agentLots.find((l) => l.buildingId === ref.id);
          if (!lot) return null;
          const [x, y, w, h] = lot.rect;
          const v = fit(rectPoints(ctx, x, y, x + w - 1, y + h - 1, interior ? 1.5 : hqLayout(town, lot).top), interior ? INTERIOR : CARD, undefined, tilt);
          return { ...v, ...(tilt !== undefined ? { tilt } : {}) };
        }
        case 'lot': {
          const lot = town.lotById.get(ref.id);
          if (!lot) return null;
          const [x, y, w, h] = lot.rect;
          return fit(rectPoints(ctx, x, y, x + w - 1, y + h - 1, 2), CARD);
        }
        case 'district': {
          const d = town.def.districts.find((x) => x.id === ref.id);
          if (!d) return null;
          const pts = d.rects.flatMap(([x, y, w, h]) => rectPoints(ctx, x, y, x + w - 1, y + h - 1, 2));
          return fit(pts, DISTRICT);
        }
        case 'spot': {
          const s = town.spotById.get(ref.id);
          if (!s) return null;
          const xs = s.def.cells.map((c) => c[0]);
          const ys = s.def.cells.map((c) => c[1]);
          return fit(rectPoints(ctx, Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3, 1), MARGIN);
        }
      }
    },
    [ctx, frame, town, fit, cam, ctl],
  );

  const followPoint = (ref: EntityRef | null): { x: number; z: number } | null => {
    if (!ref) return null;
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
  };

  // First layout: the deep-linked camera, or the whole town.
  useLayoutEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    ctl.width = size.width;
    ctl.height = size.height;
    ctl.insets = { ...ctl.goalInsets };
    refreshLimits();
    if (placed.current) return;
    placed.current = true;
    if (initialCam) {
      ctl.cut({ x: sceneX(f, initialCam.x), z: sceneZ(f, initialCam.z), zoom: initialCam.zoom, az: (initialCam.az ?? DEFAULT_AZ_DEG) * DEG, tilt: (initialCam.tilt ?? DEFAULT_TILT_DEG) * DEG });
    } else {
      const t = fit(townPoints(), TOWN, DEFAULT_AZ, DEFAULT_TILT_DEG * DEG);
      ctl.cut({ ...t, az: DEFAULT_AZ, tilt: DEFAULT_TILT_DEG * DEG });
    }
  }, [size.width, size.height]);

  // 0 / Home: the whole town at the current azimuth (not flatter than 30°).
  ctl.overview = () => {
    const dest = ctl.destination();
    const tilt = Math.max(dest.tilt, 30 * DEG);
    ctl.moveTo({ ...fit(townPoints(), TOWN, dest.az, tilt), tilt }, 'quick');
  };

  // Double-click on open ground: fly there and one level in.
  useEffect(() => {
    cam.flyToPixel = (px, py) => {
      const g = groundHit(ctl.view, px, py, ctl.view.d * 6);
      if (!g) return;
      const z = ctl.pose.zoom;
      const next = z < cam.fit * 1.6 ? cam.fit * 2.1 : z < cam.street * 0.8 ? cam.street : Math.min(ctl.zoomMax, z * 1.6);
      ctl.moveTo({ x: g.x, z: g.z, zoom: next }, 'quick');
    };
    return () => {
      cam.flyToPixel = null;
    };
  }, [cam, ctl]);

  // Requests from the shell.
  useEffect(() => {
    if (!request || request.id === lastReq.current) return;
    lastReq.current = request.id;
    pending.current = null;
    const motion: Motion = request.motion ?? 'quick';
    const dest = ctl.destination();
    switch (request.kind) {
      case 'overview': {
        const tilt = Math.max(dest.tilt, 30 * DEG);
        ctl.moveTo({ ...fit(townPoints(), TOWN, dest.az, tilt), tilt }, motion);
        return;
      }
      case 'rotate':
        ctl.moveTo({ az: dest.az + (request.dir ?? 1) * (request.deg ?? 90) * DEG }, motion);
        return;
      case 'level': {
        const zoom = request.level === 'street' ? cam.street : request.level === 'district' ? cam.fit * 2.1 : cam.fit;
        if (request.level === 'town') {
          const tilt = Math.max(dest.tilt, 30 * DEG);
          ctl.moveTo({ ...fit(townPoints(), TOWN, dest.az, tilt), tilt }, motion);
        } else ctl.moveTo({ zoom }, motion);
        return;
      }
      case 'cam': {
        const c = request.cam;
        if (c) ctl.moveTo({ x: sceneX(f, c.x), z: sceneZ(f, c.z), zoom: c.zoom, ...(c.az !== undefined ? { az: dest.az + angleTo(dest.az, c.az * DEG) } : {}), ...(c.tilt !== undefined ? { tilt: c.tilt * DEG } : {}) }, motion);
        return;
      }
      case 'goto':
        if (request.point) ctl.moveTo({ x: sceneX(f, request.point.x), z: sceneZ(f, request.point.z) }, motion);
        return;
      case 'exit':
        if (before.current) ctl.moveTo(before.current, motion);
        before.current = null;
        return;
      case 'enter':
      case 'focus': {
        if (!request.ref) return;
        const v = entityView(request.ref, request.kind === 'enter');
        // Not placeable yet (a deep link before the first snapshot or positions): keep it and retry.
        if (!v) {
          pending.current = { ref: request.ref, kind: request.kind, motion, until: performance.now() + PENDING_FOCUS_MS };
          return;
        }
        if (request.kind === 'enter' && !before.current) before.current = { ...ctl.destination() };
        ctl.moveTo(v, motion);
        return;
      }
    }
  }, [request]);

  // Entering by prop alone (the shell set `entered` without a request): fly in; leaving restores the camera.
  const prevEntered = useRef<string | null>(entered);
  useEffect(() => {
    const prev = prevEntered.current;
    prevEntered.current = entered;
    if (entered === prev) return;
    if (entered) {
      if (!before.current) before.current = { ...ctl.destination() };
      const v = entityView({ kind: 'building', id: entered }, true);
      if (v) ctl.moveTo(v, 'quick');
      else pending.current = { ref: { kind: 'building', id: entered }, kind: 'enter', motion: 'quick', until: performance.now() + PENDING_FOCUS_MS };
    } else if (before.current) {
      ctl.moveTo(before.current, 'quick');
      before.current = null;
    }
  }, [entered]);

  // A new follow below district level comes in to street level once.
  const followKey = follow ? `${follow.kind}:${follow.id}` : '';
  useEffect(() => {
    if (!follow) return;
    const p = followPoint(follow);
    if (p && ctl.pose.zoom < cam.fit * 1.6) ctl.moveTo({ ...p, zoom: cam.street * 1.2 }, 'quick');
  }, [followKey]);

  useFrame((_, delta) => {
    const now = performance.now();
    if (ctl.width !== size.width || ctl.height !== size.height) {
      ctl.width = size.width;
      ctl.height = size.height;
      refreshLimits();
    }
    ctl.easeInsets(delta);
    const p = pending.current;
    if (p) {
      if (now > p.until) pending.current = null;
      else {
        const v = entityView(p.ref, p.kind === 'enter');
        if (v) {
          pending.current = null;
          if (p.kind === 'enter' && !before.current) before.current = { ...ctl.destination() };
          ctl.moveTo(v, p.motion);
        }
      }
    }
    ctl.update(delta, now, followPoint(followRef.current));
    const v = ctl.view;
    const pose = ctl.pose;

    // Apply to the three camera: the principal point at the centre of the area the HUD leaves free.
    const { near, far } = clipPlanes(v.d);
    camera.fov = v.fovY;
    camera.near = near;
    camera.far = far;
    camera.position.set(v.eye[0], v.eye[1], v.eye[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(pose.x, 0, pose.z);
    camera.setViewOffset(size.width, size.height, -(v.cx - size.width / 2), -(v.cy - size.height / 2), size.width, size.height);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // Haze: never on the town (fog starts past its farthest corner), thick by the horizon.
    let farthest = 0;
    const hx = town.width / 2 + 2;
    const hz = town.height / 2 + 2;
    for (const [cx, cz] of [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ] as const)
      farthest = Math.max(farthest, Math.hypot(cx - v.eye[0], 6 - v.eye[1], cz - v.eye[2]));
    cam.fogNear = Math.max(v.d + 70, farthest + 6);
    cam.fogFar = cam.fogNear + 450;

    // Publish for the rest of the scene.
    frame.zoom = pose.zoom;
    frame.camAz = pose.az;
    frame.level = entered ? 'interior' : pose.zoom >= cam.street * 0.8 ? 'street' : pose.zoom >= cam.fit * 1.6 ? 'district' : 'town';
    // LOD from the nearest ground in view (the bottom of the screen), so the closest residents get the detail.
    const g = groundHit(v, v.cx, size.height - 2);
    const nearest = g ? Math.hypot(g.x - v.eye[0], v.eye[1], g.z - v.eye[2]) : v.d;
    const t = tierFor(projectedHeightPersp(RESIDENT_HEIGHT, nearest, v.fovY, size.height), tierRef.current, ctx.live.quality.t0Px);
    tierRef.current = t;
    frame.tier = t;

    const moving = ctl.moving;
    const fp = footprint(v, Math.max(town.width, town.height) * 2);
    const st = cam.state;
    st.x = round(gridX(f, pose.x));
    st.z = round(gridY(f, pose.z));
    st.zoom = round(pose.zoom);
    st.az = round(azDeg(pose.az));
    st.tilt = round(pose.tilt / DEG);
    st.fovY = v.fovY;
    st.level = frame.level;
    st.moving = moving;
    st.footprint = fp.map(([x, z]) => [round(gridX(f, x)), round(gridY(f, z))]);
    frameCount.current++;
    if (typeof window !== 'undefined') window.__runloopCam = { x: st.x, z: st.z, zoom: st.zoom, az: st.az, tilt: st.tilt, level: st.level, moving, frame: frameCount.current };
    for (const fn of cam.listeners) fn(st);

    // Report the camera once it has settled.
    if (onCamChange) {
      const key = `${st.x.toFixed(1)},${st.z.toFixed(1)},${st.zoom.toFixed(1)},${st.az.toFixed(0)},${st.tilt.toFixed(0)}`;
      if (key !== reported.current.key) {
        reported.current.key = key;
        reported.current.at = now;
        reported.current.moving = true;
      } else if (reported.current.moving && now - reported.current.at > 300 && !moving) {
        reported.current.moving = false;
        onCamChange({ x: st.x, z: st.z, zoom: st.zoom, az: st.az, tilt: st.tilt }, frame.level);
      }
    }
  });

  return null;
}

/** Azimuth in degrees, [0, 360). */
function azDeg(az: number): number {
  const d = (az / DEG) % 360;
  return d < 0 ? d + 360 : d;
}

/** The turn from `from` to the absolute angle `to` (radians), the short way. */
function angleTo(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

const round = (n: number) => Math.round(n * 100) / 100;

declare global {
  interface Window {
    /** The town camera for tests (cells, px per cell, degrees). */
    __runloopCam?: { x: number; z: number; zoom: number; az: number; tilt: number; level: TownLevel; moving: boolean; /** Camera updates so far (tests wait for frames, not wall time). */ frame: number };
  }
}
