import { describe, expect, it } from 'vitest';
import { advancePlayback, MAX_FRAME_MS } from './playback';

const replay = (tMs: number, speed: 0.5 | 1 | 2 | 4 = 1) => ({ mode: 'replay' as const, tMs, seq: 3, playing: true, speed });

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
    expect(c).toEqual({ mode: 'replay', tMs: 10_000, seq: 3, playing: false, speed: 4 });
    const paused = { ...replay(10), playing: false };
    expect(advancePlayback(paused, 100, 1000)).toBe(paused);
  });
});
