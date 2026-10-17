'use client';
import { Environment, Lightformer } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { memo, useMemo, useRef, useState } from 'react';
import { Board } from './Board';
import { CameraRig } from './CameraRig';
import { Characters } from './Characters';
import { SceneContext, type SceneCtx } from './context';
import { Effects } from './Effects';
import { LabelLayer, LabelProjector, LabelStore } from './labels';
import { Paths } from './Paths';
import { Props } from './Props';
import { Stations } from './Stations';
import type { SceneProps } from './types';
import styles from './scene.module.css';

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
  } = props;
  const wrap = useRef<HTMLDivElement>(null);

  const [labels] = useState(() => new LabelStore());
  const incidentStations = useMemo(() => new Map<string, string>(), [world]);
  const ctx = useMemo<SceneCtx>(
    () => ({ world, getFrame, subscribeEffects, reducedMotion, incidentStations, labels }),
    [world, getFrame, subscribeEffects, reducedMotion, incidentStations, labels],
  );
  const bloom = quality === 'high' && !reducedMotion;

  return (
    <div ref={wrap} className={styles.wrap}>
      <Canvas
        orthographic
        dpr={quality === 'high' ? [1, 2] : [1, 1.25]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ position: [40, 48, 40], zoom: 30, near: 0.1, far: 400 }}
        onPointerMissed={() => {
          onSelectAgent(null);
          onSelectStation(null);
        }}
        fallback={<div className={styles.fallback}>WebGL is not available, so the 3D world cannot be shown. The timeline and logs still show everything that happened.</div>}
      >
        <SceneContext.Provider value={ctx}>
          <Lights />
          <Board />
          <Paths />
          <Props />
          <Stations selectedStationId={selectedStationId} onSelectStation={onSelectStation} />
          <Characters selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} />
          <Effects />
          <CameraRig cameraMode={cameraMode} follow={follow} selectedAgentId={selectedAgentId} selectedStationId={selectedStationId} />
          <LabelProjector />
          <Ready wrap={wrap} onReady={onReady} />
        </SceneContext.Provider>
        {bloom && (
          <EffectComposer multisampling={4}>
            <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.8} luminanceSmoothing={0.3} radius={0.72} />
            <Vignette offset={0.25} darkness={0.55} />
          </EffectComposer>
        )}
      </Canvas>
      <LabelLayer store={labels} onSelectAgent={onSelectAgent} />
    </div>
  );
}

/** Memoized: re-rendering <Environment> would re-render its cube map (and PMREM) every time. */
const Lights = memo(function Lights() {
  return (
    <>
      <ambientLight intensity={0.45} color="#8ea2c8" />
      <hemisphereLight args={['#a5b8ff', '#1a1030', 0.7]} />
      <directionalLight position={[10, 16, 7]} intensity={1.5} color="#fff1dc" />
      <directionalLight position={[-12, 7, -6]} intensity={0.55} color="#a78bfa" />
      {/* Local reflections for glossy surfaces (no network: lightformers render on the GPU). */}
      <Environment resolution={128} environmentIntensity={0.55}>
        <Lightformer form="rect" intensity={2.2} color="#ffffff" position={[0, 6, 4]} scale={[8, 3, 1]} />
        <Lightformer form="rect" intensity={1.4} color="#22d3ee" position={[-6, 3, -2]} scale={[4, 4, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#a78bfa" position={[6, 3, -4]} scale={[4, 4, 1]} />
        <Lightformer form="ring" intensity={0.8} color="#f59e0b" position={[0, -4, 0]} scale={4} />
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
