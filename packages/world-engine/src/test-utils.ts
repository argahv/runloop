/** Helpers for world-engine tests (not exported from the package). */
import { readFileSync } from 'node:fs';
import { initialExecState, reduceExecution, type ExecState } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import { RunBuilder, runBuilder } from '@runloop-world/testkit';
import { loadWorld } from './compile';
import type { WorldDefinition } from './definition';
import { initialWorldState, reduceWorld } from './reduce-world';
import type { CompiledWorld, WorldState } from './types';

export const campusJson = (): WorldDefinition =>
  JSON.parse(readFileSync(new URL('../../../worlds/research-campus/world.json', import.meta.url), 'utf8'));

/**
 * The campus layout with its walk speed pinned to 3 ticks per cell, so the
 * tick arithmetic in tests doesn't change when world.json's speed is retuned.
 */
export const campus = (): CompiledWorld => loadWorld({ ...campusJson(), ticksPerCell: 3 });

export interface Step {
  event: AnyEvent;
  exec: ExecState;
  world: WorldState;
}

/** Fold events through both layers, keeping the state after every event. */
export function foldSteps(events: readonly AnyEvent[], world: CompiledWorld): Step[] {
  let exec = initialExecState();
  let w = initialWorldState();
  return events.map((event) => {
    exec = reduceExecution(exec, event);
    w = reduceWorld(w, exec, event, world);
    return { event, exec, world: w };
  });
}

export const finalWorld = (events: readonly AnyEvent[], world: CompiledWorld) => foldSteps(events, world).at(-1)!.world;

/** The world state in effect at `tick` (state after the last event at or before it). */
export function stateAtTick(steps: readonly Step[], tick: number): WorldState {
  let found = steps[0]!.world;
  for (const s of steps) {
    if (s.world.tick <= tick) found = s.world;
    else break;
  }
  return found;
}

export interface AgentSpec {
  id: string;
  preset?: string;
  embodied?: boolean;
}

/** run.started plus agent registrations, 100 ms (1 tick) apart. */
export function startRun(agents: AgentSpec[]): RunBuilder {
  const b = runBuilder({ startIso: '2026-10-17T09:00:00.000Z' });
  b.add('run.started', {
    title: 'test',
    missionId: 'm',
    worldId: 'research-campus',
    seed: 1,
    adapter: { id: 'x', kind: 'scripted', label: 'X' },
    workspace: 'workspaces/x',
  });
  for (const a of agents) {
    b.wait(100).add('agent.registered', {
      agentId: a.id,
      name: a.id,
      role: 'r',
      model: null,
      tools: [],
      embodied: a.embodied ?? true,
      ...(a.preset ? { characterPreset: a.preset } : {}),
    });
  }
  return b;
}
