import { applyEvent, foldEvents, hashState } from '@runloop-world/sim';
import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@runloop-world/events';
import { tickNow } from './interpolate';
import { createWorldStore, focusOf } from './store';
import { commonsTown, DOCS_DESK, ENGINEERING_HOUSE, fixtureEvents, fixtureSnapshot } from './test-utils';

const NOW = 1_000_000;

function loaded() {
  const store = createWorldStore();
  store.getState().setTown(commonsTown());
  store.getState().applySnapshot(fixtureSnapshot(), NOW);
  return store;
}

describe('world store fold', () => {
  it('snapshot + streamed tail equals the engine fold of the whole log (same applyEvent)', () => {
    const events = fixtureEvents();
    const store = loaded();
    const snap = store.getState().snapshot!;
    store.getState().applyEvents(events.filter((e) => e.seq > snap.seq), NOW + 50);
    const expected = foldEvents(events, commonsTown());
    expect(store.getState().snapshot!.seq).toBe(events.at(-1)!.seq);
    expect(hashState(store.getState().snapshot!)).toBe(hashState(expected));
    expect(store.getState().snapshot).toEqual(expected);
  });

  it('skips duplicates, folds batches split anywhere, and bumps rev once per batch', () => {
    const events = fixtureEvents();
    const store = loaded();
    const start = store.getState().snapshot!.seq;
    const tail = events.filter((e) => e.seq > start);
    const rev0 = store.getState().rev;
    store.getState().applyEvents(tail.slice(0, 10), NOW);
    store.getState().applyEvents(tail.slice(5, 40), NOW); // overlaps the first batch
    store.getState().applyEvents(tail.slice(0, 40), NOW); // all duplicates: no change
    expect(store.getState().rev).toBe(rev0 + 2);
    store.getState().applyEvents(tail.slice(40), NOW);
    expect(store.getState().snapshot).toEqual(foldEvents(events, commonsTown()));
    expect(store.getState().log.map((e) => e.seq)).toEqual(tail.map((e) => e.seq));
  });

  it('stops at a gap and flags it (never folds past a missing event)', () => {
    const events = fixtureEvents();
    const store = loaded();
    const start = store.getState().snapshot!.seq;
    const tail = events.filter((e) => e.seq > start);
    store.getState().applyEvents([tail[0]!, tail[2]!], NOW);
    expect(store.getState().snapshot!.seq).toBe(tail[0]!.seq);
    expect(store.getState().gap).toBe(true);
  });

  it('a pending command clears on its effect and shows its rejection', () => {
    const events = fixtureEvents();
    const created = events[0]!;
    if (created.type !== 'world.created') throw new Error('fixture must start with world.created');
    const store = createWorldStore();
    store.getState().setTown(commonsTown());
    // Fold up to just before the housing commands, then send them as if from this Studio.
    const before = foldEvents(events.filter((e) => e.seq < 146), commonsTown());
    store.getState().applySnapshot(before, NOW);
    store.getState().addPending({ id: `house:${ENGINEERING_HOUSE}`, command: { type: 'clock.set', speed: 0 }, label: 'Adding', sentAt: NOW, state: 'sending' });
    store.getState().addPending({ id: 'house:agt_0c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5', command: { type: 'clock.set', speed: 0 }, label: 'Adding', sentAt: NOW, state: 'sending' });
    store.getState().applyEvents(events.filter((e) => e.seq >= 146 && e.seq <= 180), NOW);
    const pending = store.getState().pending;
    expect(pending[`house:${ENGINEERING_HOUSE}`]).toBeUndefined();
    expect(pending['house:agt_0c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5']).toMatchObject({ state: 'rejected', reason: 'lot_unavailable' });
  });

  it("plays a cinematic arrival on a real agent's first event (a cut with reduced motion)", () => {
    const events = fixtureEvents();
    for (const reduced of [false, true]) {
      const store = createWorldStore({ reducedMotion: reduced });
      store.getState().setTown(commonsTown());
      store.getState().applySnapshot(foldEvents(events.filter((e) => e.seq < 157), commonsTown()), NOW);
      store.getState().applyEvents(events.filter((e) => e.seq === 157), NOW); // awaiting_first_event → live
      expect(store.getState().camera).toMatchObject({ kind: 'focus', ref: { kind: 'agent', id: ENGINEERING_HOUSE }, motion: reduced ? 'cut' : 'cinematic' });
    }
  });

  it('folds agent events into attention: housed, live, and a permission request as critical', () => {
    const events = fixtureEvents();
    const store = createWorldStore();
    store.getState().setTown(commonsTown());
    store.getState().applySnapshot(applyEvent(null, events[0]!, commonsTown()), NOW);
    store.getState().applyEvents(events.slice(1), NOW);
    const items = store.getState().attention;
    expect(items[0]).toMatchObject({ kind: 'permission', severity: 'critical', refs: [{ kind: 'agent', id: ENGINEERING_HOUSE }] });
    expect(items.some((i) => i.kind === 'housed' && i.refs[0]!.id === DOCS_DESK)).toBe(true);
    expect(items.some((i) => i.kind === 'rejected' && i.prov === 'user')).toBe(true);
    // Ambient movement never becomes an attention item.
    expect(items.every((i) => i.severity !== 'ambient')).toBe(true);
  });

  it('seeds attention from recorded history before the snapshot, without counting live events twice', () => {
    const events = fixtureEvents();
    const store = loaded();
    const snap = store.getState().snapshot!;
    store.getState().applyEvents(events.filter((e) => e.seq > snap.seq), NOW);
    const live = store.getState().attention;
    // The housing and the first connection changes happened before the snapshot (seq 146–157).
    expect(live.some((i) => i.kind === 'housed')).toBe(false);
    store.getState().primeAttention(events.filter((e) => e.seq <= snap.seq));
    const primed = store.getState().attention;
    expect(primed.filter((i) => i.kind === 'housed')).toHaveLength(2);
    expect(primed.filter((i) => i.kind === 'permission')).toHaveLength(1);
    const count = (items: typeof primed) => items.reduce((n, i) => n + (i.events?.count ?? 0), 0);
    const recount = events.filter((e) => e.type !== 'resident.decided' && e.type !== 'resident.departed' && e.type !== 'resident.arrived').length;
    expect(count(primed)).toBeLessThanOrEqual(recount);
    // Priming twice gives the same items (idempotent).
    store.getState().primeAttention(events.filter((e) => e.seq <= snap.seq));
    expect(store.getState().attention).toEqual(primed);
  });

  it('keeps a panel stack with Back and asks the camera to focus', () => {
    const store = loaded();
    const s = () => store.getState();
    s().focusEntity({ kind: 'building', id: 'bld_corner_cafe' });
    s().focusEntity({ kind: 'resident', id: 'res_0003' });
    s().focusEntity({ kind: 'resident', id: 'res_0003' }); // same entity: not pushed twice
    expect(s().panelStack).toHaveLength(2);
    expect(s().camera).toMatchObject({ kind: 'focus', ref: { kind: 'resident', id: 'res_0003' }, motion: 'quick' });
    s().back();
    expect(focusOf(s())).toEqual({ kind: 'building', id: 'bld_corner_cafe' });
    s().setReducedMotion(true);
    s().focusEntity({ kind: 'agent', id: ENGINEERING_HOUSE });
    expect(s().camera!.motion).toBe('cut');
    s().closePanels();
    expect(focusOf(s())).toBeNull();
  });
});

