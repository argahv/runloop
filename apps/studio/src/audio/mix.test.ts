import { describe, expect, it } from 'vitest';
import { INTERIOR_OUTDOOR_GAIN, ROOM_TONE, SILENT_MIX, ambientMix, smoothToward } from './mix';
import type { AudioListener } from './types';

const base = (p: Partial<AudioListener> = {}): AudioListener => ({
  x: 48,
  z: 36,
  zoom01: 0.5,
  az: 45,
  entered: null,
  level: 'district',
  minute: 12 * 60,
  night: 0,
  paused: false,
  sources: [],
  ...p,
});

describe('ambientMix', () => {
  it('is silent without a listener (no town on screen) and under "reduce sound"', () => {
    expect(ambientMix(null)).toEqual(SILENT_MIX);
    expect(ambientMix(base({ sources: [{ kind: 'murmur', id: 'spot_cafe_patio', gain: 1, pan: 0 }] }), { reduce: true })).toEqual(SILENT_MIX);
  });

  it('breeze and high wind follow zoom: wide views are airier', () => {
    const town = ambientMix(base({ zoom01: 0 }));
    const street = ambientMix(base({ zoom01: 1 }));
    expect(town.breeze).toBeCloseTo(0.6);
    expect(street.breeze).toBeCloseTo(0.35);
    expect(town.wind).toBeCloseTo(0.25);
    expect(street.wind).toBe(0);
  });

  it('birds by day, crickets by night, cross-fading continuously with night', () => {
    const green = [{ kind: 'green' as const, id: 'park', gain: 0.8, pan: 0 }];
    let lastBirds = Infinity;
    let lastCrickets = -Infinity;
    for (let n = 0; n <= 1.0001; n += 0.1) {
      const m = ambientMix(base({ night: n, sources: green }));
      expect(m.birdsRate).toBeLessThanOrEqual(lastBirds);
      expect(m.crickets).toBeGreaterThanOrEqual(lastCrickets);
      lastBirds = m.birdsRate;
      lastCrickets = m.crickets;
    }
    expect(ambientMix(base({ night: 0, sources: green })).crickets).toBe(0);
    expect(ambientMix(base({ night: 1, sources: green })).birdsRate).toBe(0);
    // calls/s = 0.5·day·green·(0.25+0.75z), green = 0.1 floor + 0.8
    expect(ambientMix(base({ night: 0, zoom01: 1, sources: green })).birdsRate).toBeCloseTo(0.5 * 0.9);
  });

  it('greenery and fields bring more birds than rooftops', () => {
    const roofs = ambientMix(base());
    const park = ambientMix(base({ sources: [{ kind: 'green', id: 'park', gain: 0.6, pan: 0 }] }));
    const fields = ambientMix(base({ sources: [{ kind: 'field', id: 'field_1', gain: 0.6, pan: 0 }] }));
    expect(roofs.birdsRate).toBeGreaterThan(0);
    expect(fields.birdsRate).toBeGreaterThan(roofs.birdsRate);
    expect(park.birdsRate).toBeGreaterThan(fields.birdsRate);
  });

  it('murmur comes only from murmur sources, grows with zoom, is capped, pans to its side, and never from an excluded (agent) place', () => {
    const src = [
      { kind: 'murmur' as const, id: 'spot_cafe_patio', gain: 0.6, pan: -0.5 },
      { kind: 'murmur' as const, id: 'spot_fountain_rim', gain: 0.9, pan: -0.2 },
      { kind: 'water' as const, id: 'pond', gain: 1, pan: 0.8 },
      { kind: 'road' as const, id: 'brook_road', gain: 1, pan: 0.5 },
    ];
    const near = ambientMix(base({ zoom01: 1, sources: src }));
    expect(near.murmur).toBe(1);
    expect(near.murmurPan).toBeLessThan(0);
    const far = ambientMix(base({ zoom01: 0, sources: src }));
    expect(far.murmur).toBeCloseTo(0.2);
    expect(ambientMix(base({ sources: src.filter((s) => s.kind !== 'murmur') })).murmur).toBe(0);
    const excluded = ambientMix(base({ zoom01: 1, sources: src }), { exclude: new Set(['spot_cafe_patio', 'spot_fountain_rim']) });
    expect(excluded.murmur).toBe(0);
  });

  it('water is the nearest water source, heard close up; traffic is a distant hum, quieter at night', () => {
    const src = [
      { kind: 'water' as const, id: 'brook', gain: 0.4, pan: -1 },
      { kind: 'water' as const, id: 'fountain', gain: 0.9, pan: 0.3 },
      { kind: 'road' as const, id: 'westway', gain: 0.7, pan: -0.6 },
    ];
    const m = ambientMix(base({ zoom01: 1, sources: src }));
    expect(m.water).toBeCloseTo(0.9);
    expect(m.waterPan).toBeCloseTo(0.3);
    expect(m.trafficPan).toBeCloseTo(-0.6);
    expect(ambientMix(base({ zoom01: 0, sources: src })).water).toBe(0);
    expect(ambientMix(base({ zoom01: 1, night: 0 })).traffic).toBeCloseTo(0.15);
    expect(ambientMix(base({ zoom01: 1, night: 1 })).traffic).toBeCloseTo(0.15 * 0.4);
    expect(ambientMix(base({ zoom01: 0, night: 0 })).traffic).toBeCloseTo(0.35);
  });

  it('a paused world goes quiet: no murmur, traffic, birds or crickets; the breeze stays at half', () => {
    const src = [
      { kind: 'murmur' as const, id: 'spot_cafe_patio', gain: 1, pan: 0 },
      { kind: 'green' as const, id: 'park', gain: 1, pan: 0 },
      { kind: 'water' as const, id: 'pond', gain: 1, pan: 0 },
    ];
    for (const night of [0, 1]) {
      const run = ambientMix(base({ night, sources: src }));
      const paused = ambientMix(base({ night, sources: src, paused: true }));
      expect(paused.murmur).toBe(0);
      expect(paused.traffic).toBe(0);
      expect(paused.birdsRate).toBe(0);
      expect(paused.crickets).toBe(0);
      expect(paused.breeze).toBeCloseTo(run.breeze / 2);
      expect(paused.water).toBe(run.water);
    }
  });

  it('inside a building: interior bed and room tone', () => {
    const m = ambientMix(base({ entered: 'bld_corner_cafe', level: 'interior' }));
    expect(m.interior).toBe(true);
    expect(m.room).toBe(ROOM_TONE);
    expect(ambientMix(base()).interior).toBe(false);
    expect(20 * Math.log10(INTERIOR_OUTDOOR_GAIN)).toBeCloseTo(-9);
  });

  it('keeps every level in range for any listener, even malformed numbers', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 0.5;
    for (let i = 0; i < 300; i++) {
      const kinds = ['murmur', 'water', 'green', 'road', 'field'] as const;
      const sources = Array.from({ length: 6 }, (_, j) => ({ kind: kinds[j % 5]!, id: `s${j}`, gain: rnd() * 2, pan: rnd() * 3 }));
      const m = ambientMix(base({ zoom01: rnd() * 2, night: i === 0 ? Number.NaN : rnd() * 2, paused: i % 3 === 0, sources }));
      for (const k of ['breeze', 'wind', 'crickets', 'murmur', 'water', 'traffic', 'room', 'day'] as const) {
        expect(m[k], k).toBeGreaterThanOrEqual(0);
        expect(m[k], k).toBeLessThanOrEqual(1);
      }
      expect(m.birdsRate).toBeLessThanOrEqual(0.5);
      for (const k of ['murmurPan', 'waterPan', 'trafficPan'] as const) expect(Math.abs(m[k])).toBeLessThanOrEqual(1);
    }
  });
});

describe('smoothToward', () => {
  it('reaches ~95% of the way in 3τ and jumps with τ 0', () => {
    let v = 0;
    for (let t = 0; t < 1.5; t += 0.25) v = smoothToward(v, 1, 0.25, 0.5);
    expect(v).toBeGreaterThan(0.94);
    expect(v).toBeLessThan(1);
    expect(smoothToward(0.2, 0.9, 0.1, 0)).toBe(0.9);
    expect(smoothToward(0.2, 0.9, 0, 1)).toBe(0.2);
  });
});
