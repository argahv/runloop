import type { Cell } from './definition';
import { bfs } from './grid';
import type { CompiledWorld, Motion } from './types';

export interface MotionSample {
  /** Continuous grid position (cell centres are integers). */
  x: number;
  y: number;
  /** Cell the character is in (or leaving). */
  cell: Cell;
  /** Cell being walked to next (equals `cell` once arrived). */
  next: Cell;
  /** Progress from `cell` to `next` in [0, 1). */
  frac: number;
  arrived: boolean;
}

/**
 * Closed-form position on a motion at `tick` (fractional ticks allowed, giving
 * smooth continuous x/y). No tick loop: one cell per `ticksPerCell` ticks.
 */
export function positionAt(motion: Motion, tick: number, ticksPerCell: number): MotionSample {
  const { path } = motion;
  const last = path.length - 1;
  const steps = Math.max(0, tick - motion.startTick) / ticksPerCell;
  if (steps >= last) {
    const end = path[last]!;
    return { x: end[0], y: end[1], cell: end, next: end, frac: 0, arrived: true };
  }
  const i = Math.floor(steps);
  const frac = steps - i;
  const cell = path[i]!;
  const next = path[i + 1]!;
  return {
    x: cell[0] + (next[0] - cell[0]) * frac,
    y: cell[1] + (next[1] - cell[1]) * frac,
    cell,
    next,
    frac,
    arrived: false,
  };
}

/** The cell the character occupies or is currently stepping into at `tick`. */
export function enteringCell(motion: Motion, tick: number, ticksPerCell: number): Cell {
  const p = positionAt(motion, tick, ticksPerCell);
  return p.frac > 0 ? p.next : p.cell;
}

/** Tick at which the motion reaches its last cell. */
export function arrivalTick(motion: Motion, ticksPerCell: number): number {
  return motion.startTick + (motion.path.length - 1) * ticksPerCell;
}

/** Milliseconds → fractional ticks. */
export function msToTick(ms: number, tickHz: number): number {
  return (ms * tickHz) / 1000;
}

/**
 * Integer tick of an event: floor of its time since run start, clamped so it
 * never goes below the previous event's tick (timestamps may be non-monotonic;
 * order always comes from `sequence`).
 */
export function eventTick(prevTick: number, eventMs: number, runStartMs: number, tickHz: number): number {
  return Math.max(prevTick, 0, Math.floor(msToTick(eventMs - runStartMs, tickHz)));
}

const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1];

/**
 * Where a walk is when interrupted at `tick`: the step index `i` of the cell
 * being left and whether the character is mid-step (heading to path[i + 1]).
 */
function interruptionPoint(motion: Motion, tick: number, ticksPerCell: number) {
  const last = motion.path.length - 1;
  const steps = Math.max(0, tick - motion.startTick) / ticksPerCell;
  if (steps >= last) return { i: last, midStep: false };
  const i = Math.floor(steps);
  return { i, midStep: steps > i };
}

/**
 * Stop at the cell being entered at `tick`: finish the current step, then
 * stand still. Never teleports or reverses mid-step.
 */
export function haltMotion(motion: Motion, tick: number, ticksPerCell: number): Motion {
  const { i, midStep } = interruptionPoint(motion, tick, ticksPerCell);
  const { path } = motion;
  if (midStep) return { path: [path[i]!, path[i + 1]!], startTick: motion.startTick + i * ticksPerCell };
  if (i === path.length - 1) return motion; // already standing at the end
  return { path: [path[i]!], startTick: tick };
}

/**
 * Re-plan towards `dest` from the cell being entered at `tick`. The current
 * step is kept as a prefix so positionAt stays continuous across the switch.
 * If the motion already ends at `dest` it is returned unchanged.
 */
export function redirectMotion(world: CompiledWorld, motion: Motion, tick: number, dest: Cell): Motion {
  const tpc = world.def.ticksPerCell;
  if (sameCell(motion.path[motion.path.length - 1]!, dest)) return motion;
  const { i, midStep } = interruptionPoint(motion, tick, tpc);
  const { path } = motion;
  if (!midStep) {
    const from = path[i]!;
    return { path: bfs(world, from, dest) ?? [from], startTick: Math.max(tick, motion.startTick) };
  }
  const entering = path[i + 1]!;
  const rest = bfs(world, entering, dest) ?? [entering];
  return { path: [path[i]!, ...rest], startTick: motion.startTick + i * tpc };
}
