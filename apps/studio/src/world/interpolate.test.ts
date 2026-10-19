import { describe, expect, it } from 'vitest';
import { clockAfterSpeedChange, clockParts, frameAnchor, MAX_AHEAD_MS, nextClock, tickNow, walkPosition } from './interpolate';

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

  it("anchors a frame at the runtime's wallMs, so the fractional tick matches the runtime's", () => {
    // The tick began 100 ms ago at 16×: 1.6 ticks have passed since.
    const c = nextClock(null, { tick: 600, speed: 16, wallMs: 900 }, 1000);
    expect(c.receivedAt).toBe(900);
    expect(tickNow(c, 1000)).toBeCloseTo(601.6);
    // Steady 16×: frames stamped with their wallMs never step the clock back.
    let clock = c;
    let shown = tickNow(clock, 1000);
    for (let i = 1; i <= 30; i++) {
      const now = 1000 + i * 1000 + (i % 3) * 40; // frames arrive with jitter
      const wall = 900 + i * 1000; // the runtime's tick boundaries
      clock = nextClock(clock, { tick: 600 + i * 16, speed: 16, wallMs: wall }, now);
      const t = tickNow(clock, now);
      expect(t).toBeGreaterThanOrEqual(shown - 1e-9);
      shown = t;
    }
  });

  it('does not trust a wallMs from the future or from long ago', () => {
    expect(frameAnchor(1500, 1000)).toBe(1000);
    expect(frameAnchor(1000 - MAX_AHEAD_MS, 1000)).toBe(1000);
    expect(frameAnchor(undefined, 1000)).toBe(1000);
    expect(frameAnchor(800, 1000)).toBe(800);
  });

  it('re-bases at a speed change; pausing never moves the time backwards', () => {
    const running = { tick: 600, speed: 16 as const, receivedAt: 0, lagging: false };
    // 500 ms at 16× shows 608; the pause happened at tick 605 (the event came late).
    const paused = clockAfterSpeedChange(running, { tick: 605, speed: 0 }, 500);
    expect(paused).toMatchObject({ tick: 608, speed: 0 });
    expect(tickNow(paused, 5000)).toBe(608);
    // Resuming at 4× starts from the event's tick at once (no stale frozen clock until the next frame).
    const resumed = clockAfterSpeedChange({ tick: 608, speed: 0, receivedAt: 0, lagging: false }, { tick: 608, speed: 4 }, 1000);
    expect(tickNow(resumed, 1500)).toBe(610);
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
