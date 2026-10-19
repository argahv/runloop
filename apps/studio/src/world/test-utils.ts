/**
 * Test helpers: the engine-generated fixture day (packages/sim/test/fixtures)
 * and the Runloop Commons town, read from the repository. Tests only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { parseWorldEvent, WorldSnapshotSchema, type WorldEvent, type WorldSnapshot } from '@runloop-world/events';
import { loadTown, type CompiledTown } from '@runloop-world/town';

const repo = new URL('../../../../', import.meta.url);
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, repo), 'utf8')) as unknown;

let townCache: CompiledTown | null = null;

/** The committed Runloop Commons, compiled. */
export function commonsTown(): CompiledTown {
  if (townCache) return townCache;
  const interiors: Record<string, unknown> = {};
  for (const f of readdirSync(new URL('worlds/runloop-commons/interiors/', repo))) {
    if (f.endsWith('.json')) interiors[f.slice(0, -5)] = json(`worlds/runloop-commons/interiors/${f}`);
  }
  townCache = loadTown(json('worlds/runloop-commons/town.json'), interiors);
  return townCache;
}

/** Every fixture event, parsed (seq 1 = world.created). */
export function fixtureEvents(): WorldEvent[] {
  return (json('packages/sim/test/fixtures/commons-day1.events.json') as unknown[]).map((raw) => {
    const r = parseWorldEvent(raw);
    if (!r.ok) throw new Error(r.error);
    return r.event;
  });
}

/** A fresh copy of the fixture snapshot (Day 1 08:15). */
export function fixtureSnapshot(): WorldSnapshot {
  return WorldSnapshotSchema.parse(json('packages/sim/test/fixtures/commons-day1.snapshot.json'));
}

/** The fixture's two agents. */
export const ENGINEERING_HOUSE = 'agt_5f1c2a8e-3b4d-4c6e-9a7b-1d2e3f405a61';
export const DOCS_DESK = 'agt_9b2d4e6f-1a3c-4e5d-8f7a-2b3c4d5e6f70';
