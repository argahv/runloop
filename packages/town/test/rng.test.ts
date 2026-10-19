import { describe, expect, it } from 'vitest';
import { fnv1a64, hash32, hashRange, inSpan, isOpenAt, minuteOf, minuteOfDay, spanOf } from '../src/index';

/** The textbook FNV-1a 64 with BigInt, to check the limb version. */
function fnvReference(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

describe('fnv1a64', () => {
  it('matches the BigInt reference on varied text', () => {
    const samples = ['', 'a', 'foobar', 'Corner Café ☕', '{"a":1}', 'x'.repeat(1000)];
    for (let i = 0; i < 200; i++) samples.push(String.fromCharCode(...Array.from({ length: i % 40 }, (_, j) => (hash32(i, j) % 0x2fff) + 32)));
    for (const s of samples) expect(fnv1a64(s)).toBe(fnvReference(s));
  });
});

describe('hash32', () => {
  it('is a pure function of its inputs', () => {
    expect(hash32(42, 'dec', 480, 3)).toBe(hash32(42, 'dec', 480, 3));
    expect(hash32(42, 'dec', 480, 3)).not.toBe(hash32(42, 'dec', 480, 4));
    expect(hash32(42, 'dec', 480, 3)).not.toBe(hash32(43, 'dec', 480, 3));
    // Types and boundaries are part of the input.
    expect(hash32(1, 'ab')).not.toBe(hash32(1, 'a', 'b'));
    expect(hash32(1, 97)).not.toBe(hash32(1, 'a'));
    expect(hash32(1, -1)).not.toBe(hash32(1, 2 ** 32 - 1));
  });

  it('spreads evenly enough for jitter and choices', () => {
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) buckets[hash32(7, 'dist', i) % 10]!++;
    for (const n of buckets) expect(Math.abs(n - 2000)).toBeLessThan(200);
    for (let i = 0; i < 1000; i++) {
      const v = hashRange(-20, 20, 7, i);
      expect(v).toBeGreaterThanOrEqual(-20);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it('refuses fractional input', () => {
    expect(() => hash32(1, 0.5)).toThrow();
  });
});

describe('clock helpers', () => {
  it('reads times and opening hours, wrapping past midnight', () => {
    expect(minuteOf('08:30')).toBe(510);
    expect(minuteOfDay(-30)).toBe(1410);
    expect(minuteOfDay(1440 * 3 + 5)).toBe(5);
    expect(inSpan(600, 900, 600)).toBe(true);
    expect(inSpan(600, 900, 900)).toBe(false);
    const tavern = spanOf({ open: '16:00', close: '01:00' });
    expect(isOpenAt(tavern, 23 * 60)).toBe(true);
    expect(isOpenAt(tavern, 30)).toBe(true);
    expect(isOpenAt(tavern, 60)).toBe(false);
    expect(isOpenAt(tavern, 1440 + 17 * 60)).toBe(true);
    expect(isOpenAt(null, 5)).toBe(true);
  });
});
