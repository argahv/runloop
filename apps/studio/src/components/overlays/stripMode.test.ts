import { describe, expect, it } from 'vitest';
import { sessionStateLabel, stripMode } from './stripMode';

const now = Date.parse('2026-10-18T12:00:00.000Z');
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

describe('session strip state (an open run is not a live agent)', () => {
  it('says Live, with the live accent, only when the agent is live', () => {
    expect(stripMode({ following: true, open: true, health: 'live', lastEventAt: minsAgo(0), nowMs: now })).toEqual({ text: 'Live', icon: 'pulse', live: true });
  });

  it('a quiet open session reads "Open · idle 12m" with the idle icon, as the card says Idle', () => {
    const m = stripMode({ following: true, open: true, health: 'idle', lastEventAt: minsAgo(12), nowMs: now });
    expect(m).toEqual({ text: 'Open · idle 12m', icon: 'pause', live: false });
    expect(stripMode({ following: true, open: true, health: null, lastEventAt: null, nowMs: now }).text).toBe('Open · health not reported');
  });

  it('recorded and replay states never claim live; the picker says Open, not Live', () => {
    expect(stripMode({ following: true, open: false, health: 'live', lastEventAt: null, nowMs: now })).toMatchObject({ text: 'Recorded · latest', live: false });
    expect(stripMode({ following: false, open: true, health: 'live', lastEventAt: null, nowMs: now })).toMatchObject({ text: 'Replay · recorded state', live: false });
    expect(sessionStateLabel('running')).toBe('Open');
    expect(sessionStateLabel('completed')).toBe('Recorded');
  });
});
