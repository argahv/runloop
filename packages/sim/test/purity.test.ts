import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../../town/test/purity-scan';

const SRC = path.resolve(import.meta.dirname, '../src');
const ALLOWED = new Set(['@runloop-world/events', '@runloop-world/town']);

describe('sim purity', () => {
  const files = scan(SRC);

  it('scans the package sources', () => {
    expect(files.map((f) => f.file)).toContain('index.ts');
  });

  it.each(files.map((f) => [f.file, f] as const))('%s uses no clock, randomness, timers, locale or I/O', (_name, f) => {
    expect(f.problems).toEqual([]);
  });

  it.each(files.map((f) => [f.file, f] as const))('%s imports only events, town and its own modules, never dispatch (P11)', (_name, f) => {
    for (const spec of f.imports) {
      expect(ALLOWED.has(spec) || spec.startsWith('./'), spec).toBe(true);
      expect(spec).not.toMatch(/dispatch|runtime/);
    }
  });
});
