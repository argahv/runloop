/**
 * Render instrumentation (plan §9 Render budgets): `window.__runloopPerf`
 * exposes draw calls, triangles, frame and JS time percentiles, the LOD tier
 * and the quality level, read by scripts/perf-town.mjs. Pure apart from the
 * window write.
 */
import { percentile } from './quality';

export interface PerfSnapshot {
  /** Draw calls and triangles of the main pass. */
  calls: number;
  triangles: number;
  /** Draw calls of the latest frame that also re-rendered the static shadow map (0 = none yet). */
  shadowCalls: number;
  /** Of the main pass's calls, the land beyond the town (terrain, roads, fields, farms, trees, water, mountains, sky, clouds, cars, birds) in view. */
  surroundCalls: number;
  /** Wall time between frames (ms). */
  frameMs: { p50: number; p95: number };
  /** The scene's own JS per frame: interpolation, residents, robots, labels, camera (ms). */
  jsMs: { p50: number; p95: number };
  /** three's render call (ms); under SwiftShader it includes waiting on the rasteriser. */
  renderMs: { p50: number; p95: number };
  /** Of jsMs, the land beyond the town and its ambient life (sky, fog, clouds, trees, windmill, cars, birds). */
  ambientMs: { p50: number; p95: number };
  tier: number;
  quality: number;
  /** Residents drawn now, and actors (residents + agents) in the state. */
  residents: number;
  actors: number;
  labels: number;
  /** The decorative ambient clock (s): stands still while the world is paused or under reduced motion. */
  ambientT: number;
  frames: number;
}

declare global {
  interface Window {
    __runloopPerf?: PerfSnapshot;
    /** Start a fresh measurement window (perf-town.mjs calls it once the scene has warmed up). */
    __runloopPerfReset?: () => void;
  }
}

const WINDOW = 240;

export class PerfMeter {
  private frames: number[] = [];
  private js: number[] = [];
  private render: number[] = [];
  private ambient: number[] = [];
  private count = 0;
  last: PerfSnapshot | null = null;

  constructor() {
    if (typeof window !== 'undefined') window.__runloopPerfReset = () => this.reset();
  }

  reset(): void {
    this.frames = [];
    this.js = [];
    this.render = [];
    this.ambient = [];
    this.count = 0;
  }

  record(frameMs: number, jsMs: number, renderMs: number, ambientMs = 0): void {
    this.count++;
    if (frameMs > 0 && frameMs < 5000) this.frames.push(frameMs);
    this.js.push(jsMs);
    this.render.push(renderMs);
    this.ambient.push(ambientMs);
    for (const a of [this.frames, this.js, this.render, this.ambient]) if (a.length > WINDOW) a.shift();
  }

  publish(extra: Omit<PerfSnapshot, 'frameMs' | 'jsMs' | 'renderMs' | 'ambientMs' | 'frames'>): PerfSnapshot {
    const pct = (a: number[]) => ({ p50: round(percentile(a, 50)), p95: round(percentile(a, 95)) });
    const snap: PerfSnapshot = { ...extra, frameMs: pct(this.frames), jsMs: pct(this.js), renderMs: pct(this.render), ambientMs: pct(this.ambient), frames: this.count };
    this.last = snap;
    if (typeof window !== 'undefined') window.__runloopPerf = snap;
    return snap;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Per-frame time spent on the land beyond the town (the components add to it; PerfRender records and clears it). */
export const ambientClock = { ms: 0 };

/** Wrap a per-frame callback so its time counts towards the land's share (ambientClock). */
export function timed<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  return (...a) => {
    const t0 = performance.now();
    try {
      fn(...a);
    } finally {
      ambientClock.ms += performance.now() - t0;
    }
  };
}
