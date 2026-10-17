import { describe, expect, it } from 'vitest';
// events has no dependency on testkit (testkit depends on events), so tests import its source directly.
import { codingMissionFixture, deliver, mulberry32 } from '../../testkit/src/index';
import { SequenceBuffer, type Sequenced } from './sequence-buffer';

const ev = (sequence: number, eventId = `e${sequence}`): Sequenced => ({ sequence, eventId });
const seqs = (list: Sequenced[]) => list.map((e) => e.sequence);

describe('SequenceBuffer', () => {
  it('releases contiguous runs only, in order', () => {
    const b = new SequenceBuffer();
    expect(b.push(ev(2))).toEqual([]);
    expect(b.push(ev(3))).toEqual([]);
    expect(b.pendingCount).toBe(2);
    expect(seqs(b.push(ev(1)))).toEqual([1, 2, 3]);
    expect(b.nextExpected).toBe(4);
    expect(b.lastReleased).toBe(3);
    expect(b.pendingCount).toBe(0);
  });

  it('drops duplicates with the same eventId silently', () => {
    const b = new SequenceBuffer();
    b.push(ev(1));
    expect(b.push(ev(1))).toEqual([]); // already released
    b.push(ev(3));
    expect(b.push(ev(3))).toEqual([]); // already pending
    expect(b.conflicts).toEqual([]);
    expect(seqs(b.push(ev(2)))).toEqual([2, 3]);
  });

  it('records conflicts for the same sequence with a different eventId and keeps the first', () => {
    const b = new SequenceBuffer();
    b.push(ev(1, 'a'));
    b.push(ev(1, 'b'));
    b.push(ev(3, 'c'));
    b.push(ev(3, 'd'));
    expect(b.conflicts).toEqual([
      { sequence: 1, keptEventId: 'a', droppedEventId: 'b' },
      { sequence: 3, keptEventId: 'c', droppedEventId: 'd' },
    ]);
    expect(b.push(ev(2))[1]!.eventId).toBe('c');
  });

  it('reports the gap blocking release', () => {
    const b = new SequenceBuffer();
    expect(b.missing()).toBeNull();
    b.push(ev(1));
    b.push(ev(4));
    b.push(ev(7));
    expect(b.missing()).toEqual({ from: 2, to: 3 });
    b.pushMany([ev(2), ev(3)]);
    expect(b.missing()).toEqual({ from: 5, to: 6 });
    expect(seqs(b.pushMany([ev(6), ev(5)]))).toEqual([5, 6, 7]);
    expect(b.missing()).toBeNull();
  });

  it('can start after an already-consumed sequence', () => {
    const b = new SequenceBuffer({ after: 10 });
    expect(b.push(ev(9))).toEqual([]);
    expect(seqs(b.push(ev(11)))).toEqual([11]);
  });

  it('restores the original order across 200 seeded shuffles with 20% duplicates', () => {
    const events = codingMissionFixture();
    const ids = events.map((e) => e.eventId);
    for (let seed = 1; seed <= 200; seed++) {
      const window = 2 + Math.floor(mulberry32(seed)() * 15);
      const delivered = deliver(events, seed, { dupRate: 0.2, shuffleWindow: window });
      expect(delivered.length).toBeGreaterThan(events.length);
      const b = new SequenceBuffer<(typeof events)[number]>();
      const out = b.pushMany(delivered);
      expect(out.map((e) => e.eventId)).toEqual(ids);
      expect(b.conflicts).toEqual([]);
      expect(b.missing()).toBeNull();
    }
  });
});
