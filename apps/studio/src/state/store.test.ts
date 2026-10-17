import { foldExecution } from '@runloop-world/core';
import { deliver, uuidFor } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { fakeNow, openFixture, wire } from './test-utils';

const ms = (iso: string) => Date.parse(iso);

describe('studio store: ingest', () => {
  it('orders and dedupes shuffled, duplicated deliveries', () => {
    const { store, events } = openFixture();
    for (const e of deliver(events, 7, { dupRate: 0.3, shuffleWindow: 6 })) store.getState().ingest([wire(e)], 'live');
    const s = store.getState();
    expect(s.lastSequence).toBe(events.length);
    expect(s.events().map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
    expect(s.warnings).toEqual([]);
    expect(s.gap).toBeNull();
    expect(s.ended).toBe(true);
  });

  it('holds events after a gap and asks for a backfill after ~2 s', () => {
    const clock = fakeNow(ms('2026-10-17T09:00:00.000Z'));
    const { store, events } = openFixture({ now: clock.now });
    const missing = events[9]!; // sequence 10
    store.getState().ingest(events.filter((e) => e !== missing).map(wire), 'live');
    expect(store.getState().lastSequence).toBe(9);
    expect(store.getState().gap).toEqual({ from: 10, to: 10 });
    expect(store.getState().gapToBackfill()).toBeNull();
    clock.advance(2000);
    expect(store.getState().gapToBackfill()).toEqual({ from: 10, to: 10 });
    expect(store.getState().gapToBackfill()).toBeNull(); // re-armed

    store.getState().ingest([wire(missing)], 'backlog');
    expect(store.getState().lastSequence).toBe(events.length);
    expect(store.getState().gap).toBeNull();
  });

  it('keeps the first event when two different events claim a sequence', () => {
    const { store, events } = openFixture();
    const impostor = { ...events[2]!, eventId: uuidFor(0x77, 1) };
    store.getState().ingest([wire(events[0]), wire(events[1]), wire(events[2]), wire(impostor)], 'live');
    const s = store.getState();
    expect(s.lastSequence).toBe(3);
    expect(s.events()[2]!.eventId).toBe(events[2]!.eventId);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain('#3');
  });

  it('keeps invalid envelopes in raw[] and folds unknown event types', () => {
    const { store, events } = openFixture();
    const unknownType = { ...events[1]!, type: 'robot.danced', payload: { style: 'disco' } };
    store.getState().ingest([wire(events[0]), { hello: 'world' }, wire(unknownType), { hello: 'world' }], 'live');
    const s = store.getState();
    expect(s.raw).toHaveLength(1);
    expect(s.raw[0]!.raw).toEqual({ hello: 'world' });
    expect(s.lastSequence).toBe(2);
    expect(s.events()[1]!.type).toBe('robot.danced');
    expect(s.stateAt(2).exec.anomalies.map((a) => a.code)).toContain('unknown_event');
  });

  it('folds an invalid envelope that names its sequence as an anomaly instead of stalling', () => {
    const { store, events } = openFixture();
    const bad = { ...(wire(events[2]) as object), visibility: 'internal' }; // e.g. from a newer runtime
    const raws = events.map((e, i) => (i === 2 ? bad : wire(e)));
    store.getState().ingest(raws, 'live');
    store.getState().ingest([bad], 'backlog'); // a backfill redelivers it: no duplicate
    const s = store.getState();
    expect(s.lastSequence).toBe(events.length);
    expect(s.gap).toBeNull();
    expect(s.raw).toEqual([]);
    expect(s.events()[2]).toMatchObject({ sequence: 3, unknown: true, reason: 'invalid_envelope', eventId: events[2]!.eventId });
    expect(s.rawEvent(3)).toEqual(bad);
    expect(s.stateAt(3).exec.anomalies.map((a) => a.code)).toEqual(['unknown_event']);
    expect(s.ended).toBe(true);
  });

  it('keeps the raw JSON of each event as received', () => {
    const { store, events } = openFixture();
    const withExtra = { ...(wire(events[0]) as object), extraField: 'kept' };
    store.getState().ingest([withExtra], 'live');
    expect(store.getState().rawEvent(1)).toEqual(withExtra);
  });
});

describe('studio store: cursor', () => {
  it('new live events never move a replay cursor', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.slice(0, 30).map(wire), 'live');
    const t = store.getState().timeOfSeq(20);
    store.getState().seek(t);
    const before = store.getState();
    expect(before.cursor).toMatchObject({ mode: 'replay', tMs: t, playing: false });
    const seq = before.playheadSeq;

    store.getState().ingest(events.slice(30).map(wire), 'live');
    const after = store.getState();
    expect(after.cursor).toEqual(before.cursor);
    expect(after.playheadSeq).toBe(seq);
    expect(after.newSinceReplay).toBe(events.length - 30);

    after.goLive();
    expect(store.getState().playheadSeq).toBe(events.length);
    expect(store.getState().newSinceReplay).toBe(0);
  });

  it('state at the playhead equals a direct fold, forward and backward', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.map(wire), 'backlog');
    for (const n of [40, 5, 58, 1, 23]) {
      store.getState().seekToSeq(n);
      const s = store.getState();
      expect(s.playheadSeq).toBe(n);
      expect(s.stateAt(s.playheadSeq).exec).toEqual(foldExecution(events.slice(0, n)));
    }
  });

  it('stops on any event, also one that shares its millisecond with later ones', () => {
    const { store, events } = openFixture();
    // Five events in the same millisecond, like a Claude Code hook burst.
    const t = events[19]!.timestamp;
    const burst = events.map((e, i) => (i >= 19 && i <= 23 ? { ...e, timestamp: t } : e));
    store.getState().ingest(burst.map(wire), 'backlog');
    for (const n of [20, 21, 22, 23, 24]) {
      store.getState().seekToSeq(n);
      expect(store.getState().playheadSeq).toBe(n);
    }
    // Stepping visits each of them in turn.
    store.getState().seekToSeq(19);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      store.getState().stepNext();
      seen.push(store.getState().playheadSeq);
    }
    expect(seen).toEqual([20, 21, 22, 23, 24, 25]);
    store.getState().stepPrev();
    store.getState().stepPrev();
    expect(store.getState().playheadSeq).toBe(23);
  });

  it('prev/next move one event at a time and clamp at the ends', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.map(wire), 'backlog');
    store.getState().seek(0);
    expect(store.getState().playheadSeq).toBe(1);
    store.getState().stepPrev();
    expect(store.getState().cursor).toMatchObject({ tMs: 0, seq: 0 });
    store.getState().stepPrev();
    expect(store.getState().playheadSeq).toBe(0);
    store.getState().stepNext();
    expect(store.getState().playheadSeq).toBe(1);
    store.getState().stepNext();
    expect(store.getState().playheadSeq).toBe(2);
    expect(store.getState().cursor).toMatchObject({ tMs: store.getState().timeOfSeq(2) });
    store.getState().seekToSeq(events.length);
    store.getState().stepNext(); // nothing after the last event
    expect(store.getState().playheadSeq).toBe(events.length);
  });

  it('late live events never change a paused replay, even when their source time is earlier', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.slice(0, 15).map(wire), 'live');
    store.getState().pause();
    const before = store.getState();
    expect(before.playheadSeq).toBe(15);
    // Delivered after the pause, observed before it (an async hook or a spool flush).
    const late = events.slice(15, 17).map((e) => ({ ...e, timestamp: events[14]!.timestamp }));
    store.getState().ingest(late.map(wire), 'live');
    const after = store.getState();
    expect(after.cursor).toEqual(before.cursor);
    expect(after.playheadSeq).toBe(15);
    expect(after.newSinceReplay).toBe(2);
    expect(after.stateAt(after.playheadSeq).exec.lastSequence).toBe(15);
  });

  it('getFrame is memoized per sequence', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.map(wire), 'backlog');
    store.getState().seekToSeq(12);
    const a = store.getState().getFrame();
    const b = store.getState().getFrame();
    expect(a.state).toBe(b.state);
    expect(a.playheadMs).toBe(store.getState().timeOfSeq(12));
    expect(a.advancing).toBe(false);
  });
});

