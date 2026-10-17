import { mulberry32 } from './rng';

export interface DeliverOptions {
  /** Probability that an event is delivered twice. */
  dupRate?: number;
  /** Events are shuffled within windows of this size (simulates network reordering). */
  shuffleWindow?: number;
}

/**
 * Simulate an unreliable transport: seeded local shuffling plus duplicates.
 * Every input event is delivered at least once.
 */
export function deliver<E>(events: readonly E[], seed: number, opts: DeliverOptions = {}): E[] {
  const rand = mulberry32(seed);
  const dupRate = opts.dupRate ?? 0.2;
  const window = Math.max(1, opts.shuffleWindow ?? 8);
  const withDups: E[] = [];
  for (const e of events) {
    withDups.push(e);
    if (rand() < dupRate) withDups.push(e);
  }
  const out: E[] = [];
  for (let i = 0; i < withDups.length; i += window) {
    const chunk = withDups.slice(i, i + window);
    for (let j = chunk.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [chunk[j], chunk[k]] = [chunk[k]!, chunk[j]!];
    }
    out.push(...chunk);
  }
  return out;
}
