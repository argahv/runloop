import { describe, expect, it } from 'vitest';
import { connectionState, connectionView } from './connection';
import type { StudioState } from './store';

type Input = Parameters<typeof connectionState>[0];
const base: Input = {
  runtime: { status: 'online', version: '0.1.0', activeRunId: null, ingest: null, tracedRunIds: [] },
  runId: 'r1',
  conn: 'streaming',
  cursor: { mode: 'live' },
  ended: false,
  run: { paused: false } as StudioState['run'],
  loadError: null,
};
const state = (patch: Partial<Input>) => connectionState({ ...base, ...patch });

describe('connection state', () => {
  it('is live while a running run streams', () => {
    expect(state({})).toBe('live');
  });
  it('says disconnected first when the runtime or stream is lost', () => {
    expect(state({ runtime: { ...base.runtime, status: 'offline' }, cursor: { mode: 'replay', tMs: 0, seq: 0, playing: true, speed: 1 } })).toBe('disconnected');
    expect(state({ conn: 'error' })).toBe('disconnected');
    expect(state({ loadError: 'boom' })).toBe('disconnected');
  });
  it('labels synthetic data whenever it is shown', () => {
    expect(connectionState(base, { synthetic: true })).toBe('synthetic');
  });
  it('is connecting while the runtime is unknown or the run loads', () => {
    expect(state({ runtime: { ...base.runtime, status: 'unknown' } })).toBe('connecting');
    expect(state({ conn: 'loading' })).toBe('connecting');
    expect(state({ conn: 'reconnecting' })).toBe('connecting');
  });
  it('separates replaying from paused and recorded', () => {
    expect(state({ cursor: { mode: 'replay', tMs: 10, seq: 1, playing: true, speed: 1 } })).toBe('replaying');
    expect(state({ cursor: { mode: 'replay', tMs: 10, seq: 1, playing: false, speed: 1 } })).toBe('paused');
    expect(connectionView('paused')).toMatchObject({ icon: '⏸', tone: 'info' }); // reviewing the past is not a warning
    expect(state({ run: { paused: true } as StudioState['run'] })).toBe('paused');
    expect(state({ ended: true, conn: 'complete' })).toBe('recorded');
  });
  it('is idle with no run open, and every state has words', () => {
    expect(state({ runId: null, conn: 'idle' })).toBe('idle');
    for (const s of ['connecting', 'live', 'paused', 'disconnected', 'replaying', 'recorded', 'synthetic', 'idle'] as const) {
      const v = connectionView(s);
      expect(v.text.length).toBeGreaterThan(0);
      expect(v.detail.length).toBeGreaterThan(0);
    }
  });
});
