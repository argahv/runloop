/**
 * Schedules (plan §3): each role follows a schedule of blocks tiling the
 * day. Every resident keeps a personal offset of ±20 min (hash of seed and
 * idx), so block boundaries are spread out instead of waking the whole town
 * at 09:00; the offset applies to all of a resident's boundaries, so blocks
 * never overlap or vanish.
 */
import type { ResidentIdentity, Tick } from '@runloop-world/events';
import { hashRange, minuteOfDay, type ScheduleBlock } from '@runloop-world/town';
import type { ScheduleIndex, SimIndex } from './world';

export const SCHEDULE_JITTER = 20;

/** The resident's schedule offset in minutes, in [−20, 20]. */
export function scheduleShift(seed: number, idx: number): number {
  return hashRange(-SCHEDULE_JITTER, SCHEDULE_JITTER, seed, 'sched', idx);
}

export function scheduleOf(ix: SimIndex, r: Pick<ResidentIdentity, 'role'>): ScheduleIndex {
  const role = ix.roles.get(r.role);
  const sched = role && ix.schedules.get(role.schedule);
  if (!sched) throw new Error(`No schedule for role ${r.role}`);
  return sched;
}

/** The block in force for the resident at `tick`. */
export function blockAt(sched: ScheduleIndex, shift: number, tick: Tick): ScheduleBlock {
  return sched.def.blocks[sched.blockAt[minuteOfDay(tick - shift)]!]!;
}

/** Whether one of the resident's (shifted) block boundaries falls on `tick`. */
export function isBoundary(sched: ScheduleIndex, shift: number, tick: Tick): boolean {
  return sched.boundary[minuteOfDay(tick - shift)] === 1;
}
