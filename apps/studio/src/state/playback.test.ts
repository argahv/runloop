import { describe, expect, it } from 'vitest';
import { advancePlayback, MAX_FRAME_MS, nextEventTime, prevEventTime, type TimeIndex } from './playback';

const replay = (tMs: number, speed: 0.5 | 1 | 2 | 4 = 1) => ({ mode: 'replay' as const, tMs, playing: true, speed });

function indexOf(times: number[]): TimeIndex {
  return {
    lastSequence: times.length,
    timeOfSeq: (seq) => (seq <= 0 ? 0 : times[Math.min(seq, times.length) - 1]!),
    seqAtTime: (ms) => times.filter((t) => t <= ms).length,
  };
}

describe('playback pacing', () => {
  it('scales wall-clock time by speed', () => {
    expect(advancePlayback(replay(1000, 1), 100, 10_000).tMs).toBe(1100);
    expect(advancePlayback(replay(1000, 0.5), 100, 10_000).tMs).toBe(1050);
    expect(advancePlayback(replay(1000, 4), 100, 10_000).tMs).toBe(1400);
  });

  it('caps one frame so a hidden tab does not leap ahead', () => {
    expect(advancePlayback(replay(0, 2), 60_000, 100_000).tMs).toBe(MAX_FRAME_MS * 2);
    expect(advancePlayback(replay(500), -20, 1000).tMs).toBe(500);
  });

  it('stops at the end', () => {
    const c = advancePlayback(replay(9950, 4), 100, 10_000);
    expect(c).toEqual({ mode: 'replay', tMs: 10_000, playing: false, speed: 4 });
    const paused = { ...replay(10), playing: false };
    expect(advancePlayback(paused, 100, 1000)).toBe(paused);
  });

  it('finds neighbouring event times', () => {
    const idx = indexOf([0, 0, 300, 300, 1200]);
    expect(nextEventTime(idx, 0)).toBe(300);
    expect(nextEventTime(idx, 150)).toBe(300);
    expect(nextEventTime(idx, 300)).toBe(1200);
    expect(nextEventTime(idx, 1200)).toBeNull();
    expect(prevEventTime(idx, 1200)).toBe(300);
    expect(prevEventTime(idx, 301)).toBe(300);
    expect(prevEventTime(idx, 300)).toBe(0);
    expect(prevEventTime(idx, 0)).toBe(0);
  });
});
