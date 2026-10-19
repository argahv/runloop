'use client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { formatEntityRef, type EntityRef } from '@runloop-world/events';
import { minuteOfDay } from '@runloop-world/town';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Frustum, Matrix4, Vector3, type Object3D } from 'three';
import { LabelLayer } from '../scene/labels';
import { AgentHqs } from './AgentHq';
import { ScopedLabelStore } from './AgentHouse';
import { AmbientLife } from './AmbientLife';
import { entityAnchor, entityBox } from './anchors';
import { Atmosphere } from './Atmosphere';
import { groundHit, project } from './cameraMath';
import { TickSmoother, frameTick } from './clock';
import { TownContext, useTown, type TownCtx, type TownFrame } from './context';
import { gridX, gridY, sceneX, sceneZ } from './coords';
import { surroundLayout } from './geometry/surroundings';
import { useTownInput, type TownInputHandlers } from './input';
import { Interior } from './Interior';
import { LABEL_BUDGET, TownLabelLayer, TownLabelProjector, type LabelPoolHandle } from './labels';
import { computeListener, fixedSources } from './listener';
import { LotMarkers } from './LotMarkers';
import { ClockHands, LampPools, SelectionRings } from './Markers';
import { PerfMeter, ambientClock } from './perf';
import { Picker, type PickFn } from './Picker';
import { TownPlaces, gridInteriorOf } from './place';
import { AdaptiveQuality, type QualitySettings } from './quality';
import { Residents } from './Residents';
import { SkyRig } from './SkyRig';
import { StaticTown } from './StaticTown';
import { Surroundings } from './Surroundings';
import { TownCamera, DEFAULT_AZ, createCamRuntime } from './TownCamera';
import { createTownUniforms } from './townMaterial';
import type { ScreenPoint, TownApi, TownCanvasProps } from './types';
import styles from './town.module.css';

const MAX_RESIDENTS = 600;

/**
 * The town (plan §5 Rendering; immersive contract §2–3): a persistent,
 * populated town drawn from the engine's state, seen through a free game
 * camera, standing in open country under a sky that follows sim time.
 * Default export, for next/dynamic with ssr: false. See README.md for the
 * contract with the shell.
 */