describe('studio store: live playhead', () => {
  it('follows estimated server time, corrected for client clock skew', () => {
    const { events } = openFixture();
    const skew = 5000; // client clock 5 s ahead of the server
    const clock = fakeNow(ms(events[0]!.timestamp) + skew);
    const { store } = openFixture({ now: clock.now });
    store.getState().ingest([wire(events[0])], 'live');
    expect(store.getState().playheadMs()).toBe(0);
    clock.advance(1500);
    expect(store.getState().playheadMs()).toBe(1500);
    // A later event arriving "early" (lower latency) can only move the estimate forward.
    clock.set(ms(events[1]!.timestamp) + skew);
    store.getState().ingest([wire(events[1])], 'live');
    expect(store.getState().playheadMs()).toBeGreaterThanOrEqual(store.getState().durationMs);
  });

  it('a run watched live until it ends settles over time in the world, never trailing the last event', () => {
    const { events } = openFixture();
    const clock = fakeNow(0); // client clock far behind the server
    const { store } = openFixture({ now: clock.now });
    store.getState().mountWorld();
    store.getState().ingest(events.map(wire), 'live');
    const s = store.getState();
    expect(s.ended).toBe(true);
    expect(s.settleMs).toBeGreaterThanOrEqual(s.durationMs);
    expect(s.playheadMs()).toBe(s.durationMs);
    clock.set(Number.MAX_SAFE_INTEGER / 2);
    expect(store.getState().playheadMs()).toBe(s.settleMs);
    expect(store.getState().getFrame().advancing).toBe(false);
  });

  it('a run that was over when opened (or with no world shown) is at its end at once', () => {
    const { events } = openFixture();
    const { store } = openFixture({ now: fakeNow(0).now });
    const unmount = store.getState().mountWorld();
    store.getState().ingest(events.map(wire), 'backlog');
    expect(store.getState().playheadMs()).toBe(store.getState().settleMs);
    expect(store.getState().getFrame().advancing).toBe(false);
    unmount();
    const { store: live } = openFixture({ now: fakeNow(0).now });
    live.getState().ingest(events.map(wire), 'live'); // no world mounted
    expect(live.getState().playheadMs()).toBe(live.getState().settleMs);
  });
});

