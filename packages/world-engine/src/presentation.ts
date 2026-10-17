import type { Cell } from './definition';
import { positionAt } from './motion';
import type { CharacterPose, CharacterWorld, CompiledWorld, PresentationState } from './types';

/** How long (ticks) a 'succeeded' reaction shows before the character reads as idle. */
export const SUCCESS_DECAY_TICKS = 20;

const headingOf = (from: Cell | readonly [number, number], to: Cell | readonly [number, number]) =>
  Math.atan2(to[1] - from[1], to[0] - from[0]);

/**
 * Pose of a character at `tick` (fractional ticks give smooth motion).
 * State priority: failed → awaiting_approval → paused → succeeded (briefly)
 * → moving → waiting (queued at overflow) → the activity.
 */
export function presentationAt(
  c: CharacterWorld,
  tick: number,
  world: CompiledWorld,
  opts: { paused?: boolean } = {},
): CharacterPose {
  const p = positionAt(c.motion, tick, world.def.ticksPerCell);
  const moving = !p.arrived;
  const heading = moving ? headingOf(p.cell, p.next) : restingHeading(c, world);

  let state: PresentationState;
  if (c.activity === 'failed') state = 'failed';
  else if (c.activity === 'awaiting_approval') state = 'awaiting_approval';
  else if (opts.paused) state = 'paused';
  else if (c.activity === 'succeeded' && tick - c.sinceTick <= SUCCESS_DECAY_TICKS) state = 'succeeded';
  else if (moving) state = 'moving';
  else if (c.target.kind === 'overflow') state = 'waiting';
  else if (c.activity === 'succeeded') state = 'idle';
  else state = c.activity;

  return { state, x: p.x, y: p.y, heading, moving, cell: p.frac > 0 ? p.next : p.cell };
}

/** Facing when standing still: the station when at one, else the last step's direction, else the hub. */
function restingHeading(c: CharacterWorld, world: CompiledWorld): number {
  const path = c.motion.path;
  const here = path[path.length - 1]!;
  if (c.target.kind === 'slot' || c.target.kind === 'overflow') {
    const station = world.stationsById[c.target.stationId];
    if (station) return headingOf(here, station.cell);
  }
  if (path.length >= 2) return headingOf(path[path.length - 2]!, here);
  return headingOf(here, world.def.hub.center);
}

/** Grid coordinates → scene coordinates: the grid is centred on the origin, 1 cell = 1 unit, y → z. */
export function gridToScene(x: number, y: number, world: CompiledWorld): { x: number; z: number } {
  return { x: x - (world.width - 1) / 2, z: y - (world.height - 1) / 2 };
}

/** Cell where a character stands to work at a station slot (out-of-range index → overflow cell). */
export function stationWorkCell(world: CompiledWorld, stationId: string, index: number): Cell {
  const station = world.stationsById[stationId];
  if (!station) throw new Error(`Unknown station ${stationId}`);
  return station.slots[index] ?? station.overflow;
}
