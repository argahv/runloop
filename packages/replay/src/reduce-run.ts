import { initialExecState, reduceExecution } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import { initialWorldState, reduceWorld, type CompiledWorld } from '@runloop-world/world-engine';
import type { RunState } from './types';

export function initialRunState(): RunState {
  return { exec: initialExecState(), world: initialWorldState() };
}

/**
 * Fold one event into both layers: execution first, then the world from the
 * new execution state. Used identically by live view and replay. Redelivered
 * sequences return `s` unchanged; gaps throw SequenceGapError.
 */
export function reduceRun(s: RunState, e: AnyEvent, world: CompiledWorld): RunState {
  const exec = reduceExecution(s.exec, e);
  if (exec === s.exec) return s;
  return { exec, world: reduceWorld(s.world, exec, e, world) };
}