describe('studio store: playback', () => {
  it('plays a finished run to its end and stops; play again restarts from 0', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.map(wire), 'backlog');
    store.getState().seek(0);
    store.getState().setSpeed(4);
    store.getState().play();
    for (let i = 0; i < 100 && store.getState().cursor.mode === 'replay'; i++) {
      store.getState().advance(1000);
      if (!(store.getState().cursor as { playing: boolean }).playing) break;
    }
    const s = store.getState();
    expect(s.cursor).toMatchObject({ mode: 'replay', playing: false, speed: 4, tMs: s.settleMs });
    expect(s.playheadSeq).toBe(events.length);
    s.play();
    expect(store.getState().cursor).toMatchObject({ mode: 'replay', playing: true, tMs: 0 });
  });

  it('ends the scrubber of a running run at the live playhead, not at predicted arrivals', () => {
    const { events } = openFixture();
    const clock = fakeNow(ms(events[20]!.timestamp));
    const { store } = openFixture({ now: clock.now });
    store.getState().ingest(events.slice(0, 21).map(wire), 'live');
    const s = store.getState();
    expect(s.ended).toBe(false);
    expect(s.settleMs).toBeGreaterThan(s.playheadMs()); // characters are still walking
    expect(s.endMs()).toBe(s.playheadMs());
    s.seek(1e9);
    expect(store.getState().cursor).toMatchObject({ mode: 'replay', tMs: s.durationMs, seq: 21 });
    expect(store.getState().playheadSeq).toBe(21);
  });

  it('hands over to live when playback catches up with a running run', () => {
    const { events } = openFixture();
    const clock = fakeNow(ms(events[29]!.timestamp));
    const { store } = openFixture({ now: clock.now });
    store.getState().ingest(events.slice(0, 30).map(wire), 'live');
    store.getState().seekToSeq(25);
    store.getState().play();
    for (let i = 0; i < 20 && store.getState().cursor.mode === 'replay'; i++) store.getState().advance(1000);
    expect(store.getState().cursor).toEqual({ mode: 'live' });
  });
});

describe('studio store: effects', () => {
  it('fire for live arrivals and playback, never for scrubs or replay arrivals', () => {
    const { store, events } = openFixture();
    const fired: number[][] = [];
    store.getState().subscribeEffects((evs) => fired.push(evs.map((e) => e.sequence)));

    store.getState().ingest(events.slice(0, 20).map(wire), 'backlog');
    expect(fired).toEqual([]); // backlog
    store.getState().ingest([wire(events[20])], 'live');
    expect(fired).toEqual([[21]]);

    store.getState().seekToSeq(5);
    expect(fired).toHaveLength(1); // scrub
    store.getState().ingest([wire(events[21])], 'live');
    expect(fired).toHaveLength(1); // arrival while in replay

    store.getState().play();
    const start = store.getState().playheadSeq;
    for (let i = 0; i < 40; i++) store.getState().advance(100);
    const seen = fired.slice(1).flat();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual(seen.map((_, i) => start + 1 + i)); // contiguous, in order, no repeats

    store.getState().seekToSeq(1);
    store.getState().seekToSeq(22); // big jump forward: no bulk effects
    expect(fired.slice(1).flat()).toEqual(seen);
  });
});
