/**
 * Tick cost benchmark (plan §9): one sim day with no input, timing every
 * tick, at 120 residents in Runloop Commons and at the largest population a
 * bench-only Commons variant holds (every building at 4 floors; the real town
 * houses 136). Also reports events and bytes per day and the gzipped
 * checkpoint size.
 *
 *   pnpm --filter @runloop-world/sim bench
 */
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { loadTown, type CompiledTown } from '@runloop-world/town';
import { readCommons } from '../../town/test/load-commons';
import { applyEvent, createWorld, step, type SimState } from '../src/index';
import type { WorldEvent, WorldEventDraft } from '@runloop-world/events';

export interface BenchResult {
  population: number;
  ticks: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  dayMs: number;
  events: number;
  bytes: number;
  checkpointGzBytes: number;
}

export function benchDay(town: CompiledTown, population: number, seed = 42): BenchResult {
  const drafts = createWorld(town, { worldId: 'bench', seed, population });
  let s: SimState | null = null;
  let seq = 0;
  let bytes = 0;
  let events = 0;
  const emit = (d: WorldEventDraft): WorldEvent => {
    const e = { ...d, seq: ++seq } as WorldEvent;
    s = applyEvent(s, e, town);
    events++;
    bytes += JSON.stringify(e).length;
    return e;
  };
  for (const d of drafts) emit(d);
  const start = s!.tick;
  const world = { town, seed };
  const times: number[] = [];
  const t0 = performance.now();
  for (let t = start + 1; t <= start + 1440; t++) {
    const a = performance.now();
    step(s!, world, t, [], emit);
    times.push(performance.now() - a);
  }
  const dayMs = performance.now() - t0;
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  return {
    population,
    ticks: times.length,
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    p99Ms: q(0.99),
    maxMs: sorted.at(-1)!,
    dayMs,
    events,
    bytes,
    checkpointGzBytes: gzipSync(JSON.stringify(s)).length,
  };
}

/** The Commons with every building at 4 floors (the schema's maximum), for benchmarks only. */
export function tallCommons(): CompiledTown {
  const raw = readCommons();
  const town = structuredClone(raw.town) as { buildings: { floors: number }[]; population: { max: number } };
  for (const b of town.buildings) b.floors = 4;
  town.population.max = 10_000;
  // The beds bound the population; compile tells us how many there are.
  try {
    loadTown(town, raw.interiors);
  } catch (err) {
    const m = /exceeds the (\d+) beds/.exec(String(err));
    if (!m) throw err;
    town.population.max = Number(m[1]);
  }
  return loadTown(town, raw.interiors);
}

const fmt = (r: BenchResult) =>
  `${String(r.population).padStart(4)} residents: tick avg ${r.avgMs.toFixed(3)} ms, p50 ${r.p50Ms.toFixed(3)}, p95 ${r.p95Ms.toFixed(3)}, p99 ${r.p99Ms.toFixed(3)}, max ${r.maxMs.toFixed(2)} ms; ` +
  `day ${r.dayMs.toFixed(0)} ms; ${r.events} events, ${(r.bytes / 1024).toFixed(0)} KB/day; checkpoint ${(r.checkpointGzBytes / 1024).toFixed(1)} KB gz`;

if (process.argv[1]?.endsWith('tick.bench.ts')) {
  const raw = readCommons();
  const commons = loadTown(raw.town, raw.interiors);
  console.log(`Node ${process.version}`);
  benchDay(commons, 120, 1); // warm-up (JIT, nav fields)
  for (const seed of [42, 7]) console.log(fmt(benchDay(commons, 120, seed)));
  const tall = tallCommons();
  const max = Math.min(300, tall.def.population.max);
  benchDay(tall, max, 1);
  console.log(`bench-only Commons at 4 floors (holds ${tall.def.population.max}):`);
  for (const seed of [42, 7]) console.log(fmt(benchDay(tall, max, seed)));
}
