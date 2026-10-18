/**
 * The town renderer's contract with the Studio shell (B2 mounts it; see README.md).
 *
 * The shell owns the data (world store: snapshot folded with the sim's
 * applyEvent, the clock, the panels) and the chrome; the renderer owns the 3D
 * town, its camera and its labels. The renderer never changes world state:
 * it reads `getState()` every frame and reports what the viewer does through
 * the callbacks.
 */
import type { EntityRef, WorldSnapshot } from '@runloop-world/events';
import type { CompiledTown } from '@runloop-world/town';
import type { AnyEvent } from '@runloop-world/events';
import type { CompiledWorld } from '@runloop-world/world-engine';
import type { SceneFrame } from '../scene/types';
import type { TownClock } from './clock';
import type { QualityPref } from './quality';

/** What the renderer reads each frame (cheap; the snapshot may be mutated in place by the store). */
export interface TownState {
  snapshot: WorldSnapshot | null;
  /** The authoritative clock and the wall time (Date.now()) it arrived; the renderer interpolates (clock.ts). */
  clock: TownClock | null;
}

/** Camera position for deep links (`cam=x,z,zoom`): the target in town cells (x column, z row) and screen px per cell. */
export interface TownCam {
  x: number;
  z: number;
  zoom: number;
}

/** Camera levels: Town (fit everything), District, Street (≈ 24 cells across), Interior. */
export type TownLevel = 'town' | 'district' | 'street' | 'interior';

/**
 * A camera move asked by the shell. `id` must change for each new request
 * (the same id is ignored). Any viewer input interrupts a move in progress.
 * - focus: frame an entity (a resident or agent is followed only if `follow` names it);
 * - enter/exit: open or close a building's interior (also driven by `entered`);
 * - overview: the whole town;
 * - level: zoom to a level around the current centre;
 * - rotate: turn the view 90° (dir 1 = clockwise);
 * - cam: go to an exact camera (deep link).
 */
export interface TownCameraRequest {
  id: number;
  kind: 'focus' | 'enter' | 'exit' | 'overview' | 'level' | 'rotate' | 'cam';
  ref?: EntityRef | null;
  level?: TownLevel;
  dir?: 1 | -1;
  cam?: TownCam;
  /** quick: --rl-dur-camera; cinematic: ≤ 2.5 s (earned moments only); cut: no animation. Reduced motion always cuts. */
  motion?: 'quick' | 'cinematic' | 'cut';
}

/**
 * The run diorama an agent headquarters mounts as its interior (plan §5:
 * scene/{Board,Stations,Paths,Characters,Effects} at 0.5 scale, from the
 * StudioStore of the agent's session). Null when no session is loaded.
 */
export interface AgentHouseSource {
  world: CompiledWorld;
  getFrame: () => SceneFrame;
  subscribeEffects: (fn: (events: readonly AnyEvent[]) => void) => () => void;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string | null) => void;
}

/** A screen rectangle (px from the canvas top-left) labels keep clear of. */
export interface ScreenRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface TownCanvasProps {
  town: CompiledTown;
  /** Read every frame. Must be cheap and stable (memoize it). */
  getState: () => TownState;
  /** The selected entity (the context panel's subject): ringed, labelled, never culled. */
  selected: EntityRef | null;
  /** Keep the camera on this resident or agent. */
  follow: EntityRef | null;
  /** The building whose interior is open (its shell is cut away and the town dims), or null. */
  entered: string | null;
  cameraRequest: TownCameraRequest | null;
  /** The first camera (from a deep link); null = the overview. */
  initialCam?: TownCam | null;
  onSelect: (ref: EntityRef | null) => void;
  /** Double-click (or Enter on a focused building): ask the shell to open its interior. */
  onEnter?: (buildingId: string) => void;
  /** Reported after the camera settles (throttled), for `cam=` deep links. */
  onCamChange?: (cam: TownCam, level: TownLevel) => void;
  onHover?: (ref: EntityRef | null) => void;
  /** The viewer's input interrupted a follow (the shell may clear `follow`). */
  onFollowBroken?: () => void;
  quality: QualityPref;
  reducedMotion: boolean;
  /** Decoration seed (trees and props); the world's seed keeps a town looking the same everywhere. */
  seed?: number;
  /** The run diorama for an agent's headquarters interior (see AgentHouseSource). */
  agentHouse?: (agentId: string) => AgentHouseSource | null;
  /** Floating chrome the labels keep clear of. */
  obstacles?: (width: number, height: number) => ScreenRect[];
  /** Called once the first frame has rendered (the wrapper also gets data-world-ready="true"). */
  onReady?: () => void;
}