export default function TownCanvas(props: TownCanvasProps) {
  const { town, quality: qualityPref, reducedMotion, entered } = props;
  const places = useMemo(() => new TownPlaces(town), [town]);
  const uniforms = useMemo(() => createTownUniforms(town.buildings.length, town.width), [town]);
  const layout = useMemo(() => surroundLayout(town, props.seed ?? 1), [town, props.seed]);
  const adaptive = useRef<AdaptiveQuality | null>(null);
  adaptive.current ??= new AdaptiveQuality(qualityPref);
  const [settings, setSettings] = useState<QualitySettings>(() => adaptive.current!.settings);
  useEffect(() => {
    adaptive.current!.setPref(qualityPref);
    setSettings(adaptive.current!.settings);
  }, [qualityPref]);
  const surroundings = props.surroundings ?? 'full';
  const lite = surroundings === 'lite' || settings.level === 2;
  // Decorative ambient life never runs under reduced motion.
  const ambient = props.ambientLife !== false && !reducedMotion;

  const ctx = useMemo<TownCtx>(() => {
    const frame: TownFrame = {
      tick: 0,
      minute: 0,
      now: 0,
      dt: 0,
      t: 0,
      snapshot: null,
      speed: 0,
      walkPhase: 0,
      walkAmp: 0.6,
      tier: 1,
      zoom: 10,
      level: 'town',
      sky: null,
      entered: null,
      camAz: DEFAULT_AZ,
      ambientT: 0,
      version: 0,
    };
    return {
      town,
      places,
      uniforms,
      frame,
      live: { selected: null, hovered: null, follow: null, reducedMotion, quality: settings, lotPick: null, labelBudget: LABEL_BUDGET, ambient: true },
      residentPos: new Float32Array(MAX_RESIDENTS * 3),
      residentVisible: new Uint8Array(MAX_RESIDENTS),
      agentPos: new Map<string, Vector3>(),
      dioramaLabels: new ScopedLabelStore(),
      cam: createCamRuntime(),
      surround: new Set<Object3D>(),
    };
  }, [town, places, uniforms]);
  // Latest props, read inside the frame loop without re-rendering the scene.
  ctx.live.selected = props.selected;
  ctx.live.follow = props.follow;
  ctx.live.reducedMotion = reducedMotion;
  ctx.live.quality = settings;
  ctx.live.agentHouse = props.agentHouse;
  ctx.live.lotPick = props.lotPick ?? null;
  ctx.live.labelBudget = Math.max(0, Math.min(LABEL_BUDGET, props.labelBudget ?? LABEL_BUDGET));
  ctx.live.ambient = ambient;
  ctx.frame.entered = entered;
  uniforms.uFoliage.value = settings.foliage;

  const getState = useRef(props.getState);
  getState.current = props.getState;
  const onQuality = useCallback((s: QualitySettings) => setSettings(s), []);

  // Pointer: hover and click through the picker (labels are buttons of their own).
  const pick = useRef<PickFn | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hoverKey = useRef('');
  const hoveredLot = useRef<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const setHover = useCallback(
    (ref: EntityRef | null) => {
      const key = ref ? formatEntityRef(ref) : '';
      if (key === hoverKey.current) return;
      hoverKey.current = key;
      const p = latest.current;
      if (p.lotPick) {
        const lot = ref?.kind === 'lot' ? ref.id : null;
        if (lot !== hoveredLot.current) {
          hoveredLot.current = lot;
          p.onHoverLot?.(lot);
        }
      }
      ctx.live.hovered = ref?.kind === 'lot' ? null : ref;
      const pickable = ref && (ref.kind !== 'lot' || p.lotPick?.lots.some((l) => l.id === ref.id && l.state === 'free'));
      if (wrap.current) wrap.current.style.cursor = pickable ? 'pointer' : '';
      if (ref?.kind !== 'lot') p.onHover?.(ref);
    },
    [ctx],
  );
  const moveFrame = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target instanceof HTMLCanvasElement)) return;
    if (e.buttons) return;
    const r = wrap.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = requestAnimationFrame(() => setHover(pick.current?.(x, y) ?? null));
  };

  /** A click (or a label) on something: lots go to lot picking while it runs, everything else is a selection. */
  const choose = useCallback((ref: EntityRef | null) => {
    const p = latest.current;
    if (ref?.kind === 'lot') {
      if (p.lotPick?.lots.some((l) => l.id === ref.id && l.state === 'free')) p.onPickLot?.(ref.id);
      return;
    }
    p.onSelect(ref);
  }, []);
  const handlers = useRef<TownInputHandlers>({ pick: () => null, click: () => {}, doubleClick: () => {}, longPress: () => {} });
  handlers.current = {
    pick: (x, y) => pick.current?.(x, y) ?? null,
    click: (x, y) => choose(pick.current?.(x, y) ?? null),
    doubleClick: (x, y) => {
      const ref = pick.current?.(x, y);
      if (ref?.kind === 'building') props.onEnter?.(ref.id);
      else if (ref?.kind === 'agent') {
        const a = getState.current().snapshot?.agents.find((x) => x.agentId === ref.id);
        if (a) props.onEnter?.(a.buildingId);
      } else if (!ref) ctx.cam.flyToPixel?.(x, y);
    },
    longPress: (ref) => {
      if (ref.kind === 'lot') return choose(ref);
      props.onSelect(ref);
      props.onLongPress?.(ref);
    },
  };
  useTownInput(wrap, ctx.cam.ctl, handlers, { keyboard: props.keyboard !== false });

  // The HUD's window into the renderer.
  const api = useMemo<TownApi>(() => {
    const f = { width: town.width, height: town.height };
    const screen = (x: number, y: number, z: number): ScreenPoint | null => {
      const ctl = ctx.cam.ctl;
      if (ctl.width <= 1) return null;
      const s = project(ctl.view, x, y, z);
      const visible = s.depth > 0.5 && s.x >= 0 && s.y >= 0 && s.x <= ctl.width && s.y <= ctl.height;
      return { x: s.x, y: s.y, visible, depth: s.depth };
    };
    return {
      projectEntity: (ref) => {
        const a = entityAnchor(ctx, ref);
        return a ? screen(a[0], a[1], a[2]) : null;
      },
      projectBounds: (ref) => {
        const b = entityBox(ctx, ref);
        const ctl = ctx.cam.ctl;
        if (!b || ctl.width <= 1) return null;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (let i = 0; i < 8; i++) {
          const s = project(ctl.view, i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]);
          if (!(s.depth > 0.5)) return null;
          left = Math.min(left, s.x);
          right = Math.max(right, s.x);
          top = Math.min(top, s.y);
          bottom = Math.max(bottom, s.y);
        }
        return { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(ctl.width, right), bottom: Math.min(ctl.height, bottom) };
      },
      projectCell: (x, z, height = 0) => screen(sceneX(f, x), height, sceneZ(f, z)),
      groundAt: (px, py) => {
        const v = ctx.cam.ctl.view;
        const g = groundHit(v, px, py, v.d * 30);
        return g ? { x: gridX(f, g.x), z: gridY(f, g.z) } : null;
      },
      getCamera: () => ({ ...ctx.cam.state, footprint: ctx.cam.state.footprint.map((p) => [p[0], p[1]] as [number, number]) }),
      onFrame: (fn) => {
        ctx.cam.listeners.add(fn);
        return () => {
          ctx.cam.listeners.delete(fn);
        };
      },
    };
  }, [ctx, town]);
  useImperativeHandle(props.apiRef, () => api, [api]);

  const pool = useRef<LabelPoolHandle>(null);
  const gridEntered = entered && gridInteriorOf(town, entered) ? entered : null;
  const selectedAgentId = props.selected?.kind === 'agent' ? props.selected.id : null;
  const showLand = surroundings !== 'off';

  return (
    <div ref={wrap} className={styles.wrap} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} data-town-camera="free">
      <Canvas
        frameloop={props.paused ? 'never' : 'always'}
        shadows={settings.shadows ? 'variance' : false}
        dpr={settings.dpr}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        camera={{ position: [120, 120, 120], fov: 20, near: 1, far: 1200 }}
        fallback={<div className={styles.fallback}>WebGL is not available, so the 3D town cannot be shown. The map and the directory still show everything in it.</div>}
      >
        <TownContext.Provider value={ctx}>
          <FrameDriver getState={getState} />
          <SkyRig shadows={settings.shadows} mapSize={settings.level === 0 ? 2048 : 1024} />
          {showLand && <Atmosphere lite={lite} ambient={ambient} />}
          {showLand && <Surroundings layout={layout} lite={lite} ambient={ambient} />}
          {showLand && ambient && <AmbientLife layout={layout} lite={lite} />}
          <StaticTown seed={props.seed ?? 0} shadows={settings.shadows} layout={layout} />
          <ClockHands />
          <LampPools seed={props.seed ?? 0} layout={layout} />
          <Residents />
          <AgentHqs entered={entered} selectedAgentId={selectedAgentId} />
          {gridEntered && <Interior buildingId={gridEntered} />}
          <SelectionRings />
          {props.lotPick && <LotMarkers pick={props.lotPick} hovered={hoveredLot} />}
          <TownCamera
            request={props.cameraRequest}
            follow={props.follow}
            entered={entered}
            initialCam={props.initialCam}
            reducedMotion={reducedMotion}
            viewInsets={props.viewInsets}
            keyboard={props.keyboard !== false}
            onCamChange={props.onCamChange}
            onFollowBroken={props.onFollowBroken}
            onInteraction={props.onInteraction}
            onFly={props.onFly}
          />
          <TownLabelProjector pool={pool} obstacles={props.obstacles} />
          <Picker target={pick} />
          {props.onListener && <ListenerReporter layout={showLand ? layout : null} onListener={props.onListener} />}
          <PerfRender adaptive={adaptive} onQuality={onQuality} />
          <Ready wrap={wrap} onReady={props.onReady} />
        </TownContext.Provider>
      </Canvas>
      <TownLabelLayer ref={pool} onSelect={choose} onHover={setHover} />
      {entered && <LabelLayer store={ctx.dioramaLabels} onSelectAgent={() => {}} />}
    </div>
  );
}

