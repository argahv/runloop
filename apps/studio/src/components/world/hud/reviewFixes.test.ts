import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '../../../world/attention';
import { placeCard, stripBox, type Viewport } from './anchor';
import { cueMatched, nextPopup, popupEligible, superseded } from './notify';

const vp: Viewport = { w: 1440, h: 900, right: 0, left: 0, top: 76, bottom: 92 };
const card = { w: 320, h: 220 };
const at = (x: number, y: number) => ({ x, y, visible: true, depth: 10 });

describe('cards stand beside what they describe', () => {
  it('a building wider than the gap: the card starts right of its whole screen box, not on its roof', () => {
    const box = { left: 600, top: 300, right: 820, bottom: 520 };
    const p = placeCard(at(710, 320), card, vp, 'right', box);
    expect(p.docked).toBe(false);
    expect(p.x).toBeGreaterThanOrEqual(box.right);
    // A small thing (a resident) keeps the anchor gap of 28 px.
    expect(placeCard(at(500, 400), card, vp, 'right', { left: 492, top: 380, right: 508, bottom: 420 }).x).toBe(528);
  });

  it('no room right: left of the box; no room either side (an interior filling the view): docked', () => {
    const p = placeCard(at(1150, 400), card, vp, 'right', { left: 1000, top: 300, right: 1300, bottom: 500 });
    expect(p).toMatchObject({ docked: false, side: 'left' });
    expect(p.x + card.w).toBeLessThanOrEqual(1000);
    expect(placeCard(at(700, 400), card, vp, 'right', { left: 120, top: 120, right: 1200, bottom: 760 }).docked).toBe(true);
  });

  it('over the minimap column the card stays above the minimap (its buttons stay reachable)', () => {
    const corner = { w: 264, h: 232 };
    const p = placeCard(at(60, 760), card, { ...vp, corner });
    expect(p.y + card.h).toBeLessThanOrEqual(900 - corner.h);
    // Right of the minimap column nothing changes.
    expect(placeCard(at(500, 760), card, { ...vp, corner }).y).toBe(placeCard(at(500, 760), card, vp).y);
  });
});

describe('the session strip sits in the free area', () => {
  it('centred on the screen with nothing open; left of an open sheet, narrowed and clear of the minimap', () => {
    expect(stripBox({ w: 1440, left: 0, right: 0, corner: { w: 264, h: 232 } })).toEqual({ x: 340, w: 760, bottom: null });
    const withSheet = stripBox({ w: 1440, left: 0, right: 472, corner: { w: 264, h: 232 } });
    expect(withSheet).toMatchObject({ x: 264, bottom: null });
    expect(withSheet.x + withSheet.w).toBeLessThanOrEqual(1440 - 472 - 16);
    expect(withSheet.w).toBeLessThan(760);
  });

  it('too narrow beside the minimap (a wide trace sheet open): it rises above the minimap at full free width', () => {
    const b = stripBox({ w: 1440, left: 0, right: 880, corner: { w: 264, h: 232 } });
    expect(b).toEqual({ x: 16, w: 528, bottom: 240 });
  });
});

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: over.key ?? 'k',
  groupKey: over.key ?? 'k',
  kind: 'session_started',
  severity: 'notable',
  prov: 'system',
  refs: [{ kind: 'agent', id: 'a1' }],
  events: { first: 1, last: 1, count: 1 },
  firstTick: 0,
  lastTick: 0,
  ...over,
});

describe('notifications keep step with the sound and with the facts', () => {
  it('a real-agent cue fact shows at once, ignoring the 4 s pacing, even behind a newer attention item', () => {
    const liveIt = item({ key: 'live', kind: 'agent_live', events: { first: 5, last: 5, count: 1 } });
    const other = item({ key: 'rej', kind: 'rejected', severity: 'attention', refs: [], events: { first: 6, last: 6, count: 1 } });
    expect(cueMatched(liveIt)).toBe(true);
    // Just shown something 1 s ago: the cue's fact still pops now.
    expect(nextPopup([other, liveIt], 10_000, 9_000, new Map())?.key).toBe('live');
    expect(cueMatched(item({ kind: 'session_ended', detail: 'succeeded' }))).toBe(true);
    expect(cueMatched(item({ kind: 'session_ended', detail: 'stopped' }))).toBe(false);
    expect(cueMatched(item({ kind: 'dispatch', detail: 'completed' }))).toBe(true);
    expect(cueMatched(item({ kind: 'conversations', prov: 'simulation' }))).toBe(false);
  });

  it('a queued "is live" is dropped once a newer connection fact about the same agent arrived', () => {
    const liveIt = item({ key: 'live', kind: 'agent_live', events: { first: 5, last: 5, count: 1 } });
    const incident = item({ key: 'inc', kind: 'incident', severity: 'attention', events: { first: 9, last: 9, count: 1 } });
    expect(superseded(liveIt, [liveIt, incident])).toBe(true);
    expect(superseded(incident, [liveIt, incident])).toBe(false);
    const shown = new Map([['inc', 1]]);
    expect(nextPopup([liveIt, incident], 10_000, 0, shown)).toBeNull();
    // A plain notable ("started a session") does not pop after a newer popup about the same agent.
    const started = item({ key: 'st', kind: 'session_started', events: { first: 4, last: 4, count: 1 } });
    expect(superseded(started, [started, incident])).toBe(true);
    // The bell-only offline item never hides a newer-looking popup's predecessor.
    const ended = item({ key: 'end', kind: 'session_ended', detail: 'stopped', events: { first: 10, last: 10, count: 1 } });
    const offline = item({ key: 'off', kind: 'agent_offline', events: { first: 11, last: 11, count: 1 } });
    expect(superseded(ended, [ended, offline])).toBe(false);
  });

  it('an agent going offline after its session closed stays in the bell list (no popup, not "need you")', () => {
    expect(popupEligible(item({ kind: 'agent_offline', severity: 'notable', prov: 'system' }))).toBe(false);
    expect(popupEligible(item({ kind: 'lost_mid_task', severity: 'critical' }))).toBe(true);
  });
});
