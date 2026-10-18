/**
 * @runloop-world/sim: the town's residents, as a pure stepped simulation
 * (plan §3). No I/O, clock or randomness (test/purity.test.ts); never imports
 * dispatch (P11). Only the world host reads the clock.
 *
 * - generate: createWorld (roster and first decisions);
 * - step: inputs, wake, decide, interact (applyInputs between ticks);
 * - apply: applyEvent, the only mutator (host, replay and Studio);
 * - commands: validateCommand; explain: Why, from the recorded event only;
 * - replay: WorldReplay and hashState.
 */
export { SIM_VERSION } from './version';
export { applyEvent, foldEvents, type SimState, type TownBuildingList } from './apply';
export { validateCommand, applyCommand, type CommandCheck } from './commands';
export { createWorld, buildRoster, tickAt, type CreateWorldOptions } from './generate';
export { step, applyInputs, type Emit } from './step';
export { explain } from './explain';
export { WorldReplay, hashState, type WorldCheckpoint } from './replay';
export { arrivalTick, cellNow, startNeeds, MAX_CANDIDATES } from './decide';
export { needsAt, crossingTick, needPart, points } from './needs';
export { scheduleShift, blockAt, scheduleOf, isBoundary } from './schedule';
export { Occupancy, assignmentsOf, destinationOf, isAvailable } from './occupancy';
export { simIndex, type SimWorld, type SimIndex, type PlaceDef } from './world';
export type { CompiledTown } from '@runloop-world/town';
