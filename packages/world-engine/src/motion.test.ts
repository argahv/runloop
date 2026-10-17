import { describe, expect, it } from 'vitest';
import type { Cell } from './definition';
import { arrivalTick, enteringCell, eventTick, haltMotion, msToTick, positionAt, redirectMotion } from './motion';
import { campus } from './test-utils';
import type { Motion } from './types';

const path: Cell[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
];
const m: Motion = { path, startTick: 10 };
const TPC = 3;

/** Same place (positions from different but equivalent motions may differ by float rounding). */
function expectSamePlace(a: { x: number; y: number }, b: { x: number; y: number }) {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
}

describe('positionAt', () => {
  it('is at the first cell at (and before) the start', () => {
    expect(positionAt(m, 10, TPC)).toMatchObject({ x: 0, y: 0, cell: [0, 0], next: [1, 0], frac: 0, arrived: false });
    expect(positionAt(m, 2, TPC)).toMatchObject({ x: 0, y: 0, cell: [0, 0] });
  });

  it('interpolates mid-step, including fractional ticks', () => {
    expect(positionAt(m, 11, TPC)).toMatchObject({ cell: [0, 0], next: [1, 0], arrived: false });
    expect(positionAt(m, 11, TPC).x).toBeCloseTo(1 / 3);
    expect(positionAt(m, 14.5, TPC).x).toBeCloseTo(1.5);
    const turn = positionAt(m, 17.5, TPC);
    expect(turn.cell).toEqual([2, 0]);
    expect(turn.x).toBe(2);
    expect(turn.y).toBeCloseTo(0.5);
  });

  it('is exactly on a cell at whole steps', () => {
    expect(positionAt(m, 13, TPC)).toMatchObject({ x: 1, y: 0, cell: [1, 0], next: [2, 0], frac: 0 });
  });

  it('arrives at the end and stays there', () => {
    expect(arrivalTick(m, TPC)).toBe(19);
    expect(positionAt(m, 19, TPC)).toMatchObject({ x: 2, y: 1, cell: [2, 1], next: [2, 1], arrived: true });
    expect(positionAt(m, 500, TPC)).toMatchObject({ x: 2, y: 1, arrived: true });
    expect(positionAt({ path: [[4, 4]], startTick: 0 }, 0, TPC)).toMatchObject({ x: 4, y: 4, arrived: true });
  });

  it('moves smoothly: tiny tick deltas give tiny position deltas', () => {
    let prev = positionAt(m, 10, TPC);
    for (let t = 10; t <= 20; t += 0.05) {
      const p = positionAt(m, t, TPC);
      expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBeLessThanOrEqual(0.05 / TPC + 1e-9);
      prev = p;
    }
  });
});

describe('enteringCell', () => {
  it('is the next cell mid-step and the current cell on a cell', () => {
    expect(enteringCell(m, 10, TPC)).toEqual([0, 0]);
    expect(enteringCell(m, 11, TPC)).toEqual([1, 0]);
    expect(enteringCell(m, 13, TPC)).toEqual([1, 0]);
    expect(enteringCell(m, 17, TPC)).toEqual([2, 1]);
    expect(enteringCell(m, 99, TPC)).toEqual([2, 1]);
  });
});

describe('ticks', () => {
  it('msToTick is fractional', () => {
    expect(msToTick(1234, 10)).toBeCloseTo(12.34);
    expect(msToTick(0, 10)).toBe(0);
  });

  it('arrives exactly at the arrival time even after a ms ↔ tick round trip', () => {
    for (let ms = 0; ms < 20_000; ms += 7) {
      const motion: Motion = { path: [[0, 0], [1, 0], [2, 0], [3, 0]], startTick: msToTick(ms, 10) };
      const arrivalMs = (arrivalTick(motion, 2) / 10) * 1000; // e.g. a playhead parked at the end of the walk
      expect(positionAt(motion, msToTick(arrivalMs, 10), 2).arrived, `start ${ms} ms`).toBe(true);
    }
  });

  it('eventTick keeps the exact (fractional) time and never goes backwards', () => {
    const start = 1_000_000;
    expect(eventTick(0, start + 1290, start, 10)).toBeCloseTo(12.9);
    expect(eventTick(12.9, start + 900, start, 10)).toBe(12.9); // earlier timestamp → clamped
    expect(eventTick(0, start - 500, start, 10)).toBe(0);
    expect(eventTick(12, start + 5000, start, 10)).toBe(50);
  });
});

describe('haltMotion / redirectMotion', () => {
  const world = campus();
  const walk: Motion = {
    path: [
      [10, 8],
      [9, 8],
      [8, 8],
      [7, 8],
    ],
    startTick: 0,
  };

  it('halt mid-step finishes the step into the entering cell', () => {
    const h = haltMotion(walk, 4, TPC); // between [9,8] and [8,8]
    expectSamePlace(positionAt(h, 4, TPC), positionAt(walk, 4, TPC));
    expect(positionAt(h, 100, TPC)).toMatchObject({ x: 8, y: 8, arrived: true });
  });

  it('halt on a cell stops right there', () => {
    const h = haltMotion(walk, 3, TPC);
    expect(h.path).toEqual([[9, 8]]);
    expect(haltMotion({ path: [[1, 1]], startTick: 0 }, 5, TPC).path).toEqual([[1, 1]]);
  });

  it('redirect keeps the position continuous and replans from the entering cell', () => {
    const r = redirectMotion(world, walk, 4, [10, 8]); // turn back mid-step
    expectSamePlace(positionAt(r, 4, TPC), positionAt(walk, 4, TPC));
    expect(r.path.slice(0, 3)).toEqual([
      [9, 8],
      [8, 8],
      [9, 8],
    ]);
    expect(positionAt(r, 1000, TPC)).toMatchObject({ x: 10, y: 8, arrived: true });
  });

  it('redirect to the same destination keeps the motion', () => {
    expect(redirectMotion(world, walk, 4, [7, 8])).toBe(walk);
  });

  it('redirect after arrival starts at the event tick', () => {
    const r = redirectMotion(world, walk, 50, [7, 9]);
    expect(r.startTick).toBe(50);
    expect(r.path).toEqual([
      [7, 8],
      [7, 9],
    ]);
  });
});
