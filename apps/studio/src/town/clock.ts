/**
 * The renderer's clock (plan §5 Interpolation): the engine owns the tick; the
 * renderer extrapolates between authoritative updates as
 * `tick + (now − receivedAt) · speed / 1000`, clamped to MAX_AHEAD_MS of wall
 * time, frozen while paused. It never ticks the sim.
 *
 * TickSmoother keeps the displayed tick from stepping backwards when a new
 * authoritative tick lands slightly behind the extrapolation (walkers would
 * twitch backwards); a real jump (a reload, a resnapshot) is taken at once.
 */

/** The authoritative clock as last received, with the local time it arrived. */
export interface TownClock {
  /** World tick (sim minutes since Day 1 00:00) at `receivedAt`. */
  tick: number;
  /** Sim minutes per wall second (0 = paused). */
  speed: number;
  /** Wall time (Date.now() ms) at which the tick was received; the renderer extrapolates from it with Date.now(). */
  receivedAt: number;
}

/** How far past the last authoritative tick the renderer may run (wall ms). */
export const MAX_AHEAD_MS = 2000;

/** The fractional tick to draw at local time `now`. */
export function frameTick(clock: TownClock, now: number): number {
  if (clock.speed <= 0) return clock.tick;
  const dt = Math.min(MAX_AHEAD_MS, Math.max(0, now - clock.receivedAt));
  return clock.tick + (dt * clock.speed) / 1000;
}

/** A displayed tick that never steps back by less than `maxHoldTicks` (smaller corrections are absorbed). */
export class TickSmoother {
  private shown: number | null = null;
  constructor(private readonly maxHoldTicks = 1) {}

  next(target: number): number {
    if (this.shown === null || target >= this.shown || this.shown - target > this.maxHoldTicks) this.shown = target;
    return this.shown;
  }

  reset(): void {
    this.shown = null;
  }
}
