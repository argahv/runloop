'use client';
import { Canvas, useFrame } from '@react-three/fiber';
import { formatEntityRef, type EntityRef } from '@runloop-world/events';
import { minuteOfDay } from '@runloop-world/town';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Vector3 } from 'three';
import { LabelLayer } from '../scene/labels';
import { AgentHqs } from './AgentHq';
import { ScopedLabelStore } from './AgentHouse';
import { TickSmoother, frameTick } from './clock';
import { TownContext, useTown, type TownCtx, type TownFrame } from './context';
import { Interior } from './Interior';
import { TownLabelLayer, TownLabelProjector, type LabelPoolHandle } from './labels';
import { ClockHands, LampPools, SelectionRings } from './Markers';
import { PerfMeter } from './perf';
import { Picker, type PickFn } from './Picker';
import { TownPlaces, gridInteriorOf } from './place';
import { AdaptiveQuality, type QualitySettings } from './quality';
import { Residents } from './Residents';
import { SkyRig } from './SkyRig';
import { StaticTown } from './StaticTown';
import { TownCamera, DEFAULT_AZ } from './TownCamera';
import { createTownUniforms } from './townMaterial';
import type { TownCanvasProps } from './types';
import styles from './town.module.css';

const MAX_RESIDENTS = 600;

/**
 * The town (plan §5 Rendering): a persistent, populated isometric town drawn
 * from the engine's state. Default export, for next/dynamic with ssr: false.
 * See README.md for the contract with the shell.
 */
export default function TownCanvas(props: TownCanvasProps) {
  const { town, quality: qualityPref, reducedMotion, entered } = props;
  const places = useMemo(() => new TownPlaces(town), [town]);
  const uniforms = useMemo(() => createTownUniforms(town.buildings.length, town.width), [town]);
  const adaptive = useRef<AdaptiveQuality | null>(null);
  adaptive.current ??= new AdaptiveQuality(qualityPref);
  const [settings, setSettings] = useState<QualitySettings>(() => adaptive.current!.settings);
  useEffect(() => {
    adaptive.current!.setPref(qualityPref);
    setSettings(adaptive.current!.settings);
  }, [qualityPref]);

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
      version: 0,
    };
    return {
      town,
      places,
      uniforms,
      frame,
      live: { selected: null, hovered: null, follow: null, reducedMotion, quality: settings },
      residentPos: new Float32Array(MAX_RESIDENTS * 3),
      residentVisible: new Uint8Array(MAX_RESIDENTS),
      agentPos: new Map<string, Vector3>(),
      dioramaLabels: new ScopedLabelStore(),
    };
  }, [town, places, uniforms]);
  // Latest props, read inside the frame loop without re-rendering the scene.
  ctx.live.selected = props.selected;
  ctx.live.follow = props.follow;
  ctx.live.reducedMotion = reducedMotion;
  ctx.live.quality = settings;
  ctx.live.agentHouse = props.agentHouse;
  ctx.frame.entered = entered;
  uniforms.uFoliage.value = settings.foliage;

  const getState = useRef(props.getState);
  getState.current = props.getState;
  const onQuality = useCallback((s: QualitySettings) => setSettings(s), []);

  // Pointer: hover and click through the picker (labels are buttons of their own).
  const pick = useRef<PickFn | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const hoverKey = useRef('');
  const onHoverRef = useRef(props.onHover);
  onHoverRef.current = props.onHover;
  const setHover = useCallback(
    (ref: EntityRef | null) => {
      const key = ref ? formatEntityRef(ref) : '';
      if (key === hoverKey.current) return;
      hoverKey.current = key;
      ctx.live.hovered = ref;
      if (wrap.current) wrap.current.style.cursor = ref ? 'pointer' : '';
      onHoverRef.current?.(ref);
    },
    [ctx],
  );
  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const moveFrame = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target instanceof HTMLCanvasElement)) return;
    if (down.current && e.buttons) return;
    const { x, y } = local(e);
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = requestAnimationFrame(() => setHover(pick.current?.(x, y) ?? null));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    down.current = { x, y, t: performance.now() };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || !(e.target instanceof HTMLCanvasElement)) return;
    const { x, y } = local(e);
    if (Math.hypot(x - d.x, y - d.y) > 5 || performance.now() - d.t > 600) return;
    props.onSelect(pick.current?.(x, y) ?? null);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!(e.target instanceof HTMLCanvasElement)) return;
    const { x, y } = local(e);
    const ref = pick.current?.(x, y);
    if (ref?.kind === 'building') props.onEnter?.(ref.id);
    else if (ref?.kind === 'agent') {
      const a = getState.current().snapshot?.agents.find((x) => x.agentId === ref.id);
      if (a) props.onEnter?.(a.buildingId);
    }
  };

  const pool = useRef<LabelPoolHandle>(null);
  const gridEntered = entered && gridInteriorOf(town, entered) ? entered : null;
  const selectedAgentId = props.selected?.kind === 'agent' ? props.selected.id : null;

  return (
    <div
      ref={wrap}
      className={styles.wrap}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={onDoubleClick}
    >
      <Canvas
        orthographic
        shadows={settings.shadows ? 'variance' : false}
        dpr={settings.dpr}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ position: [80, 80, 80], zoom: 10, near: 1, far: 600 }}
        fallback={<div className={styles.fallback}>WebGL is not available, so the 3D town cannot be shown. The map and the directory still show everything in it.</div>}
      >
        <TownContext.Provider value={ctx}>
          <FrameDriver getState={getState} />
          <SkyRig shadows={settings.shadows} mapSize={settings.level === 0 ? 2048 : 1024} />
          <StaticTown seed={props.seed ?? 0} shadows={settings.shadows} />
          <ClockHands />
          <LampPools seed={props.seed ?? 0} />
          <Residents />
          <AgentHqs entered={entered} selectedAgentId={selectedAgentId} />
          {gridEntered && <Interior buildingId={gridEntered} />}
          <SelectionRings />
          <TownCamera
            request={props.cameraRequest}
            follow={props.follow}
            entered={entered}
            initialCam={props.initialCam}
            reducedMotion={reducedMotion}
            onCamChange={props.onCamChange}
            onFollowBroken={props.onFollowBroken}
          />
          <TownLabelProjector pool={pool} obstacles={props.obstacles} />
          <Picker target={pick} />
          <PerfRender adaptive={adaptive} onQuality={onQuality} />
          <Ready wrap={wrap} onReady={props.onReady} />
        </TownContext.Provider>
      </Canvas>
      <TownLabelLayer ref={pool} onSelect={(r) => props.onSelect(r)} onHover={setHover} />
      {entered && <LabelLayer store={ctx.dioramaLabels} onSelectAgent={() => {}} />}
    </div>
  );
}

