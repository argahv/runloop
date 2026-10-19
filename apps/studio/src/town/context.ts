'use client';
/**
 * Shared state inside the town canvas. Per-frame values live in a mutable
 * `TownFrame` written once per frame by FrameDriver (before anything else
 * reads it); nothing per-frame goes through React state.
 */
import type { EntityRef, WorldSnapshot } from '@runloop-world/events';
import type { CompiledTown } from '@runloop-world/town';
import { createContext, useContext } from 'react';
import type { Object3D, Vector3 } from 'three';
import type { ScopedLabelStore } from './AgentHouse';
import type { Tier } from './lod';
import type { TownPlaces } from './place';
import type { QualitySettings } from './quality';
import type { Sky } from './sky';
import type { TownCamRuntime } from './TownCamera';
import type { TownUniforms } from './townMaterial';
import type { AgentHouseSource, LotPick, TownLevel } from './types';

export interface TownFrame {
  /** Fractional world tick drawn this frame. */
  tick: number;
  /** Minute of day (fractional). */
  minute: number;
  /** Local wall time (ms) and the frame's delta (s). */
  now: number;
  dt: number;
  /** Wall seconds for ambient animation (frozen under reduced motion). */
  t: number;
  snapshot: WorldSnapshot | null;
  /** Sim minutes per wall second (0 = paused). */
  speed: number;
  /** Accumulated stride angle shared by all walkers, and the stride amplitude. */
  walkPhase: number;
  walkAmp: number;
  tier: Tier;
  /** Screen px per cell. */
  zoom: number;
  level: TownLevel;
  sky: Sky | null;
  entered: string | null;
  /** Camera azimuth (radians; the view looks from (sin, cos) on the ground plane: π/4 = from the south-east). */
  camAz: number;
  /** Wall seconds for decorative ambient life: frozen while the world is paused or under reduced motion. */
  ambientT: number;
  /** Bumps when the snapshot object or its contents may have changed (cheap change detection). */
  version: number;
}

/** Something on screen that can be picked: its anchor in world space, refreshed every frame. */
export interface Pickable {
  ref: EntityRef;
  /** World position of its feet / base, and the height of its body (world units). */
  pos: Vector3;
  height: number;
  /** Pick radius in px at least this (small things stay clickable). */
  minPx: number;
}

export interface TownCtx {
  town: CompiledTown;
  places: TownPlaces;
  uniforms: TownUniforms;
  frame: TownFrame;
  /** Latest props the scene reads without re-rendering. */
  live: {
    selected: EntityRef | null;
    hovered: EntityRef | null;
    follow: EntityRef | null;
    reducedMotion: boolean;
    quality: QualitySettings;
    agentHouse?: ((agentId: string) => AgentHouseSource | null) | undefined;
    /** Add to World: the lots on offer (free ones glow and are pickable), or null. */
    lotPick: LotPick | null;
    /** At most this many labels. */
    labelBudget: number;
    /** Decorative ambient life is on (not paused by reduced motion or the shell). */
    ambient: boolean;
  };
  /** Residents and agents write their world positions here every frame (for picking, labels and the camera). */
  residentPos: Float32Array;
  residentVisible: Uint8Array;
  agentPos: Map<string, Vector3>;
  /** Labels of an open agent headquarters' diorama (scene/labels, anchors carried to world space). */
  dioramaLabels: ScopedLabelStore;
  /** The camera: controller, this frame's view, fog distances, the HUD's state. */
  cam: TownCamRuntime;
  /** The countryside's meshes (perf: surroundCalls). */
  surround: Set<Object3D>;
}

export const TownContext = createContext<TownCtx | null>(null);

export function useTown(): TownCtx {
  const ctx = useContext(TownContext);
  if (!ctx) throw new Error('useTown() outside <TownCanvas>');
  return ctx;
}
