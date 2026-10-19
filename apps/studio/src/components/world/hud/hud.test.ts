import type { AttentionItem } from '../../../world/attention';
import { createWorldStore } from '../../../world/store';
import { describe, expect, it } from 'vitest';
import { anchorUsable, placeCard, type Viewport } from './anchor';
import { escapeAction, runEscape } from './escape';
import { hudInsets, hudLayout, hudSize } from './layout';
import { approxFootprint, gridToMini, miniToGrid, miniTransform } from './minimapMath';
import { lotLabel, lotPickModel } from './lots';
import { hasCritical, MAX_VISIBLE, needsYou, nextPopup, popupEligible, POPUP_MS, pushPopup, trimPopups } from './notify';

const vp: Viewport = { w: 1440, h: 900, right: 0, left: 0, top: 76, bottom: 92 };
const card = { w: 320, h: 220 };
const at = (x: number, y: number, visible = true) => ({ x, y, visible, depth: 10 });

describe('anchored card placement (contract §1.4)', () => {
  it('sits right of the anchor, raised 24 px, with the tail at the anchor', () => {
    const p = placeCard(at(500, 400), card, vp);
    expect(p).toMatchObject({ docked: false, side: 'right', x: 528, y: 376, tailY: 24 });
  });

  it('flips left near the right edge and needs 40 px to flip back (no flicker)', () => {
    const near = placeCard(at(1100, 400), card, vp);
    expect(near.side).toBe('left');
    expect(near.x).toBe(1100 - 28 - 320);
    // 1440 − 16 − 28 − 320 = 1076: right fits again at x ≤ 1076, but only from 1036 while on the left.
    expect(placeCard(at(1060, 400), card, vp, 'left').side).toBe('left');
    expect(placeCard(at(1030, 400), card, vp, 'left').side).toBe('right');
    expect(placeCard(at(1060, 400), card, vp, 'right').side).toBe('right');
  });

  it('a sheet on the right counts as the edge', () => {
    expect(placeCard(at(600, 400), card, { ...vp, right: 760 })).toMatchObject({ docked: false, side: 'left' });
    expect(placeCard(at(700, 400), card, { ...vp, right: 760 }).docked).toBe(true);
  });

  it('clamps vertically clear of the HUD bands', () => {
    expect(placeCard(at(500, 100), card, vp).y).toBe(92);
    expect(placeCard(at(500, 800), card, vp).y).toBe(900 - 92 - 220);
  });

  it('docks top-right when the anchor is off-screen, behind the camera or under the HUD', () => {
    for (const a of [null, at(500, 400, false), at(-20, 400), at(500, 40), at(500, 850)]) {
      const p = placeCard(a, card, vp);
      expect(p).toMatchObject({ docked: true, x: 1440 - 16 - 320, y: 92 });
    }
    expect(anchorUsable(at(500, 400), vp)).toBe(true);
  });
});

