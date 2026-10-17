'use client';
import { Environment, Lightformer } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './Board';
import { CameraRig } from './CameraRig';
import { Characters } from './Characters';
import { CameraBus, SceneContext, type SceneCtx } from './context';
import { Effects } from './Effects';
import { LabelLayer, LabelProjector, LabelStore } from './labels';
import { buildPalette, documentTokens, type ScenePalette } from './palette';
import { Paths } from './Paths';
import { Props } from './Props';
import { SceneOverlay } from './SceneOverlay';
import { Stations } from './Stations';
import type { SceneProps } from './types';
import styles from './scene.module.css';

/** Screen areas the labels keep clear of: the stage's toolbars and roster, the provenance chips, the camera rail. */
const obstacles = (w: number, h: number) => [
  { l: 0, t: 0, r: 178, b: 46 },
  { l: w - 284, t: 0, r: w, b: 104 },
  { l: 0, t: h - 46, r: w, b: h },
  { l: w - 54, t: h / 2 - 62, r: w, b: h / 2 + 62 },
];

/**
 * The 3D world (Layer 3). Reads Layer 1 + 2 state through `getFrame()` every
 * frame and never mutates it. Rendered by the shell via next/dynamic (ssr:false).
 */
export default function WorldCanvas(props: SceneProps) {
  const {
    world,
    getFrame,
    subscribeEffects,
    selectedAgentId,
    selectedStationId,
    onSelectAgent,
    onSelectStation,
    cameraMode,
    follow,
    quality,
    reducedMotion,
    onReady,
    selectedSeq = null,
    onSelectEvent,
    status = { text: 'Live', live: true, detail: 'Events are arriving now.' },
  } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const palette = useScenePalette();

  const [labels] = useState(() => {
    const s = new LabelStore();
    s.obstacles = obstacles;
    return s;
  });
  const [camera] = useState(() => new CameraBus());
  const incidentStations = useMemo(() => new Map<string, string>(), [world]);
  // Stable wrapper, so a new callback from the shell does not re-render the whole scene.
  const selectEventRef = useRef(onSelectEvent);
  selectEventRef.current = onSelectEvent;
  const selectEvent = useCallback((seq: number, opts: { seek: boolean }) => selectEventRef.current?.(seq, opts), []);
  const ctx = useMemo<SceneCtx>(
    () => ({ world, getFrame, subscribeEffects, reducedMotion, incidentStations, labels, palette, camera, selectEvent }),
    [world, getFrame, subscribeEffects, reducedMotion, incidentStations, labels, palette, camera, selectEvent],
  );
  const bloom = quality === 'high' && !reducedMotion && palette.glow;

  return (
    <div ref={wrap} className={styles.wrap} data-scene-theme={palette.theme}>
      <Canvas
        orthographic
        flat
        dpr={quality === 'high' ? [1, 2] : [1, 1.25]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ position: [40, 48, 40], zoom: 30, near: 0.1, far: 400 }}
        onPointerMissed={() => {
          onSelectAgent(null);
          onSelectStation(null);
        }}
        fallback={<div className={styles.fallback}>WebGL is not available, so the 3D world cannot be shown. The Network view, timeline and logs still show everything that happened.</div>}
      >
        <SceneContext.Provider value={ctx}>
          <Lights palette={palette} />
          <Board />
          <Paths />
          <Props />
          <Stations selectedStationId={selectedStationId} onSelectStation={onSelectStation} />
          <Characters selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} />
          <Effects selectedSeq={selectedSeq} />
          <CameraRig cameraMode={cameraMode} follow={follow} selectedAgentId={selectedAgentId} selectedStationId={selectedStationId} />
          <LabelProjector />
          <Ready wrap={wrap} onReady={onReady} />
        </SceneContext.Provider>
        {bloom && (
          <EffectComposer multisampling={4}>
            <Bloom mipmapBlur intensity={0.7} luminanceThreshold={1} luminanceSmoothing={0.15} radius={0.55} />
            <Vignette offset={0.3} darkness={0.35} />
          </EffectComposer>
        )}
      </Canvas>
      <LabelLayer store={labels} onSelectAgent={onSelectAgent} onSelectEvent={(seq) => selectEvent(seq, { seek: false })} />
      <SceneOverlay
        world={world}
        getFrame={getFrame}
        camera={camera}
        selectedAgentId={selectedAgentId}
        selectedStationId={selectedStationId}
        selectedSeq={selectedSeq}
        onSelectEvent={selectEvent}
        status={status}
        incidentStations={incidentStations}
      />
    </div>
  );
}

/** Scene colours from the design tokens; re-read when the theme changes. */
function useScenePalette(): ScenePalette {
  const [palette, setPalette] = useState<ScenePalette>(() => buildPalette(documentTokens()));
  useEffect(() => {
    const update = () => {
      const next = buildPalette(documentTokens());
      setPalette((prev) => (JSON.stringify(prev.tokens) === JSON.stringify(next.tokens) ? prev : next));
    };
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener('change', update);
    update();
    return () => {
      mo.disconnect();
      mq?.removeEventListener('change', update);
    };
  }, []);
  return palette;
}

/** Memoized: re-rendering <Environment> would re-render its cube map (and PMREM) every time. */
const Lights = memo(function Lights({ palette }: { palette: ScenePalette }) {
  const l = palette.lights;
  return (
    <>
      <ambientLight intensity={l.ambient} color="#ffffff" />
      <hemisphereLight args={[l.hemiSky, l.hemiGround, l.hemi]} />
      <directionalLight position={[10, 16, 7]} intensity={l.key} color={l.keyColor} />
      <directionalLight position={[-12, 7, -6]} intensity={l.fill} color={l.fillColor} />
      {/* Neutral studio reflections for the glossy shells (no network: lightformers render on the GPU). */}
      <Environment resolution={64} environmentIntensity={l.env}>
        <Lightformer form="rect" intensity={2} color="#ffffff" position={[0, 6, 4]} scale={[8, 3, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#dfe5ee" position={[-6, 3, -2]} scale={[4, 4, 1]} />
        <Lightformer form="rect" intensity={0.6} color="#eef1f6" position={[6, 3, -4]} scale={[4, 4, 1]} />
      </Environment>
    </>
  );
});

/** Marks the wrapper data-world-ready="true" and calls onReady once the first frame has rendered. */
function Ready({ wrap, onReady }: { wrap: React.RefObject<HTMLDivElement | null>; onReady?: () => void }) {
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current !== 2) return;
    wrap.current?.setAttribute('data-world-ready', 'true');
    onReady?.();
  });
  return null;
}
