import type { AnyEvent } from '@runloop-world/events';
import type { RunState } from '@runloop-world/replay';
import type { CompiledWorld } from '@runloop-world/world-engine';

/** What the 3D scene needs each frame. Read it inside useFrame; never put it in React state. */
export interface SceneFrame {
  /** Layer 1 + 2 state at the playhead (live: latest; replay: stateAt(seqAtTime(ms))). */
  state: RunState;
  /** Fractional world tick at the playhead (msToTick(playheadMs, tickHz)). */
  tick: number;
  /** Playhead in ms since run start. */
  playheadMs: number;
  /** True while the playhead is advancing (live, or replay playing). */
  advancing: boolean;
}

export type CameraMode = 'iso' | 'top';
export type Quality = 'high' | 'low';

/**
 * Contract between the Studio shell (owns data + UI) and the scene
 * (owns rendering). The shell renders `<WorldCanvas {...props} />` via
 * next/dynamic with ssr:false; `scene/WorldCanvas.tsx` default-exports it.
 */
export interface SceneProps {
  world: CompiledWorld;
  /** Called every rendered frame. Must be cheap (memoized by the shell). */
  getFrame: () => SceneFrame;
  /**
   * Events that newly became visible because the playhead moved forward by a
   * small step (live arrival or replay playback). Fires effects (tool pulses,
   * message packets). NOT called on scrubs/jumps, so effects never replay in bulk.
   * Returns an unsubscribe function.
   */
  subscribeEffects: (fn: (events: readonly AnyEvent[]) => void) => () => void;
  selectedAgentId: string | null;
  selectedStationId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onSelectStation: (stationId: string | null) => void;
  cameraMode: CameraMode;
  /** Keep the camera centred on the selected character. */
  follow: boolean;
  quality: Quality;
  reducedMotion: boolean;
  /** Set data-world-ready="true" on the canvas wrapper once the first frame rendered. */
  onReady?: () => void;
}
