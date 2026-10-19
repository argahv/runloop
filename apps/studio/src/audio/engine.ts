/**
 * The audio engine (contract §4b): one per page, created lazily.
 *
 * - No AudioContext before the first user gesture (browser autoplay policy):
 *   `unlock()` creates it, and only when sound is on. The bed fades in over 2 s.
 * - A 250 ms timer follows the camera's listener and schedules ahead on the
 *   audio clock; without a fresh listener (no town on screen) the bed is
 *   silent and the context suspends itself until the next sound.
 * - Hidden tab: master → 0 in 150 ms, `suspend()` at 300 ms, cues dropped (no
 *   burst on return); visible again: `resume()`, fade in over 600 ms.
 * - ≤ 40 persistent nodes; ≤ 12 one-shot voices (the oldest UI voice is stolen).
 * - `window.__runloopAudio` (dev and prod, read-only) reports state, layers,
 *   bus levels and the last cues for automated checks.
 */
import { Soundscape, SOUNDSCAPE_NODES, type BedLevels } from './ambient';
import { CueLimiter, type CueDecision } from './cues';
import { GRAPH_NODES, applyBuses, buildGraph, busTargets, rampTo, type AudioGraph } from './graph';
import { SILENT_MIX, ambientMix } from './mix';
import { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS, loadAudioSettings, mergeAudioSettings, saveAudioSettings, sameAudioSettings } from './settings';
import { birdVoice, cueVoice, makeBuffers, seededRng, uiVoice, whooshVoice, type Rng, type Synth, type Voice, type VoiceKind } from './synth';
import type { AudioListener, AudioSettings, AudioState, EventCue, RunloopAudio, UiSound } from './types';

export const MAX_VOICES = 12;
export const PERSISTENT_NODES = GRAPH_NODES + SOUNDSCAPE_NODES;
export const TICK_MS = 250;
/** Without a listener update for this long, the bed goes quiet (no town on screen). */
export const LISTENER_STALE_MS = 3000;
/** Quiet this long (no bed, no voices) → suspend until the next sound. */
export const IDLE_SUSPEND_MS = 5000;
const HOVER_MIN_MS = 60;
const BED_FADE_IN_S = 2;

type Timer = ReturnType<typeof setTimeout>;

/** What the engine needs from the page (a fake in tests). */
export interface EngineEnv {
  /** Web Audio exists here. */
  supported: boolean;
  createContext(): AudioContext | null;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Wall clock, ms. */
  now(): number;
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(id: Timer): void;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(id: Timer): void;
  rng?: Rng;
}

export interface CueRecord {
  cue: EventCue;
  agentId: string | null;
  /** ms, the engine's clock. */
  at: number;
  /** played / queued, or why not. */
  result: CueDecision | 'off' | 'reduced';
}

export interface UiRecord {
  sound: UiSound | 'whoosh';
  at: number;
}

export interface AudioDebug {
  state: AudioState;
  created: boolean;
  gestureSeen: boolean;
  hidden: boolean;
  idle: boolean;
  reducedMotion: boolean;
  settings: AudioSettings;
  listener: { fresh: boolean; ageMs: number; level: AudioListener['level']; zoom01: number; night: number; paused: boolean; entered: string | null; sources: number } | null;
  layers: BedLevels | null;
  /** Layers audible now. */
  active: string[];
  /** Current bus gains (linear). */
  buses: { master: number; ambient: number; ui: number; events: number } | null;
  voices: number;
  persistentNodes: number;
  cuesWaiting: number;
  lastCues: CueRecord[];
  lastUi: UiRecord[];
}

export class AudioEngine implements RunloopAudio {
  readonly limiter: CueLimiter;
  private supported: boolean;
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private scape: Soundscape | null = null;
  private synth: Synth | null = null;
  private readonly rng: Rng;
  private settings: AudioSettings;
  private readonly subscribers = new Set<() => void>();
  private gestureSeen = false;
  private hidden = false;
  private idle = false;
  private reducedMotion = false;
  private listener: AudioListener | null = null;
  private listenerAt = -Infinity;
  private exclude = new Set<string>();
  private voices: Voice[] = [];
  private timer: Timer | null = null;
  private pendingSuspend: Timer | null = null;
  private lastTick = 0;
  private quietSince: number | null = null;
  private lastHover = -Infinity;
  private cues: CueRecord[] = [];
  private uis: UiRecord[] = [];

