// Test helpers (node only: reads the Commons and the sim fixtures from disk). Never import from browser code.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { WorldEvent, WorldSnapshot } from '@runloop-world/events';
import { loadTown, type CompiledTown } from '@runloop-world/town';

const ROOT = path.join(import.meta.dirname, '../../../..');
const COMMONS = path.join(ROOT, 'worlds/runloop-commons');
const FIXTURES = path.join(ROOT, 'packages/sim/test/fixtures');

export function commonsRaw(): { town: unknown; interiors: Record<string, unknown> } {
  const town = JSON.parse(readFileSync(path.join(COMMONS, 'town.json'), 'utf8')) as unknown;
  const interiors: Record<string, unknown> = {};
  for (const f of readdirSync(path.join(COMMONS, 'interiors'))) {
    if (f.endsWith('.json')) interiors[f.slice(0, -5)] = JSON.parse(readFileSync(path.join(COMMONS, 'interiors', f), 'utf8')) as unknown;
  }
  return { town, interiors };
}

let cached: CompiledTown | null = null;
export function commons(): CompiledTown {
  if (!cached) {
    const raw = commonsRaw();
    cached = loadTown(raw.town, raw.interiors);
  }
  return cached;
}

export function fixtureSnapshot(): WorldSnapshot {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'commons-day1.snapshot.json'), 'utf8')) as WorldSnapshot;
}

export function fixtureEvents(): WorldEvent[] {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'commons-day1.events.json'), 'utf8')) as { events?: WorldEvent[] } | WorldEvent[];
  return Array.isArray(raw) ? raw : (raw.events ?? []);
}
