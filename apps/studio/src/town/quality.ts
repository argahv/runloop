/**
 * Adaptive quality (plan §5): with `auto`, the renderer steps down one level
 * when the p95 frame time stays above 22 ms for 2 s, and back up after 10 s
 * under 12 ms. Pure (fed frame times and timestamps), so it is unit-tested.
 *
 * Levels, best first. Each step down applies the next saving:
 *   0 high:   dpr up to 2, shadows, full foliage
 *   1 medium: dpr 1.25, shadows
 *   2 low:    dpr 1, no shadows, half the foliage, a tighter full-rig band
 */

export type QualityPref = 'auto' | 'high' | 'low';
export type QualityLevel = 0 | 1 | 2;

export interface QualitySettings {
  level: QualityLevel;
  dpr: [number, number];
  shadows: boolean;
  /** Fraction of decoration drawn (trees and props), 0–1. */
  foliage: number;
  /** Projected height (px) at which residents get the full rig. */
  t0Px: number;
}

export const QUALITY_LEVELS: readonly QualitySettings[] = [
  { level: 0, dpr: [1, 2], shadows: true, foliage: 1, t0Px: 28 },
  { level: 1, dpr: [1, 1.25], shadows: true, foliage: 1, t0Px: 28 },
  { level: 2, dpr: [1, 1], shadows: false, foliage: 0.5, t0Px: 40 },
];

export const STEP_DOWN_MS = 22;
export const STEP_DOWN_HOLD = 2000;
export const STEP_UP_MS = 12;
export const STEP_UP_HOLD = 10_000;
/** Frames in the rolling window. */
const WINDOW = 90;

/** p-th percentile (0–100) of a list (nearest rank). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

export class AdaptiveQuality {
  private frames: number[] = [];
  private overSince: number | null = null;
  private underSince: number | null = null;
  level: QualityLevel;

  constructor(
    private pref: QualityPref,
    /** The best level auto may use (a pinned preference uses exactly it). */
    private readonly top: QualityLevel = 0,
  ) {
    this.level = pref === 'low' ? 2 : pref === 'high' ? 0 : top;
  }

  setPref(pref: QualityPref): void {
    this.pref = pref;
    this.level = pref === 'low' ? 2 : pref === 'high' ? 0 : this.top;
    this.frames = [];
    this.overSince = this.underSince = null;
  }

  get settings(): QualitySettings {
    return QUALITY_LEVELS[this.level]!;
  }

  /** p95 of the rolling window (ms). */
  p95(): number {
    return percentile(this.frames, 95);
  }

  /** Record one frame's duration at time `now` (ms); returns true when the level changed. */
  sample(frameMs: number, now: number): boolean {
    this.frames.push(frameMs);
    if (this.frames.length > WINDOW) this.frames.shift();
    if (this.pref !== 'auto' || this.frames.length < 20) return false;
    const p95 = this.p95();
    if (p95 > STEP_DOWN_MS) {
      this.underSince = null;
      this.overSince ??= now;
      if (now - this.overSince >= STEP_DOWN_HOLD && this.level < 2) {
        this.level = (this.level + 1) as QualityLevel;
        this.reset();
        return true;
      }
    } else if (p95 < STEP_UP_MS) {
      this.overSince = null;
      this.underSince ??= now;
      if (now - this.underSince >= STEP_UP_HOLD && this.level > this.top) {
        this.level = (this.level - 1) as QualityLevel;
        this.reset();
        return true;
      }
    } else {
      this.overSince = this.underSince = null;
    }
    return false;
  }

  private reset(): void {
    this.frames = [];
    this.overSince = this.underSince = null;
  }
}
