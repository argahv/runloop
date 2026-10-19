import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, scan, violations } from './purity-scan';

const SRC = path.resolve(import.meta.dirname, '../src');

describe('town purity', () => {
  const files = scan(SRC);

  it('scans the package sources', () => {
    expect(files.map((f) => f.file)).toEqual(expect.arrayContaining(['index.ts', 'schema.ts', 'hash.ts', 'frame.ts']));
  });

  it.each(files.map((f) => [f.file, f] as const))('%s uses no clock, randomness, timers, locale or I/O', (_name, f) => {
    expect(f.problems).toEqual([]);
  });

  it.each(files.map((f) => [f.file, f] as const))('%s imports only zod and its own modules', (_name, f) => {
    for (const spec of f.imports) expect(spec === 'zod' || spec.startsWith('./'), spec).toBe(true);
  });

  it('catches what it bans and ignores comments', () => {
    expect(violations('const t = Date.now();')).toEqual(['Date']);
    expect(violations('const a = Math.sin(x) + Math.sqrt(y);')).toEqual(['transcendental Math']);
    expect(violations('setTimeout(f, 10); const r = Math.random();')).toEqual(['Math.random', 'timers']);
    expect(violations('// no Date here\n/* performance */ const x = 1;')).toEqual([]);
    expect(violations("const n = (1234).toLocaleString('en');")).toEqual(['locale']);
    expect(importsOf("import * as z from 'zod';\nexport * from './schema';")).toEqual(['zod', './schema']);
  });
});