  constructor(private readonly env: EngineEnv) {
    this.supported = env.supported;
    this.rng = env.rng ?? seededRng(Math.floor(env.now()) ^ 0x5bd1e995);
    this.settings = loadAudioSettings(env.storage);
    this.limiter = new CueLimiter(() => env.now());
  }

  get state(): AudioState {
    if (!this.supported) return 'unsupported';
    if (!this.ctx) return 'locked';
    return this.ctx.state === 'running' ? 'running' : 'suspended';
  }

  // ── Settings ──

  getSettings = (): AudioSettings => this.settings;

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  };

  update = (p: Partial<AudioSettings>): void => {
    const next = mergeAudioSettings(this.settings, p);
    if (sameAudioSettings(next, this.settings)) return;
    saveAudioSettings(next, this.env.storage);
    this.applySettings(next);
  };

  /** Another tab changed the stored settings. */
  reloadSettings(): void {
    const next = loadAudioSettings(this.env.storage);
    if (!sameAudioSettings(next, this.settings)) this.applySettings(next);
  }

  private applySettings(next: AudioSettings): void {
    const prev = this.settings;
    this.settings = next;
    if (next.enabled && !prev.enabled && this.gestureSeen) this.ensureContext();
    const { ctx, graph } = this;
    if (ctx && graph) {
      const now = ctx.currentTime;
      this.cancelSuspend();
      if (!next.enabled) {
        // Fade out, then suspend; the other buses follow the settings quietly.
        rampTo(graph.master.gain, 0, now, 0.15);
        this.suspendSoon(() => !this.settings.enabled);
        applyBuses(graph, this.targets(), now, 0.08, { master: false });
      } else {
        if (!prev.enabled) this.run();
        applyBuses(graph, this.targets(), now, prev.enabled ? 0.08 : 0.4);
      }
    }
    this.emit();
  }

  // ── Lifecycle ──

  /**
   * A user gesture: create the context when sound is on, or resume one the
   * browser suspended (autoplay, an interruption). Idempotent and cheap; it
   * leaves an idle context asleep (the next sound wakes it).
   */
  unlock = (): void => {
    this.gestureSeen = true;
    if (!this.supported || !this.settings.enabled) return;
    const fresh = !this.ctx;
    if (!this.ensureContext()) return;
    if (!fresh && this.ctx!.state !== 'running' && !this.hidden && !this.idle) this.run();
  };

  private ensureContext(): boolean {
    if (this.ctx) return true;
    if (!this.supported) return false;
    let ctx: AudioContext | null = null;
    try {
      ctx = this.env.createContext();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      this.supported = false;
      this.emit();
      return false;
    }
    this.ctx = ctx;
    const buffers = makeBuffers(ctx, this.rng);
    const graph = buildGraph(ctx, buffers);
    this.graph = graph;
    this.synth = { ctx, buffers, rng: this.rng };
    this.scape = new Soundscape(graph, this.rng, (t, species, pan, peak) => {
      this.spawn('bird', (s) => birdVoice(s, graph.birds, t, species, pan, peak));
    });
    const now = ctx.currentTime;
    this.scape.start(now);
    const tg = this.targets();
    rampTo(graph.ui.gain, tg.ui, now, 0);
    rampTo(graph.events.gain, tg.events, now, 0);
    rampTo(graph.master.gain, tg.master, now, 0.3);
    rampTo(graph.ambient.gain, tg.ambient, now, BED_FADE_IN_S);
    rampTo(graph.birdsSend.gain, tg.birdsSend, now, BED_FADE_IN_S);
    ctx.onstatechange = () => this.emit();
    this.lastTick = now;
    if (ctx.state !== 'running' && !this.hidden) void ctx.resume().catch(() => undefined);
    this.startTimer();
    this.emit();
    return true;
  }

  /** Resume and tick (sound on, tab visible). */
  private run(): void {
    const ctx = this.ctx;
    if (!ctx || !this.settings.enabled || this.hidden) return;
    this.idle = false;
    this.quietSince = null;
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    this.startTimer();
  }

  private suspendSoon(still: () => boolean): void {
    this.cancelSuspend();
    this.pendingSuspend = this.env.setTimeout(() => {
      this.pendingSuspend = null;
      if (!still() || !this.ctx) return;
      this.stopTimer();
      void this.ctx.suspend().catch(() => undefined);
    }, 300);
  }

  private cancelSuspend(): void {
    if (this.pendingSuspend) this.env.clearTimeout(this.pendingSuspend);
    this.pendingSuspend = null;
  }

  private startTimer(): void {
    this.timer ??= this.env.setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer) this.env.clearInterval(this.timer);
    this.timer = null;
  }

  /** The page was hidden or shown. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.limiter.setHidden(hidden);
    const { ctx, graph } = this;
    if (ctx && graph) {
      if (hidden) {
        rampTo(graph.master.gain, 0, ctx.currentTime, 0.15);
        this.suspendSoon(() => this.hidden);
      } else if (this.settings.enabled) {
        this.cancelSuspend();
        this.run();
        rampTo(graph.master.gain, this.targets().master, ctx.currentTime, 0.6);
      }
    }
    this.emit();
  }

  /** One scheduling step (the timer calls it; renders and tests may too). */
  tick(): void {
    const { ctx, graph, scape } = this;
    if (!ctx || !graph || !scape) return;
    const now = ctx.currentTime;
    const dt = now - this.lastTick;
    this.lastTick = now;
    const fresh = this.listenerFresh();
    const mix = fresh ? ambientMix(this.listener, { reduce: this.settings.reduce, exclude: this.exclude }) : SILENT_MIX;
    const wasInside = scape.inside;
    scape.update(now, mix, dt);
    if (scape.inside !== wasInside) rampTo(graph.birdsSend.gain, this.targets().birdsSend, now, 0.3);
    for (const c of this.limiter.due()) this.playCue(c.cue, c.pan);
    this.voices = this.voices.filter((v) => v.end > now);
    // Nothing to hear (no town on screen, no voices): suspend until the next sound.
    const quiet = !fresh && this.voices.length === 0 && this.limiter.waiting === 0;
    const wall = this.env.now();
    if (!quiet) this.quietSince = null;
    else if (this.quietSince === null) this.quietSince = wall;
    else if (wall - this.quietSince > IDLE_SUSPEND_MS && ctx.state === 'running') {
      this.idle = true;
      this.stopTimer();
      void ctx.suspend().catch(() => undefined);
    }
  }

  private wake(): void {
    if (this.idle) this.run();
  }

  private listenerFresh(): boolean {
    return this.listener !== null && this.env.now() - this.listenerAt < LISTENER_STALE_MS;
  }

  private targets() {
    return busTargets(this.settings, { audible: !this.hidden, interior: this.scape?.inside ?? false });
  }

  private canPlay(): boolean {
    return !!this.ctx && !!this.graph && this.settings.enabled && !this.hidden;
  }

  // ── Voices ──

  /** Start a one-shot voice; at the cap, steal the oldest UI voice (then a bird call; events only for events). */
  private spawn(kind: VoiceKind, build: (s: Synth) => Voice): boolean {
    const { ctx, synth } = this;
    if (!ctx || !synth) return false;
    const now = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > now);
    if (this.voices.length >= MAX_VOICES) {
      const victim = this.voices.find((v) => v.kind === 'ui') ?? this.voices.find((v) => v.kind === 'bird') ?? (kind === 'event' ? this.voices.find((v) => v.kind === 'event') : undefined);
      if (!victim) return false;
      victim.out.gain.cancelScheduledValues(now);
      victim.out.gain.setTargetAtTime(0, now, 0.01);
      for (const s of victim.sources) {
        try {
          s.stop(now + 0.06);
        } catch {
          // already stopped
        }
      }
      this.voices.splice(this.voices.indexOf(victim), 1);
    }
    this.voices.push(build(synth));
    return true;
  }

  ui = (sound: UiSound): void => {
    if (!this.canPlay() || this.settings.ui <= 0) return;
    if (sound === 'hover') {
      if (this.settings.reduce) return;
      const t = this.env.now();
      if (t - this.lastHover < HOVER_MIN_MS) return;
      this.lastHover = t;
    }
    this.wake();
    const graph = this.graph!;
    const t0 = this.ctx!.currentTime + 0.005;
    if (this.spawn('ui', (s) => uiVoice(s, graph.ui, t0, sound))) this.recordUi(sound);
  };

  whoosh = (durationMs: number, pan = 0): void => {
    if (this.reducedMotion || !this.canPlay() || this.settings.ui <= 0 || !(durationMs > 0)) return;
    this.wake();
    const graph = this.graph!;
    const t0 = this.ctx!.currentTime + 0.01;
    const p = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    if (this.spawn('ui', (s) => whooshVoice(s, graph.ui, t0, durationMs / 1000, p))) this.recordUi('whoosh');
  };

  cue = (cue: EventCue, opts: { agentId?: string; pan?: number } = {}): boolean => {
    const agentId = opts.agentId ?? null;
    const pan = Number.isFinite(opts.pan) ? Math.max(-1, Math.min(1, opts.pan!)) : 0;
    if (!this.ctx || !this.settings.enabled || this.settings.events <= 0) return this.recordCue(cue, agentId, 'off');
    if (this.settings.reduce && cue === 'agentLive') return this.recordCue(cue, agentId, 'reduced');
    const d = this.limiter.offer(cue, agentId, pan);
    this.recordCue(cue, agentId, d);
    if (d === 'play') this.playCue(cue, pan);
    return d === 'play' || d === 'queued';
  };

  private playCue(cue: EventCue, pan: number): void {
    if (!this.canPlay()) return;
    this.wake();
    const graph = this.graph!;
    const t0 = this.ctx!.currentTime + 0.01;
    this.spawn('event', (s) => cueVoice(s, graph.events, t0, cue, pan));
  }

  /** The settings' Preview buttons (a user action; not an event cue, so no pacing). */
  preview(what: 'ui' | 'events' | 'ambient'): void {
    this.unlock();
    if (!this.canPlay()) return;
    this.wake();
    const graph = this.graph!;
    const t0 = this.ctx!.currentTime + 0.01;
    if (what === 'ui') this.spawn('ui', (s) => uiVoice(s, graph.ui, t0, 'confirm'));
    else if (what === 'events') this.spawn('event', (s) => cueVoice(s, graph.events, t0, 'taskDone'));
  }

  /** One cue as a preview (the sound board; a user action, not an event). */
  previewCue(cue: EventCue): void {
    this.unlock();
    if (!this.canPlay()) return;
    this.wake();
    const graph = this.graph!;
    const t0 = this.ctx!.currentTime + 0.01;
    this.spawn('event', (s) => cueVoice(s, graph.events, t0, cue));
  }

  // ── World ──

  setListener = (l: AudioListener): void => {
    this.listener = l;
    this.listenerAt = this.env.now();
    this.wake();
  };

  setReducedMotion = (v: boolean): void => {
    this.reducedMotion = v;
  };

  /** Places that may never murmur (agent buildings and lots). */
  setExcluded(ids: Iterable<string>): void {
    this.exclude = new Set(ids);
  }

  /** No cues for `ms` (after a resync or reconnect). */
  suppressCues(ms: number): void {
    this.limiter.suppressFor(ms);
  }

  // ── Debug ──

  private recordCue(cue: EventCue, agentId: string | null, result: CueRecord['result']): false {
    this.cues.push({ cue, agentId, at: Math.round(this.env.now()), result });
    if (this.cues.length > 20) this.cues.shift();
    return false;
  }

  private recordUi(sound: UiRecord['sound']): void {
    this.uis.push({ sound, at: Math.round(this.env.now()) });
    if (this.uis.length > 20) this.uis.shift();
  }

  debug(): AudioDebug {
    const l = this.listener;
    const layers = this.scape?.levels ?? null;
    const g = this.graph;
    const r = (v: number) => Math.round(v * 10000) / 10000;
    return {
      state: this.state,
      created: this.ctx !== null,
      gestureSeen: this.gestureSeen,
      hidden: this.hidden,
      idle: this.idle,
      reducedMotion: this.reducedMotion,
      settings: { ...this.settings },
      listener: l
        ? { fresh: this.listenerFresh(), ageMs: Math.round(this.env.now() - this.listenerAt), level: l.level, zoom01: l.zoom01, night: l.night, paused: l.paused, entered: l.entered, sources: l.sources.length }
        : null,
      layers,
      active: layers ? (['breeze', 'wind', 'birds', 'crickets', 'murmur', 'water', 'traffic', 'room'] as const).filter((k) => layers[k] > 0.01) : [],
      buses: g ? { master: r(g.master.gain.value), ambient: r(g.ambient.gain.value), ui: r(g.ui.gain.value), events: r(g.events.gain.value) } : null,
      voices: this.voices.length,
      persistentNodes: this.ctx ? PERSISTENT_NODES : 0,
      cuesWaiting: this.limiter.waiting,
      lastCues: this.cues.slice(-10),
      lastUi: this.uis.slice(-10),
    };
  }

  private emit(): void {
    for (const fn of [...this.subscribers]) fn();
  }
}

