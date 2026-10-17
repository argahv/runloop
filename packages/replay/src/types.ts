import type { ExecState } from '@runloop-world/core';
import type { WorldState } from '@runloop-world/world-engine';

/** Combined Layer-1 + Layer-2 state at a sequence. */
export interface RunState {
  exec: ExecState;
  world: WorldState;
}
