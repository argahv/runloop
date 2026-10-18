import type { WorldEvent } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { catchUpFooter, summarizeSince } from './catchUp';
import { ENGINEERING_HOUSE, fixtureEvents } from './test-utils';

const talk = (seq: number, tick: number, placeId: string): WorldEvent => ({
  seq,
  tick,
  type: 'interaction.happened',
  prov: 'simulation',
  actor: 'res_0001',
  p: { a: 0, b: 1, placeId, dAffinity: 1 },
});

describe('catch-up', () => {
  it('summarises the fixture morning: agents first, every line cites seqs inside the range', () => {
    const events = fixtureEvents();
    const c = summarizeSince(events, 0)!;
    expect(c).not.toBeNull();
    expect(c.fromSeq).toBe(1);
    expect(c.toSeq).toBe(events.at(-1)!.seq);
    expect(c.eventCount).toBe(events.length);
    expect(c.agents.length).toBeGreaterThan(0);
    expect(c.agents[0]!.refs[0]).toEqual({ kind: 'agent', id: ENGINEERING_HOUSE });
    for (const line of [...c.agents, ...c.town]) {
      expect(line.events).not.toBeNull();
      expect(line.events!.first).toBeGreaterThanOrEqual(c.fromSeq);
      expect(line.events!.last).toBeLessThanOrEqual(c.toSeq);
    }
    expect(catchUpFooter(c)).toBe(`From ${events.length} recorded events (seq 1–${events.at(-1)!.seq})`);
  });

  it('counts equal a recount from the raw events', () => {
    const events = fixtureEvents();
    const c = summarizeSince(events, 0)!;
    for (const line of [...c.agents, ...c.town]) {
      if (line.kind !== 'conversations') continue;
      const place = line.refs[0]!.id;
      const recount = events.filter((e) => e.type === 'interaction.happened' && e.p.placeId === place).length;
      expect(line.events!.count).toBe(recount);
    }
    const synthetic = [talk(1, 0, 'spot_a'), talk(2, 30, 'spot_a'), talk(3, 50, 'spot_b'), talk(4, 70, 'spot_a')];
    const s = summarizeSince(synthetic, 0)!;
    expect(s.town.map((l) => [l.refs[0]!.id, l.events!.count])).toEqual([
      ['spot_a', 3],
      ['spot_b', 1],
    ]);
  });

  it('stays quiet for a short, uneventful gap and ignores what was already seen', () => {
    expect(summarizeSince([talk(1, 0, 'spot_a'), talk(2, 20, 'spot_a')], 0)).toBeNull();
    expect(summarizeSince([talk(1, 0, 'spot_a'), talk(2, 90, 'spot_a')], 2)).toBeNull();
    // An hour of sim time is enough on its own.
    expect(summarizeSince([talk(1, 0, 'spot_a'), talk(2, 60, 'spot_a')], 0)).not.toBeNull();
  });

  it('shows at most five town lines', () => {
    const many = Array.from({ length: 12 }, (_, i) => talk(i + 1, i * 10, `spot_p${i}`));
    expect(summarizeSince(many, 0)!.town).toHaveLength(5);
  });
});
