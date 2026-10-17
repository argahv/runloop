import type { Cursor } from './store';

type ReplayCursor = Extract<Cursor, { mode: 'replay' }>;

/**
 * Longest wall-clock step one frame may take: playback keeps real time down to
 * ~1 fps, but a tab returning from the background does not leap ahead.
 */
export const MAX_FRAME_MS = 1000;

/**
 * Move a playing replay cursor forward by `dtMs` of wall-clock time, scaled by
 * its speed. Stops (playing = false) at `endMs`. Paused cursors are returned as is.
 */
export function advancePlayback(cursor: ReplayCursor, dtMs: number, endMs: number): ReplayCursor {
  if (!cursor.playing) return cursor;
  const dt = Math.max(0, Math.min(MAX_FRAME_MS, dtMs));
  const tMs = Math.min(endMs, cursor.tMs + dt * cursor.speed);
  return { ...cursor, tMs, playing: tMs < endMs };
}