// ── The page's engine ────────────────────────────────────────────────

/** Server rendering and browsers without Web Audio: everything is a no-op. */
const SILENT: RunloopAudio = Object.freeze({
  state: 'unsupported' as const,
  unlock: () => undefined,
  ui: () => undefined,
  whoosh: () => undefined,
  cue: () => false,
  setListener: () => undefined,
  setReducedMotion: () => undefined,
  getSettings: () => DEFAULT_AUDIO_SETTINGS,
  update: () => undefined,
  subscribe: () => () => undefined,
});

let engine: AudioEngine | null = null;

function browserEnv(): EngineEnv {
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = typeof AudioContext === 'function' ? AudioContext : w.webkitAudioContext;
  let storage: Storage | null = null;
  try {
    storage = w.localStorage;
  } catch {
    storage = null;
  }
  return {
    supported: typeof Ctor === 'function',
    createContext: () => (Ctor ? new Ctor({ latencyHint: 'interactive' }) : null),
    storage,
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

/**
 * Gestures unlock sound (and resume it after the browser suspends it); the
 * tab's visibility suspends it; other tabs' settings apply here.
 */
export function installPageHooks(e: AudioEngine, w: Window, d: Document): void {
  const gestures = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;
  const onGesture = (ev: Event) => {
    if (e.state === 'running' || e.state === 'unsupported') return;
    const target = ev.target as { closest?: (s: string) => unknown } | null;
    // The speaker toggle handles its own click (so a first click on it mutes rather than starts sound).
    if (target && typeof target.closest === 'function' && target.closest('[data-audio-toggle]')) return;
    e.unlock();
  };
  for (const g of gestures) w.addEventListener(g, onGesture, { capture: true, passive: true });
  e.setHidden(d.visibilityState === 'hidden');
  d.addEventListener('visibilitychange', () => e.setHidden(d.visibilityState === 'hidden'));
  w.addEventListener('storage', (ev) => {
    if (ev.key === AUDIO_SETTINGS_KEY) e.reloadSettings();
  });
  Object.defineProperty(w, '__runloopAudio', { configurable: true, get: () => e.debug() });
}

/** The page's engine (null on the server). */
export function getAudioEngine(): AudioEngine | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (!engine) {
    engine = new AudioEngine(browserEnv());
    installPageHooks(engine, window, document);
  }
  return engine;
}

/** The soundscape (a singleton; SSR-safe no-op on the server). */
export function getAudio(): RunloopAudio {
  return getAudioEngine() ?? SILENT;
}
