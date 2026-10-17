// Test helpers (node only: reads the world from disk). Never import from browser code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunDetailResponse, RunEvent, RunSummary } from '@runloop-world/events';
import { codingMissionFixture } from '@runloop-world/testkit';
import { createStudioStore, type StudioStore } from './store';

const WORLD_FILE = path.join(import.meta.dirname, '../../../../worlds/research-campus/world.json');

export function worldJson(): unknown {
  return JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as unknown;
}

export function detailFor(events: readonly RunEvent[], status: RunSummary['status'] = 'running'): RunDetailResponse {
  const first = events[0]!;
  return {
    run: {
      runId: first.runId,
      title: 'Fixture run',
      missionId: 'coding-mission',
      worldId: 'research-campus',
      status,
      createdAt: first.timestamp,
      endedAt: null,
      lastSequence: events.length,
      adapterLabel: 'Scripted adapter',
      paused: false,
    },
    world: worldJson(),
  };
}

/** A mutable fake wall clock. */
export function fakeNow(startMs: number) {
  let t = startMs;
  return { now: () => t, set: (ms: number) => (t = ms), advance: (ms: number) => (t += ms) };
}

/** A store with the canonical fixture's run opened (world loaded, no events yet). */
export function openFixture(opts: { now?: () => number } = {}): { store: StudioStore; events: RunEvent[] } {
  const events = codingMissionFixture();
  const store = createStudioStore(opts.now ? { now: opts.now } : {});
  store.getState().openRun(events[0]!.runId);
  store.getState().loadRun(detailFor(events));
  return { store, events };
}

/** JSON round trip, like events arriving over HTTP. */
export const wire = <T>(v: T): unknown => JSON.parse(JSON.stringify(v)) as unknown;