describe('world store clock', () => {
  it('a pause event stops the clock at once without moving it back', () => {
    const store = loaded();
    // The snapshot is folded in place: keep its numbers from before the pause.
    const { seq, tick, speed } = store.getState().snapshot!;
    expect(speed).toBe(4);
    // Running at 4× since NOW: 1 s later the client shows tick + 4; the pause happened at tick + 3.
    const pause = { seq: seq + 1, tick: tick + 3, type: 'world.clock_changed', prov: 'user', p: { speed: 0, prevSpeed: speed } } as unknown as WorldEvent;
    store.getState().applyEvents([pause], NOW + 1000);
    const clock = store.getState().clock!;
    expect(clock.speed).toBe(0);
    expect(clock.tick).toBe(tick + 4);
    // Frozen afterwards, not extrapolated at the old speed until the next clock frame.
    expect(tickNow(clock, NOW + 1800)).toBe(tick + 4);
  });

  it('forgets the old world entirely when another world answers', () => {
    const store = loaded();
    store.getState().focusEntity({ kind: 'resident', id: 'res_0001' });
    store.getState().addPending({ id: 'c1', command: { type: 'clock.set', speed: 0 }, label: 'Pausing', sentAt: NOW, state: 'sending' });
    store.getState().resetWorld();
    const s = store.getState();
    expect(s.snapshot).toBeNull();
    expect(s.panelStack).toEqual([]);
    expect(s.pending).toEqual({});
    expect(s.attention).toEqual([]);
    expect(s.log).toEqual([]);
    expect(s.lastSeenSeq).toBeNull();
  });
});
