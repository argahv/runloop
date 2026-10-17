import type { Cell, CharacterPreset, Station, WorldDefinition, Zone, StationKind } from './definition';

/** A world definition with derived lookup tables (build once with compileWorld()). */
export interface CompiledWorld {
  def: WorldDefinition;
  width: number;
  height: number;
  /** Walkable = floor and not a station / prop / hub-core footprint. */
  isWalkable(x: number, y: number): boolean;
  zonesById: Record<string, Zone>;
  stationsById: Record<string, Station>;
  /** Stations of each kind, sorted by id (deterministic allocation order). */
  stationsByKind: Partial<Record<StationKind, Station[]>>;
  presetsById: Record<string, CharacterPreset>;
}

/** Closed-form movement: walk `path` one cell per ticksPerCell, starting at startTick. */
export interface Motion {
  /**
   * Cells from the start cell to the destination (inclusive). Length ≥ 1.
   * After a mid-step re-plan, path[0] is the cell being left and path[1] the
   * cell being entered, so positions stay continuous.
   */
  path: Cell[];
  startTick: number;
}

/** What the world wants a character to be doing (derived from Layer-1 state). */
export type Activity = 'idle' | 'working' | 'waiting' | 'awaiting_approval' | 'succeeded' | 'failed';

export type Target =
  | { kind: 'home' }
  | { kind: 'stay' }
  | { kind: 'slot'; stationId: string; index: number }
  | { kind: 'overflow'; stationId: string };

export interface CharacterWorld {
  agentId: string;
  presetId: string;
  home: Cell;
  activity: Activity;
  /** Task driving the current activity, if any. */
  taskId: string | null;
  /** Station involved in the current activity (also kept for 'waiting' in overflow). */
  stationId: string | null;
  target: Target;
  motion: Motion;
  /** Tick at which the activity last changed. */
  sinceTick: number;
}

export interface StationWorld {
  /** Occupant agentId per slot (null = free). */
  slots: (string | null)[];
  /** Agents queued at the overflow cell, in arrival order. */
  overflow: string[];
}

/** Layer 2 — world simulation state, a pure function of events + world definition. */
export interface WorldState {
  lastSequence: number;
  /** Monotonic tick of the last folded event (ticks since run start). */
  tick: number;
  /** Run start in ms since epoch, from the first folded event. */
  runStartMs: number | null;
  paused: boolean;
  characters: Record<string, CharacterWorld>;
  characterOrder: string[];
  stations: Record<string, StationWorld>;
}

/** Presentation state for the renderer (Layer 3 input). */
export type PresentationState =
  | 'idle'
  | 'moving'
  | 'working'
  | 'waiting'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'paused';

export interface CharacterPose {
  state: PresentationState;
  /** Continuous grid-space position (cell centres are integers). */
  x: number;
  y: number;
  /** Heading in radians in grid space (0 = +x, π/2 = +y). */
  heading: number;
  moving: boolean;
  /** Cell the character is in or entering. */
  cell: Cell;
}