/** Once per frame, before everything else: the tick to draw, the clock of day, ambient time and the dim of an open interior. */
function FrameDriver({ getState }: { getState: { current: TownCanvasProps['getState'] } }) {
  const ctx = useTown();
  const smoother = useMemo(() => new TickSmoother(1), []);
  const lastSnap = useRef<unknown>(null);
  useFrame((_, dt) => {
    const { frame, uniforms, live } = ctx;
    const s = getState.current();
    // The renderer's own per-frame work starts here (the data source's cost, e.g. the harness's sim, is not ours).
    const now = performance.now();
    if (s.snapshot !== lastSnap.current) {
      lastSnap.current = s.snapshot;
      smoother.reset();
    }
    frame.snapshot = s.snapshot;
    // The clock is in wall time (Date.now(), as the world store stamps it).
    const target = s.clock ? frameTick(s.clock, Date.now()) : (s.snapshot?.tick ?? 0);
    frame.tick = smoother.next(target);
    frame.speed = s.clock?.speed ?? s.snapshot?.speed ?? 0;
    frame.minute = minuteOfDay(frame.tick);
    frame.now = now;
    frame.dt = dt;
    if (!live.reducedMotion) frame.t += Math.min(dt, 0.1);
    // Decorative ambient life (cars, birds, clouds, shimmer) stands still while the world is paused.
    if (live.ambient && frame.speed > 0) frame.ambientT += Math.min(dt, 0.1);
    uniforms.uTime.value = frame.ambientT;
    frame.version++;
    // The town dims while an interior is open (cut under reduced motion).
    const goal = frame.entered ? 1 : 0;
    const d = uniforms.uDim;
    d.value = live.reducedMotion ? goal : d.value + (goal - d.value) * (1 - Math.exp(-Math.min(dt, 0.1) * 8));
    perfStart.t = now;
    ambientClock.ms = 0;
  }, -10);
  return null;
}

