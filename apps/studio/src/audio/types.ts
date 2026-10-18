/**
 * The soundscape's public types (contract §4b). Plain types only: the town
 * renderer reports a `TownListener` of the same shape and never imports audio.
 */
import type { AgentAttention, ConnectionHealth } from '@runloop-world/events';

export type UiSound = 'hover' | 'select' | 'open' | 'close' | 'menu' | 'confirm' | 'error' | 'toggle';
export const UI_SOUNDS: readonly UiSound[] = ['hover', 'select', 'open', 'close', 'menu', 'confirm', 'error', 'toggle'];

/** Sounds for real agent events only (never for simulated activity). */
export type EventCue = 'agentLive' | 'incident' | 'taskDone' | 'needsApproval';
export const EVENT_CUES: readonly EventCue[] = ['agentLive', 'incident', 'taskDone', 'needsApproval'];

/** Per-viewer sound settings (localStorage `runloop.audio.v1`). Volumes are 0…1. */
export interface AudioSettings {
  /** Sound on (the HUD speaker toggle; off = mute). */
  enabled: boolean;
  master: number;
  ambient: number;
  ui: number;
  events: number;
  /** Reduce sound: no ambient bed, no hover ticks, UI −6 dB, only the needs-approval, incident and task-done cues. */
  reduce: boolean;
}

export type AudioSourceKind = 'murmur' | 'water' | 'green' | 'road' | 'field';

/** What the soundscape hears, about four times a second (the town's `onListener`). */
export interface AudioListener {
  /** Camera target in town cells. */
  x: number;
  z: number;
  /** 0 = the whole town … 1 = street level and closer. */
  zoom01: number;
  /** Degrees. */
  az: number;
  entered: string | null;
  level: 'town' | 'district' | 'street' | 'interior';
  /** Minute of day (fractional). */
  minute: number;
  /** 0 = day … 1 = night. */
  night: number;
  /** The world clock is paused. */
  paused: boolean;
  /** Nearby sources with a gain (nearness, 0…1) and a pan (−1 left … 1 right). Murmur = simulated occupancy only. */
  sources: { kind: AudioSourceKind; id: string; gain: number; pan: number }[];
}

export type AudioState = 'locked' | 'running' | 'suspended' | 'unsupported';

export interface RunloopAudio {
  /** locked = no AudioContext yet (before the first gesture); unsupported = SSR or no Web Audio. */
  readonly state: AudioState;
  /** From a user gesture; idempotent. Creates the AudioContext only when sound is enabled. */
  unlock(): void;
  ui(sound: UiSound): void;
  /** A camera move's whoosh (not for cuts; never under reduced motion). `pan` −1…1 sweeps from −pan to +pan. */
  whoosh(durationMs: number, pan?: number): void;
  /** A real agent event's cue. false = not played (limited, disabled, locked or hidden). */
  cue(cue: EventCue, opts?: { agentId?: string; pan?: number }): boolean;
  setListener(l: AudioListener): void;
  setReducedMotion(v: boolean): void;
  getSettings(): AudioSettings;
  update(p: Partial<AudioSettings>): void;
  /** Called when settings or state change. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

/** The tracker's view of one agent, before an event changes it. */
export interface AgentAudioState {
  health: ConnectionHealth;
  attention: AgentAttention;
  openIncidents: number;
}
