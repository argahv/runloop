import { describe, expect, it } from 'vitest';
import { NEED_IDS, OutfitStyleSchema, RESIDENT_ACTIONS, TRAIT_IDS } from '@runloop-world/events';
import { TOWN_ACTIONS, TOWN_NEEDS, TOWN_OUTFIT_STYLES } from '@runloop-world/town';
import { MAX_CANDIDATES, SIM_VERSION, applyEvent } from '../src/index';

describe('sim contracts', () => {
  it('uses the same actions, needs and outfits in the town file as in world events', () => {
    expect([...TOWN_ACTIONS]).toEqual([...RESIDENT_ACTIONS]);
    expect([...TOWN_NEEDS]).toEqual([...NEED_IDS]);
    expect([...TOWN_OUTFIT_STYLES]).toEqual(OutfitStyleSchema.options);
    // decide.ts treats trait axis 2 as outdoorsy.
    expect(TRAIT_IDS[2]).toBe('outdoorsy');
  });

  it('is at sim version 1 and scores at most 10 candidates (plan §3)', () => {
    expect(SIM_VERSION).toBe(1);
    expect(MAX_CANDIDATES).toBe(10);
  });

  it('folds nothing before world.created, and needs the town for it', () => {
    expect(() => applyEvent(null, { seq: 1, tick: 0, type: 'world.clock_changed', prov: 'user', cmdId: 'c', p: { speed: 0, prevSpeed: 1 } })).toThrow(/before world.created/);
    expect(() =>
      applyEvent(null, {
        seq: 1,
        tick: 0,
        type: 'world.created',
        prov: 'system',
        p: { worldId: 'w', townId: 't', contentHash: '0000000000000000', seed: 1, simVersion: 1, startTick: 0, roster: [] },
      }),
    ).toThrow(/needs the town/);
  });
});
