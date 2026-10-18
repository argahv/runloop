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
  /** Wall time between frames (ms). */
  frameMs: { p50: number; p95: number };
  /** The scene's own JS per frame: interpolation, residents, robots, labels, camera (ms). */
  jsMs: { p50: number; p95: number };
  /** three's render call (ms); under SwiftShader it includes waiting on the rasteriser. */
  renderMs: { p50: number; p95: number };
  tier: number;
  quality: number;
  /** Residents drawn now, and actors (residents + agents) in the state. */
  residents: number;
  actors: number;
  labels: number;
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
  private count = 0;
  last: PerfSnapshot | null = null;

  constructor() {
    if (typeof window !== 'undefined') window.__runloopPerfReset = () => this.reset();
  }

  reset(): void {
    this.frames = [];
    this.js = [];
    this.render = [];
    this.count = 0;
  }

  record(frameMs: number, jsMs: number, renderMs: number): void {
    this.count++;
    if (frameMs > 0 && frameMs < 5000) this.frames.push(frameMs);
    this.js.push(jsMs);
    this.render.push(renderMs);
    for (const a of [this.frames, this.js, this.render]) if (a.length > WINDOW) a.shift();
  }

  publish(extra: Omit<PerfSnapshot, 'frameMs' | 'jsMs' | 'renderMs' | 'frames'>): PerfSnapshot {
    const pct = (a: number[]) => ({ p50: round(percentile(a, 50)), p95: round(percentile(a, 95)) });
    const snap: PerfSnapshot = { ...extra, frameMs: pct(this.frames), jsMs: pct(this.js), renderMs: pct(this.render), frames: this.count };
    this.last = snap;
    if (typeof window !== 'undefined') window.__runloopPerf = snap;
    return snap;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
