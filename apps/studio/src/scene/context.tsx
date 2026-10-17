'use client';
import type { Incident } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import type { RunState } from '@runloop-world/replay';
import { matchActivityRule, presentationAt, type CharacterPose, type CompiledWorld } from '@runloop-world/world-engine';
import { createContext, useContext } from 'react';
import type { LabelStore } from './labels';
import { incidentStationId } from './layout';
import type { ScenePalette } from './palette';
import type { SceneFrame } from './types';

/** A camera move requested from outside the canvas (the camera rail, selection). */
export type CameraRequest =
  | { kind: 'overview' }
  | { kind: 'focusAgent'; agentId: string }
  | { kind: 'focusStation'; stationId: string };

/** Tiny bus between DOM controls and the camera rig inside the canvas. */
export class CameraBus {
  private handler: ((r: CameraRequest) => void) | null = null;
  /** True while the camera shows the whole board (no pan/zoom/focus since). */
  overview = true;
  private listeners = new Set<() => void>();
  listen(fn: (r: CameraRequest) => void) {
    this.handler = fn;
    return () => {
      if (this.handler === fn) this.handler = null;
    };
  }
  request(r: CameraRequest) {
    this.handler?.(r);
  }
  setOverview(on: boolean) {
    if (this.overview === on) return;
    this.overview = on;
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getOverview = () => this.overview;
}

/** Shared, rarely-changing inputs for scene components (per-frame data comes from getFrame()). */
export interface SceneCtx {
  world: CompiledWorld;
  getFrame: () => SceneFrame;
  subscribeEffects: (fn: (events: readonly AnyEvent[]) => void) => () => void;
  reducedMotion: boolean;
  /** Remembers which station each incident happened at (see incidentStationId). */
  incidentStations: Map<string, string>;
  /** DOM labels drawn over the canvas. */
  labels: LabelStore;
  /** Colours from the design tokens (follows the theme). */
  palette: ScenePalette;
  camera: CameraBus;
  /** Select an event in the shell (stable; a no-op when the shell does not support it). */
  selectEvent: (seq: number, opts: { seek: boolean }) => void;
}

export const SceneContext = createContext<SceneCtx | null>(null);

export function useScene(): SceneCtx {
  const ctx = useContext(SceneContext);
  if (!ctx) throw new Error('useScene() outside <WorldCanvas>');
  return ctx;
}

/** Layer-2 pose of a character at the frame's tick (null when it has no character). */
export function poseAt(world: CompiledWorld, frame: SceneFrame, agentId: string): CharacterPose | null {
  const c = frame.state.world.characters[agentId];
  if (!c) return null;
  return presentationAt(c, frame.tick, world, { paused: frame.state.world.paused });
}

export interface StationStatus {
  /** Agent standing in a slot of this station (first occupied slot). */
  occupant: string | null;
  /** Occupant has a tool call in flight (Layer 1): the station is executing. */
  busy: boolean;
  /** Occupant is waiting for a permission (the gate). */
  awaiting: boolean;
  /** Open (unresolved) incidents placed at this station. */
  openIncidents: Incident[];
  resolvedIncidents: Incident[];
}

const statusCache = new WeakMap<RunState, Map<string, StationStatus>>();

/**
 * Per-station status derived from one RunState. Cached per state object
 * (ReplayIndex returns the same object for the same sequence), so it is
 * computed once per playhead step, not once per frame.
 */
export function stationStatuses(ctx: Pick<SceneCtx, 'world' | 'incidentStations'>, state: RunState): Map<string, StationStatus> {
  const hit = statusCache.get(state);
  if (hit) return hit;
  const out = new Map<string, StationStatus>();
  for (const s of ctx.world.def.stations) {
    const ws = state.world.stations[s.id];
    const occupant = ws?.slots.find((a): a is string => a !== null) ?? null;
    const agent = occupant ? state.exec.agents[occupant] : undefined;
    const call = agent?.activeCallId ? state.exec.toolCalls.get(agent.activeCallId) : undefined;
    const perm = agent?.pendingPermissionId ? state.exec.permissions[agent.pendingPermissionId] : undefined;
    // A running call lights the station it belongs to (a delegate call, say, does not light the library).
    const callKind = call?.category
      ? matchActivityRule(ctx.world.def.activityRules, { taskKind: null, toolCategory: call.category, permission: false })
      : s.kind;
    out.set(s.id, {
      occupant,
      busy: call?.status === 'running' && callKind === s.kind,
      awaiting: perm?.status === 'pending',
      openIncidents: [],
      resolvedIncidents: [],
    });
  }
  for (const inc of state.exec.incidents) {
    if (inc.kind === 'run_failed') continue;
    const id = incidentStationId(ctx.world, state, inc, ctx.incidentStations);
    const st = id ? out.get(id) : undefined;
    if (!st) continue;
    (inc.resolvedSeq === null ? st.openIncidents : st.resolvedIncidents).push(inc);
  }
  statusCache.set(state, out);
  return out;
}
