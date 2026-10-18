'use client';
import { useEffect, useState } from 'react';
import { MOBILE_QUERY, useMediaQuery } from '../../ui/useMediaQuery';
import { useWorld } from '../../world/context';
import Town3D from './Town3D';
import WorldMap from './WorldMap';
import styles from './WorldHome.module.css';

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

/** Which view draws the town: the 3D town, or the 2D map (phones, no WebGL). Null before mount. */
export function useStageKind(): '3d' | 'map' | null {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const webgl = useWebGL();
  if (mobile || webgl === false) return 'map';
  return webgl === null ? null : '3d';
}

/**
 * The town itself, full-bleed: the 3D town (workstream B1's renderer). Below
 * 760 px or without WebGL the 2D WorldMap takes over (plan §5); every 3D
 * interaction has this 2D route.
 */
export default function TownStage() {
  const kind = useStageKind();
  const status = useWorld((s) => s.status);
  const hasTown = useWorld((s) => s.town !== null);
  return (
    <div className={styles.stage} data-kind={kind ?? undefined}>
      {!hasTown || kind === null ? <StageMessage status={status} /> : kind === '3d' ? <Town3D /> : <WorldMap variant="stage" />}
    </div>
  );
}

function StageMessage({ status }: { status: string }) {
  return (
    <div className={styles.stageMessage} role="status">
      {status === 'disabled'
        ? 'The world is turned off in this runtime (RUNLOOP_WORLD=off). Sessions, Traces and Experiments still work.'
        : status === 'offline'
          ? 'The runtime is not answering. Start it with “pnpm serve”; the town picks up where it left off.'
          : 'Loading the town…'}
    </div>
  );
}
