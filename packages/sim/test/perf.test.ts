/**
 * Tick cost at 120 residents (plan §9; numbers are recorded by
 * `pnpm --filter @runloop-world/sim bench`). The assertion is generous (CI
 * machines vary): the target is a 5 ms average tick.
 */
import { describe, expect, it } from 'vitest';
import { benchDay } from '../bench/tick.bench';
import { commons } from './helpers';

describe('tick cost', () => {
  it('averages at most 5 ms per tick at 120 residents over a day (p99 under 10 ms)', () => {
    benchDay(commons(), 120, 1); // warm-up: JIT and navigation fields
    const r = benchDay(commons(), 120, 42);
    expect(r.ticks).toBe(1440);
    expect(r.avgMs).toBeLessThan(5);
    expect(r.p99Ms).toBeLessThan(10);
  });
});