/** The soundscape's listener, about four times a second. */
function ListenerReporter({ layout, onListener }: { layout: ReturnType<typeof surroundLayout> | null; onListener: NonNullable<TownCanvasProps['onListener']> }) {
  const ctx = useTown();
  const fixed = useMemo(() => fixedSources(ctx.town, layout), [ctx.town, layout]);
  const last = useRef(0);
  const cb = useRef(onListener);
  cb.current = onListener;
  useFrame(() => {
    const now = ctx.frame.now;
    if (now - last.current < 250) return;
    last.current = now;
    const { frame, cam } = ctx;
    cb.current(
      computeListener({
        town: ctx.town,
        snapshot: frame.snapshot,
        layout,
        fixed,
        view: cam.ctl.view,
        fit: cam.fit,
        street: cam.street,
        level: frame.level,
        entered: frame.entered,
        minute: frame.minute,
        night: frame.sky?.night ?? 0,
        paused: frame.speed === 0,
      }),
    );
  });
  return null;
}

const perfStart = { t: 0, last: 0 };
const frustum = new Frustum();
const projScreen = new Matrix4();

/**
 * Renders the scene itself (priority 1), so per-frame costs are measured around it:
 * jsMs = the scene's own per-frame work (everything before the render call), renderMs = three's render
 * call (under SwiftShader it also waits on the rasteriser). Draw calls and triangles are those of the
 * main pass; a frame that also re-renders the (static) shadow map is reported separately. surroundCalls
 * counts the countryside's meshes in view (one draw each).
 */
function PerfRender({ adaptive, onQuality }: { adaptive: { current: AdaptiveQuality | null }; onQuality: (s: QualitySettings) => void }) {
  const ctx = useTown();
  const meter = useMemo(() => new PerfMeter(), []);
  const publishAt = useRef(0);
  const main = useRef({ calls: 0, triangles: 0, shadowCalls: 0 });
  const camera = useThree((s) => s.camera);
  useFrame(({ gl, scene }) => {
    const before = performance.now();
    const shadowFrame = gl.shadowMap.enabled && gl.shadowMap.needsUpdate;
    gl.render(scene, camera);
    const end = performance.now();
    if (shadowFrame) main.current.shadowCalls = Math.max(main.current.shadowCalls, gl.info.render.calls);
    else {
      main.current.calls = gl.info.render.calls;
      main.current.triangles = gl.info.render.triangles;
    }
    const frameMs = perfStart.last ? perfStart.t - perfStart.last : 0;
    perfStart.last = perfStart.t;
    meter.record(frameMs, before - perfStart.t, end - before, ambientClock.ms);
    const q = adaptive.current;
    if (q && frameMs > 0 && q.sample(frameMs, end)) onQuality(q.settings);
    if (end - publishAt.current > 250) {
      publishAt.current = end;
      let visible = 0;
      for (let i = 0; i < (ctx.frame.snapshot?.residents.length ?? 0); i++) if (ctx.residentVisible[i]) visible++;
      projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
      let surroundCalls = 0;
      for (const o of ctx.surround) {
        let shown = o.visible;
        for (let p = o.parent; p && shown; p = p.parent) shown = p.visible;
        if (!shown) continue;
        const count = (o as { count?: number }).count;
        if (count === 0) continue;
        if (!o.frustumCulled || frustum.intersectsObject(o)) surroundCalls++;
      }
      meter.publish({
        calls: main.current.calls,
        triangles: main.current.triangles,
        shadowCalls: main.current.shadowCalls,
        surroundCalls,
        tier: ctx.frame.tier,
        quality: q?.level ?? 0,
        residents: visible,
        actors: (ctx.frame.snapshot?.residents.length ?? 0) + (ctx.frame.snapshot?.agents.length ?? 0),
        labels: document.querySelectorAll('[data-town-label][data-shown="true"]').length,
        ambientT: Math.round(ctx.frame.ambientT * 100) / 100,
      });
    }
  }, 1);
  return null;
}

function Ready({ wrap, onReady }: { wrap: React.RefObject<HTMLDivElement | null>; onReady?: (() => void) | undefined }) {
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current !== 3) return;
    wrap.current?.setAttribute('data-world-ready', 'true');
    onReady?.();
  });
  return null;
}