/** Once per frame, before everything else: the tick to draw, the clock of day and the dim of an open interior. */
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
    frame.version++;
    // The town dims while an interior is open (cut under reduced motion).
    const goal = frame.entered ? 1 : 0;
    const d = uniforms.uDim;
    d.value = live.reducedMotion ? goal : d.value + (goal - d.value) * (1 - Math.exp(-Math.min(dt, 0.1) * 8));
    perfStart.t = now;
  }, -10);
  return null;
}

const perfStart = { t: 0, last: 0 };

/**
 * Renders the scene itself (priority 1), so per-frame costs are measured around it:
 * jsMs = the scene's own per-frame work (everything before the render call), renderMs = three's render
 * call (under SwiftShader it also waits on the rasteriser). Draw calls and triangles are those of the
 * main pass; a frame that also re-renders the (static) shadow map is reported separately.
 */
function PerfRender({ adaptive, onQuality }: { adaptive: { current: AdaptiveQuality | null }; onQuality: (s: QualitySettings) => void }) {
  const ctx = useTown();
  const meter = useMemo(() => new PerfMeter(), []);
  const publishAt = useRef(0);
  const main = useRef({ calls: 0, triangles: 0, shadowCalls: 0 });
  useFrame(({ gl, scene, camera }) => {
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
    meter.record(frameMs, before - perfStart.t, end - before);
    const q = adaptive.current;
    if (q && frameMs > 0 && q.sample(frameMs, end)) onQuality(q.settings);
    if (end - publishAt.current > 250) {
      publishAt.current = end;
      let visible = 0;
      for (let i = 0; i < (ctx.frame.snapshot?.residents.length ?? 0); i++) if (ctx.residentVisible[i]) visible++;
      meter.publish({
        calls: main.current.calls,
        triangles: main.current.triangles,
        shadowCalls: main.current.shadowCalls,
        tier: ctx.frame.tier,
        quality: q?.level ?? 0,
        residents: visible,
        actors: (ctx.frame.snapshot?.residents.length ?? 0) + (ctx.frame.snapshot?.agents.length ?? 0),
        labels: document.querySelectorAll('[data-town-label][data-shown="true"]').length,
      });
    }
  }, 1);
  return null;
}

function Ready({ wrap, onReady }: { wrap: React.RefObject<HTMLDivElement | null>; onReady?: () => void }) {
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current !== 3) return;
    wrap.current?.setAttribute('data-world-ready', 'true');
    onReady?.();
  });
  return null;
}

