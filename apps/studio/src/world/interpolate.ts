/**
 * Sim time and positions between server frames (plan §5): the client clock is
 * `tick + (now − receivedAt)·speed/1000`, never more than 2 s ahead of the
 * last frame, and frozen while paused. Positions are closed form (a walk is a
 * path and a start tick), so nothing teleports between frames.
 */
import type { ResidentState, WorldSpeed } from '@runloop-world/events';

export interface WorldClock {
  /** The tick of the last clock frame or event batch. */
  tick: number;
  speed: WorldSpeed;
  /** Client time (ms) when that tick was received. */
  receivedAt: number;
  /** The host dropped ticks it could not run in time. */
  lagging: boolean;
}

/** How far ahead of the last frame the client extrapolates. */
export const MAX_AHEAD_MS = 2000;

/** Fractional sim tick now. */
export function tickNow(clock: WorldClock | null, nowMs: number): number {
  if (!clock) return 0;
  if (clock.speed === 0) return clock.tick;
  const elapsed = Math.min(Math.max(0, nowMs - clock.receivedAt), MAX_AHEAD_MS);
  return clock.tick + (elapsed * clock.speed) / 1000;
}

/**
 * The local time a clock frame's tick began: the frame's `wallMs` (the
 * runtime runs on this machine, so its wall clock is ours), else the time it
 * arrived. A `wallMs` from the future or far in the past (a skewed clock) is
 * not trusted.
 */
export function frameAnchor(wallMs: number | undefined, nowMs: number): number {
  return wallMs !== undefined && wallMs <= nowMs && nowMs - wallMs < MAX_AHEAD_MS ? wallMs : nowMs;
}

/**
 * The clock after a frame, anchored at the frame's `wallMs` so the client's
 * fractional tick matches the runtime's. A frame behind the extrapolated time
 * does not move the displayed clock backwards by less than a tick (no
 * jitter); a real jump (a resync, a pause) is taken as is.
 */
export function nextClock(prev: WorldClock | null, frame: { tick: number; speed: WorldSpeed; lagging?: boolean; wallMs?: number }, nowMs: number): WorldClock {
  const lagging = frame.lagging ?? prev?.lagging ?? false;
  const next: WorldClock = { tick: frame.tick, speed: frame.speed, receivedAt: frameAnchor(frame.wallMs, nowMs), lagging };
  if (prev && prev.speed === frame.speed && frame.speed > 0) {
    const shown = tickNow(prev, nowMs);
    const fresh = tickNow(next, nowMs);
    if (fresh < shown && shown - fresh < 1) return { tick: shown, speed: frame.speed, receivedAt: nowMs, lagging };
  }
  return next;
}

/**
 * The clock right after a `world.clock_changed` event (pause, resume, a new
 * speed): re-based at the event's tick so the client stops extrapolating at
 * the old speed. Pausing never moves the displayed time backwards.
 */
export function clockAfterSpeedChange(prev: WorldClock | null, e: { tick: number; speed: WorldSpeed }, nowMs: number): WorldClock {
  const shown = tickNow(prev, nowMs);
  const tick = e.speed === 0 && prev ? Math.max(e.tick, shown) : e.tick;
  return { tick, speed: e.speed, receivedAt: nowMs, lagging: prev?.lagging ?? false };
}

/** A position on the town grid in cells (fractional while walking). */
export interface GridPos {
  x: number;
  y: number;
  walking: boolean;
}

/**
 * Where a walking resident is at fractional `tick` (`cellsPerMinute` from the
 * town file), interpolated between path cells. Null when not walking.
 */
export function walkPosition(motion: NonNullable<ResidentState['motion']>, tick: number, cellsPerMinute: number): GridPos {
  const path = motion.path;
  const f = Math.min(path.length - 1, Math.max(0, (tick - motion.startTick) * cellsPerMinute));
  const i = Math.floor(f);
  const a = path[i]!;
  const b = path[Math.min(path.length - 1, i + 1)]!;
  const t = f - i;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, walking: f < path.length - 1 };
}

/** "Day 3 · 14:20" parts of a fractional tick. */
export function clockParts(tick: number): { day: number; hh: string; mm: string; minuteOfDay: number } {
  const t = Math.floor(tick);
  const day = Math.floor(t / 1440);
  const minute = t - day * 1440;
  return { day: day + 1, hh: String(Math.floor(minute / 60)).padStart(2, '0'), mm: String(minute % 60).padStart(2, '0'), minuteOfDay: minute };
}
