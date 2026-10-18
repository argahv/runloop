import { describe, expect, it } from 'vitest';
import { clockParts, MAX_AHEAD_MS, nextClock, tickNow, walkPosition } from './interpolate';

describe('world clock interpolation', () => {
  it('advances at speed ticks per second and clamps to 2 s ahead', () => {
    const c = { tick: 600, speed: 4 as const, receivedAt: 1000, lagging: false };
    expect(tickNow(c, 1000)).toBe(600);
    expect(tickNow(c, 1500)).toBe(602);
    expect(tickNow(c, 1000 + MAX_AHEAD_MS)).toBe(608);
    expect(tickNow(c, 1000 + 60_000)).toBe(608);
    expect(tickNow(c, 0)).toBe(600);
  });

  it('is frozen while paused', () => {
    expect(tickNow({ tick: 600, speed: 0, receivedAt: 0, lagging: false }, 99_999)).toBe(600);
  });

  it('does not jump back by less than a tick when a frame lands just behind', () => {
    const c = nextClock(null, { tick: 600, speed: 1 }, 0);
    const next = nextClock(c, { tick: 600, speed: 1 }, 900);
    expect(next.tick).toBeCloseTo(600.9);
    const resync = nextClock(c, { tick: 590, speed: 1 }, 900);
    expect(resync.tick).toBe(590);
    const paused = nextClock(c, { tick: 600, speed: 0 }, 900);
    expect(paused).toMatchObject({ tick: 600, speed: 0 });
  });

  it('interpolates a walk between path cells at walkCellsPerMinute', () => {
    const motion = { path: [[0, 0], [1, 0], [2, 0], [2, 1]] as [number, number][], startTick: 10 };
    expect(walkPosition(motion, 10, 3)).toEqual({ x: 0, y: 0, walking: true });
    expect(walkPosition(motion, 10.5, 3)).toEqual({ x: 1.5, y: 0, walking: true });
    expect(walkPosition(motion, 11, 3)).toEqual({ x: 2, y: 1, walking: false });
    expect(walkPosition(motion, 50, 3)).toEqual({ x: 2, y: 1, walking: false });
  });

  it('formats Day N · HH:MM parts', () => {
    expect(clockParts(2 * 1440 + 14 * 60 + 20.7)).toEqual({ day: 3, hh: '14', mm: '20', minuteOfDay: 860 });
  });
});