describe('HUD layout per viewport (contract §1.2)', () => {
  it('maps widths to sizes', () => {
    expect([390, 760, 1280, 1440, 1920].map(hudSize)).toEqual(['phone', 'phone', 's', 'm', 'l']);
  });

  it('minimap and hotbar sizes follow the table; phones hide the minimap and keep 12 labels', () => {
    expect(hudLayout(1440).minimap).toEqual({ w: 232, h: 174 });
    expect(hudLayout(1920).minimap).toEqual({ w: 264, h: 198 });
    expect(hudLayout(1280).minimap).toEqual({ w: 200, h: 150 });
    expect(hudLayout(390).minimap).toBeNull();
    expect(hudLayout(390).labelBudget).toBe(12);
    expect(hudLayout(1280).captionRow).toBe(false);
    expect(hudLayout(1920).card).toEqual({ compact: 340, expanded: 440 });
  });

  it('insets cover the top row, the hotbar and an open sheet', () => {
    const l = hudLayout(1440);
    expect(hudInsets(l, { right: 864 })).toEqual({ top: 80, right: 880, bottom: 84, left: 0 });
    expect(hudInsets(l, { hidden: true })).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('the Esc cascade (contract §2.2)', () => {
  const base = { menu: null, lotPick: null, overlay: 'none' as const, entered: null, follow: null, panelStack: [], mode: 'explore' as const };
  it('menu → lot pick → sheet → interior → follow → cards → district → opens the menu', () => {
    expect(escapeAction({ ...base, menu: 'sound' })).toBe('closeMenu');
    expect(escapeAction({ ...base, overlay: 'add', lotPick: { selected: 'lot_1', fromSessionId: null } })).toBe('unpickLot');
    expect(escapeAction({ ...base, overlay: 'add', lotPick: { selected: null, fromSessionId: null } })).toBe('cancelLotPick');
    expect(escapeAction({ ...base, overlay: 'trace', entered: 'bld_x' })).toBe('closeOverlay');
    expect(escapeAction({ ...base, entered: 'bld_x', follow: { kind: 'resident', id: 'r' } })).toBe('leaveInterior');
    expect(escapeAction({ ...base, follow: { kind: 'resident', id: 'r' }, panelStack: [{ kind: 'resident', id: 'r' }] })).toBe('stopFollow');
    expect(escapeAction({ ...base, panelStack: [{ kind: 'resident', id: 'r' }] })).toBe('popCard');
    expect(escapeAction({ ...base, mode: 'agents' })).toBe('closeDistrict');
    expect(escapeAction(base)).toBe('openMenu');
  });

  it('runs on the store, one step per press', () => {
    const s = createWorldStore();
    s.getState().focusEntity({ kind: 'resident', id: 'a' }, { camera: false });
    s.getState().focusEntity({ kind: 'resident', id: 'b' }, { camera: false });
    expect(runEscape(s.getState())).toBe('popCard');
    expect(s.getState().panelStack).toHaveLength(1);
    runEscape(s.getState());
    expect(s.getState().panelStack).toHaveLength(0);
    expect(runEscape(s.getState())).toBe('openMenu');
    expect(s.getState().menu).toBe('resume');
    expect(runEscape(s.getState())).toBe('closeMenu');
    expect(s.getState().menu).toBeNull();
  });
});

describe('minimap geometry', () => {
  it('fits the town and round-trips grid points', () => {
    const t = miniTransform(96, 72, 232, 174, 8);
    expect(t.scale).toBeCloseTo(Math.min(216 / 96, 158 / 72));
    const p = gridToMini(t, 40, 20);
    const g = miniToGrid(t, p.x, p.y);
    expect(g.x).toBeCloseTo(40);
    expect(g.z).toBeCloseTo(20);
  });

  it('approximates a footprint from the target and zoom', () => {
    expect(approxFootprint(10, 10, 20, 400, 200)).toEqual([
      [0, 15],
      [20, 15],
      [20, 5],
      [0, 5],
    ]);
  });
});

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: over.key ?? 'k',
  groupKey: over.key ?? 'k',
  kind: 'session_started',
  severity: 'notable',
  prov: 'simulation',
  refs: [],
  events: { first: 1, last: 1, count: 1 },
  firstTick: 0,
  lastTick: 0,
  ...over,
});

describe('notifications (contract §4.1)', () => {
  it('pop: critical, attention and real-agent notables; simulated notables stay in the bell list', () => {
    expect(popupEligible(item({ severity: 'critical' }))).toBe(true);
    expect(popupEligible(item({ severity: 'attention', prov: 'user' }))).toBe(true);
    expect(popupEligible(item({ kind: 'conversations', prov: 'simulation' }))).toBe(false);
    expect(popupEligible(item({ prov: 'external-agent', refs: [{ kind: 'agent', id: 'a' }] }))).toBe(true);
    expect(popupEligible(item({ severity: 'critical', resolved: true }))).toBe(false);
  });

  it('one popup every 4 s; critical skips the wait', () => {
    const sim = item({ key: 's', kind: 'conversations' });
    const real = item({ key: 'r', prov: 'external-agent' });
    expect(nextPopup([sim], 10_000, 0, new Map())).toBeNull();
    expect(nextPopup([sim, real], 10_000, 0, new Map())?.key).toBe('r');
    expect(nextPopup([real], 10_000, 8_000, new Map())).toBeNull();
    expect(nextPopup([item({ key: 'c', severity: 'critical' })], 10_000, 9_999, new Map())?.key).toBe('c');
  });

  it('counts what needs the viewer and keeps critical popups until acted on', () => {
    const items = [item({ key: 'a', severity: 'critical' }), item({ key: 'b', severity: 'attention' }), item({ key: 'c', severity: 'attention', resolved: true })];
    expect(needsYou(items)).toBe(2);
    expect(hasCritical(items)).toBe(true);
    let list = pushPopup([], items[0]!, 0);
    for (let i = 0; i < 4; i++) list = pushPopup(list, item({ key: `n${i}`, prov: 'external-agent' }), 100 * (i + 1));
    expect(list).toHaveLength(MAX_VISIBLE);
    expect(list.some((p) => p.item.key === 'a')).toBe(true);
    list = trimPopups(list, POPUP_MS + 500);
    expect(list.map((p) => p.item.key)).toEqual(['a']);
    expect(trimPopups(pushPopup([], items[1]!, 0), POPUP_MS + 1, items[1]!.key)).toHaveLength(1);
  });
});

describe('lot picking model (contract §4.3)', () => {
  it('lists every agent lot, free or taken with its agent, and keeps the selection', () => {
    const town = { agentLots: [{ id: 'lot_agent_1' }, { id: 'lot_agent_2' }] } as unknown as Parameters<typeof lotPickModel>[0];
    expect(lotPickModel(town, [{ lotId: 'lot_agent_1', displayName: 'Engineering House' }], 'lot_agent_2')).toEqual({
      selected: 'lot_agent_2',
      lots: [
        { id: 'lot_agent_1', state: 'taken', label: 'Lot 1 · Engineering House' },
        { id: 'lot_agent_2', state: 'free', label: 'Lot 2 · Free' },
      ],
    });
    expect(lotLabel('lot_weird')).toBe('lot_weird');
  });
});

describe('cards keep clear of the session strip', () => {
  it('clamps above a taller bottom band', () => {
    expect(placeCard(at(500, 600), card, { ...vp, bottom: 196 }).y).toBe(900 - 196 - 220);
  });
});
