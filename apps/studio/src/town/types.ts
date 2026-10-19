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
import type { Ref } from 'react';
import type { SceneFrame } from '../scene/types';
import type { TownClock } from './clock';
import type { QualityPref } from './quality';

/** What the renderer reads each frame (cheap; the snapshot may be mutated in place by the store). */
export interface TownState {
  snapshot: WorldSnapshot | null;
  /** The authoritative clock and the wall time (Date.now()) it arrived; the renderer interpolates (clock.ts). */
  clock: TownClock | null;
}

/**
 * Camera position for deep links (`cam=x,z,zoom[,az[,tilt]]`): the target in town cells (x column, z row),
 * screen px per cell at the target, and optionally the azimuth and the tilt in degrees (defaults 45° and 37°).
 */
export interface TownCam {
  x: number;
  z: number;
  zoom: number;
  /** Degrees; 45 = looking from the south-east (the default). */
  az?: number;
  /** Degrees above the ground, 10–62; 37 = the default isometric look. */
  tilt?: number;
}

/** Screen space (px from each canvas edge) covered by floating chrome: framing and the view centre use what is left. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The camera as the HUD sees it (positions in town cells, angles in degrees). */
export interface TownCamState {
  x: number;
  z: number;
  zoom: number;
  az: number;
  tilt: number;
  fovY: number;
  level: TownLevel;
  /** True while a move, a drag, inertia or a spring is running. */
  moving: boolean;
  /** Ground footprint of the view in cells, 4 corners (bottom-left, bottom-right, top-right, top-left); far ones clipped at 2× the town size. */
  footprint: [number, number][];
}

/** A world point on screen (px from the canvas top-left). `visible` = in front of the camera and inside the canvas. */
export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
  /** Distance from the camera (scene units). */
  depth: number;
}

/** A screen rectangle (px from the canvas top-left). */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the HUD can ask the renderer every frame (anchored cards, the minimap). Cheap; no React state. */
export interface TownApi {
  /** Anchor: a resident's or robot's head, a building's roof, a lot's or district's centre. Null when unknown. */
  projectEntity(ref: EntityRef): ScreenPoint | null;
  /**
   * The screen box the entity covers (its corners projected, clipped to the
   * canvas), so a card can stand beside it. Null for points (districts, spots),
   * unknown entities, or when it is behind the camera.
   */
  projectBounds(ref: EntityRef): ScreenBox | null;
  /** A town cell (x column, z row; fractional) at `height` scene units. Null before the first frame. */
  projectCell(x: number, z: number, height?: number): ScreenPoint | null;
  /** The town cell under a canvas pixel; null = sky. */
  groundAt(px: number, py: number): { x: number; z: number } | null;
  getCamera(): TownCamState;
  /** Called after each frame's camera update. Keep it cheap. Returns the unsubscribe. */
  onFrame(fn: (cam: TownCamState) => void): () => void;
}

/** What the soundscape hears (~4 Hz). Same shape as the audio module's listener; the renderer never imports audio. */
export interface TownListener {
  /** Camera target in town cells. */
  x: number;
  z: number;
  /** 0 = the whole town … 1 = street level and closer. */
  zoom01: number;
  /** Degrees. */
  az: number;
  level: TownLevel;
  entered: string | null;
  /** Minute of day (fractional) and 0 day … 1 night. */
  minute: number;
  night: number;
  /** The world clock is paused. */
  paused: boolean;
  /** Nearby sound sources: simulated occupancy (murmur), water, greenery, roads, fields. Never an agent lot. */
  sources: { kind: 'murmur' | 'water' | 'green' | 'road' | 'field'; id: string; gain: number; pan: number }[];
}

/** Lot picking for Add to World: free lots glow and can be picked; taken lots show their agent's name. */
export interface LotPick {
  lots: { id: string; state: 'free' | 'taken'; label: string }[];
  selected: string | null;
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
 * - rotate: turn the view `deg` degrees (default 90; dir 1 = clockwise);
 * - cam: go to an exact camera (deep link);
 * - goto: centre a town cell (`point`, the minimap), keeping zoom, azimuth and tilt.
 */
export interface TownCameraRequest {
  id: number;
  kind: 'focus' | 'enter' | 'exit' | 'overview' | 'level' | 'rotate' | 'cam' | 'goto';
  ref?: EntityRef | null;
  level?: TownLevel;
  dir?: 1 | -1;
  deg?: number;
  cam?: TownCam;
  /** goto: the town cell to centre (x column, z row). */
  point?: { x: number; z: number };
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
  /** Filled with the renderer's API once mounted (anchored cards, the minimap). */
  apiRef?: Ref<TownApi>;
  /** HUD occlusion: framing and the view centre use the free area (eased; cut under reduced motion). */
  viewInsets?: Insets;
  /** Add to World: lots to pick from (onSelect is not called for lots while this is set; onPickLot is). */
  lotPick?: LotPick | null;
  onPickLot?: (lotId: string) => void;
  onHoverLot?: (lotId: string | null) => void;
  /** A viewer drag, rotation, tilt or pinch started (true) or ended (false): the HUD fades while it runs. */
  onInteraction?: (active: boolean) => void;
  /** A quick or cinematic camera move started (not a cut): its duration and a stereo pan (−1 … 1). */
  onFly?: (durationMs: number, pan: number) => void;
  /** The soundscape's listener (~4 Hz). */
  onListener?: (l: TownListener) => void;
  /** A long press (500 ms) on something: select it and expand its card. */
  onLongPress?: (ref: EntityRef) => void;
  /** The land beyond the town: full, lite (phones, low quality) or off. Default 'full'. */
  surroundings?: 'full' | 'lite' | 'off';
  /** Decorative ambient life (cars, birds, cloud drift, water shimmer). False under reduced motion. Default true. */
  ambientLife?: boolean;
  /** At most this many labels (default 24; 12 on phones). */
  labelBudget?: number;
  /** Camera keys (WASD, arrows, Q E Z X, + −, 0, Home, R). Default true. */
  keyboard?: boolean;
  /** Stop rendering (another canvas is on top). */
  paused?: boolean;
}
