'use client';
import { useEffect, useState, type Ref } from 'react';
import type { TownApi, TownListener } from '../../town/types';
import { useWorld, useWorldStore } from '../../world/context';
import { useTownView } from './hud/viewPref';
import styles from './hud/hud.module.css';
import Town3D from './Town3D';
import WorldMap from './WorldMap';

/** Probed once per page load (each probe costs a GL context). */
let webglCache: boolean | null = null;

function probeWebGL(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    webglCache = !!gl;
    (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/** null while unknown (before mount), then whether a WebGL context can be created. */
export function useWebGL(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(webglCache);
  useEffect(() => setOk(probeWebGL()), []);
  return ok;
}

/**
 * Which view draws the town: the 3D town (phones too, lighter: contract §5.6),
 * or the 2D map (no WebGL, or the viewer chose it in the Esc menu). Null
 * before mount.
 */
export function useStageKind(): '3d' | 'map' | null {
  const webgl = useWebGL();
  const view = useTownView();
  if (webgl === false || view === 'map') return 'map';
  return webgl === null ? null : '3d';
}

/**
 * The town itself, edge to edge: the 3D town, or the 2D WorldMap (every 3D
 * interaction has this 2D route). It tells the world store which one draws,
 * so Add to World picks lots in 3D or opens its dialog.
 */
export default function TownStage({ apiRef, onFly, onListener }: { apiRef?: Ref<TownApi>; onFly?: (ms: number, pan: number) => void; onListener?: (l: TownListener) => void }) {
  const store = useWorldStore();
  const kind = useStageKind();
  const status = useWorld((s) => s.status);
  const hasTown = useWorld((s) => s.town !== null);
  const ready = useWorld((s) => s.townReady);
  useEffect(() => {
    store.getState().setStage(kind);
    return () => store.getState().setStage(null);
  }, [store, kind]);
  // The 2D map draws at once; the 3D town says when its first frames are on screen (Town3D's onReady).
  useEffect(() => {
    if (kind === 'map' && hasTown) store.getState().setTownReady(true);
    return () => store.getState().setTownReady(false);
  }, [store, kind, hasTown]);
  const stuck = status === 'disabled' || status === 'offline';
  return (
    <div className={styles.stage} data-kind={kind ?? undefined}>
      {hasTown && kind === '3d' && <Town3D {...(apiRef ? { apiRef } : {})} {...(onFly ? { onFly } : {})} {...(onListener ? { onListener } : {})} />}
      {hasTown && kind === 'map' && <WorldMap variant="stage" />}
      {stuck && !hasTown ? <StageMessage status={status} /> : !ready && <LoadingVeil />}
    </div>
  );
}

function StageMessage({ status }: { status: string }) {
  return (
    <div className={styles.stageMessage} role="status">
      {status === 'disabled'
        ? 'The world is turned off in this runtime (RUNLOOP_WORLD=off). Sessions, Traces and Experiments still work: open them from the menu (Esc → Pages).'
        : 'The runtime is not answering. Start it with “pnpm serve”; the town picks up where it left off.'}
    </div>
  );
}

/** Until the town is on screen: its name over the sky and a progress line (never an empty haze under a live HUD). */
function LoadingVeil() {
  const name = useWorld((s) => s.town?.def.name ?? null);
  const hasTown = useWorld((s) => s.town !== null);
  return (
    <div className={styles.veil} role="status" aria-live="polite">
      <p className={styles.veilName}>{name ?? 'Runloop'}</p>
      <p className={styles.veilText}>{hasTown ? 'Drawing the town…' : 'Loading the town…'}</p>
      <span className={styles.veilLine} aria-hidden="true" />
    </div>
  );
}
