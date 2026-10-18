import { describe, expect, it } from 'vitest';
import { AudioEngine, IDLE_SUSPEND_MS, LISTENER_STALE_MS, MAX_VOICES, PERSISTENT_NODES, installPageHooks } from './engine';
import { MASTER_HEADROOM } from './graph';
import { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS } from './settings';
import { fakeEnv, type FakeAudioContext, type FakeEnv } from './testing';
import type { AudioListener } from './types';

const listener = (p: Partial<AudioListener> = {}): AudioListener => ({
  x: 48,
  z: 36,
  zoom01: 0.8,
  az: 45,
  entered: null,
  level: 'street',
  minute: 13 * 60,
  night: 0,
  paused: false,
  sources: [
    { kind: 'murmur', id: 'spot_cafe_patio', gain: 0.8, pan: -0.3 },
    { kind: 'green', id: 'park_commons', gain: 0.7, pan: 0.4 },
    { kind: 'water', id: 'lm_fountain', gain: 0.6, pan: 0 },
    { kind: 'road', id: 'brook_road', gain: 0.5, pan: 0.6 },
  ],
  ...p,
});

function setup(opts: Parameters<typeof fakeEnv>[0] = {}) {
  const env = fakeEnv(opts);
  const audio = new AudioEngine(env);
  const ctx = () => env.contexts[0] as FakeAudioContext | undefined;
  /** Feed the listener for `ms` (as the town does, ~4 Hz) while time passes. */
  const live = (ms: number, l: AudioListener = listener()) => {
    for (let t = 0; t < ms; t += 250) {
      audio.setListener(l);
      env.advance(250);
    }
  };
  return { env, audio, ctx, live };
}

describe('AudioEngine: autoplay and lifecycle (S1)', () => {
  it('creates no AudioContext before the first gesture; nothing plays, nothing throws', () => {
    const { env, audio } = setup();
    expect(audio.state).toBe('locked');
    audio.setListener(listener());
    audio.ui('select');
    audio.whoosh(500, 0.5);
    expect(audio.cue('needsApproval', { agentId: 'agt_1' })).toBe(false);
    env.advance(2000);
    expect(env.contexts).toHaveLength(0);
    expect(audio.debug()).toMatchObject({ created: false, voices: 0, persistentNodes: 0 });
    expect(audio.debug().lastCues.at(-1)?.result).toBe('off');
  });

  it('the first gesture creates one context (idempotent), ≤ 40 persistent nodes, and the bed fades in over 2 s', () => {
    const { env, audio, ctx } = setup();
    audio.unlock();
    audio.unlock();
    expect(env.contexts).toHaveLength(1);
    expect(audio.state).toBe('running');
    expect(ctx()!.nodes).toHaveLength(PERSISTENT_NODES);
    expect(PERSISTENT_NODES).toBeLessThanOrEqual(40);
    // The ambient bus ramps from 0 to its volume (0.5² = 0.25) over 2 s.
    const fade = ctx()!.params.flatMap((p) => p.events).find((e) => e.type === 'linear' && Math.abs(e.v - 0.25) < 1e-9);
    expect(fade?.t).toBeCloseTo(2);
    expect(audio.debug().buses).toMatchObject({ ambient: 0.25, ui: 0.16, events: 0.49 });
    expect(audio.debug().buses!.master).toBeCloseTo(MASTER_HEADROOM * 0.36, 3);
  });

  it('a gesture with sound off creates nothing; turning it on later (a click) starts it', () => {
    const { env, audio } = setup({ stored: { enabled: false } });
    audio.unlock();
    expect(env.contexts).toHaveLength(0);
    audio.update({ enabled: true });
    expect(env.contexts).toHaveLength(1);
    expect(audio.state).toBe('running');
  });

  it('unsupported browsers (no Web Audio) stay silent no-ops', () => {
    const { env, audio } = setup({ supported: false });
    audio.unlock();
    audio.ui('open');
    expect(audio.cue('incident')).toBe(false);
    expect(audio.state).toBe('unsupported');
    expect(env.contexts).toHaveLength(0);
  });

  it('a hidden tab fades the master to 0 in 150 ms and suspends at 300 ms; showing it resumes and fades in', () => {
    const { env, audio, ctx } = setup();
    audio.unlock();
    audio.setHidden(true);
    const master = () => audio.debug().buses!.master;
    expect(master()).toBe(0);
    const ramp = ctx()!.params.flatMap((p) => p.events).filter((e) => e.type === 'linear' && e.v === 0).at(-1);
    expect(ramp?.t).toBeCloseTo(ctx()!.currentTime + 0.15);
    env.advance(299);
    expect(ctx()!.state).toBe('running');
    env.advance(2);
    expect(ctx()!.state).toBe('suspended');
    expect(audio.state).toBe('suspended');
    // Hidden: cues are dropped, not saved for later.
    expect(audio.cue('needsApproval', { agentId: 'agt_1' })).toBe(false);
    expect(audio.debug().lastCues.at(-1)?.result).toBe('hidden');
    audio.setHidden(false);
    expect(ctx()!.state).toBe('running');
    expect(master()).toBeCloseTo(MASTER_HEADROOM * 0.36, 3);
    expect(audio.debug().cuesWaiting).toBe(0);
  });

  it('mute fades out and suspends; unmute resumes', () => {
    const { env, audio, ctx } = setup();
    audio.unlock();
    const masterEvents = () => ctx()!.params.find((p) => p.events.some((e) => e.type === 'linear' && Math.abs(e.v - MASTER_HEADROOM * 0.36) < 1e-9))!.events;
    const before = masterEvents().length;
    audio.update({ enabled: false });
    expect(audio.debug().buses!.master).toBe(0);
    // One 150 ms fade to 0, not overridden by the other buses' update.
    const fades = masterEvents().slice(before).filter((e) => e.type === 'linear');
    expect(fades).toEqual([{ type: 'linear', v: 0, t: expect.closeTo(ctx()!.currentTime + 0.15, 5) }]);
    env.advance(400);
    expect(ctx()!.state).toBe('suspended');
    audio.ui('select');
    expect(audio.debug().voices).toBe(0);
    audio.update({ enabled: true });
    expect(ctx()!.state).toBe('running');
    expect(audio.debug().buses!.master).toBeCloseTo(MASTER_HEADROOM * 0.36, 3);
  });
});

describe('AudioEngine: settings (S4)', () => {
  it('persists each change in runloop.audio.v1, applies it to the buses and notifies subscribers', () => {
    const { env, audio } = setup();
    audio.unlock();
    let calls = 0;
    const off = audio.subscribe(() => calls++);
    audio.update({ master: 0.5, ui: 1 });
    expect(JSON.parse(env.store.get(AUDIO_SETTINGS_KEY)!)).toEqual({ ...DEFAULT_AUDIO_SETTINGS, master: 0.5, ui: 1 });
    expect(audio.debug().buses).toMatchObject({ ui: 1 });
    expect(audio.debug().buses!.master).toBeCloseTo(MASTER_HEADROOM * 0.25, 3);
    audio.update({ master: 0.5 }); // no change, no notification
    audio.update({ reduce: true });
    expect(audio.debug().buses).toMatchObject({ ambient: 0, ui: 0.5 });
    expect(calls).toBe(2);
    off();
    audio.update({ events: 0 });
    expect(calls).toBe(2);
    expect(audio.getSettings().events).toBe(0);
    // A new page reads them back.
    const again = new AudioEngine({ ...env, contexts: [] } as FakeEnv);
    expect(again.getSettings()).toEqual(audio.getSettings());
  });

  it('reduce sound: no ambient layers, no hover, no agentLive cue; the other cues still play', () => {
    const { audio, live } = setup({ stored: { reduce: true } });
    audio.unlock();
    live(3000);
    expect(audio.debug().active).toEqual([]);
    audio.ui('hover');
    expect(audio.debug().voices).toBe(0);
    expect(audio.cue('agentLive', { agentId: 'agt_1' })).toBe(false);
    expect(audio.debug().lastCues.at(-1)?.result).toBe('reduced');
    expect(audio.cue('needsApproval', { agentId: 'agt_1' })).toBe(true);
  });
});

describe('AudioEngine: voices and UI sounds', () => {
  it('caps one-shot voices at 12, stealing the oldest UI voice; a cue still gets through', () => {
    const { audio } = setup();
    audio.unlock();
    for (let i = 0; i < 20; i++) audio.ui('select');
    expect(audio.debug().voices).toBe(MAX_VOICES);
    expect(audio.cue('incident', { agentId: 'agt_1' })).toBe(true);
    expect(audio.debug().voices).toBe(MAX_VOICES);
  });

  it('hover ticks at most every 60 ms', () => {
    const { env, audio } = setup();
    audio.unlock();
    audio.ui('hover');
    audio.ui('hover');
    env.clock.ms += 30;
    audio.ui('hover');
    env.clock.ms += 40;
    audio.ui('hover');
    expect(audio.debug().lastUi.filter((u) => u.sound === 'hover')).toHaveLength(2);
  });

  it('no whoosh under reduced motion', () => {
    const { audio } = setup();
    audio.unlock();
    audio.setReducedMotion(true);
    audio.whoosh(600, 0.4);
    expect(audio.debug().voices).toBe(0);
    audio.setReducedMotion(false);
    audio.whoosh(600, 0.4);
    expect(audio.debug().lastUi.at(-1)?.sound).toBe('whoosh');
  });

  it('cues are paced by the limiter (cooldown per agent and cue)', () => {
    const { env, audio } = setup();
    audio.unlock();
    expect(audio.cue('taskDone', { agentId: 'agt_1' })).toBe(true);
    env.advance(2000);
    expect(audio.cue('taskDone', { agentId: 'agt_1' })).toBe(false);
    expect(audio.debug().lastCues.at(-1)?.result).toBe('cooldown');
    expect(audio.cue('taskDone', { agentId: 'agt_2' })).toBe(true);
    // Within the 1.2 s spacing: queued, then played by the timer.
    expect(audio.cue('incident', { agentId: 'agt_2' })).toBe(true);
    expect(audio.debug().cuesWaiting).toBe(1);
    env.advance(1500);
    expect(audio.debug().cuesWaiting).toBe(0);
  });
});

describe('AudioEngine: the ambient bed follows the camera', () => {
  it('a daytime street view near the café: breeze, birds, murmur, water, traffic', () => {
    const { audio, live } = setup();
    audio.unlock();
    live(4000);
    const d = audio.debug();
    expect(d.active).toEqual(expect.arrayContaining(['breeze', 'birds', 'murmur', 'water', 'traffic']));
    expect(d.active).not.toContain('crickets');
    expect(d.layers!.murmur).toBeGreaterThan(0.5);
    expect(d.listener).toMatchObject({ fresh: true, level: 'street' });
  });

  it('night brings crickets instead of birds; a paused world fades its life in ~1.5 s and keeps half the breeze', () => {
    const { audio, live } = setup();
    audio.unlock();
    live(4000, listener({ night: 1 }));
    expect(audio.debug().active).toContain('crickets');
    expect(audio.debug().layers!.birds).toBe(0);
    const breeze = audio.debug().layers!.breeze;
    live(2000, listener({ night: 1, paused: true }));
    const p = audio.debug().layers!;
    expect(p.crickets).toBeLessThan(0.05);
    expect(p.murmur).toBeLessThan(0.05);
    expect(p.traffic).toBeLessThan(0.02);
    expect(p.breeze).toBeCloseTo(breeze / 2, 1);
  });

  it('inside a building: interior bed and room tone', () => {
    const { audio, live } = setup();
    audio.unlock();
    live(2000, listener({ entered: 'bld_corner_cafe', level: 'interior' }));
    expect(audio.debug().layers).toMatchObject({ interior: true });
    expect(audio.debug().active).toContain('room');
  });

  it('agent buildings and lots never murmur', () => {
    const { audio, live } = setup();
    audio.unlock();
    audio.setExcluded(['bld_agent_hq_1', 'lot_agent_1']);
    live(3000, listener({ sources: [{ kind: 'murmur', id: 'bld_agent_hq_1', gain: 1, pan: 0 }] }));
    expect(audio.debug().layers!.murmur).toBe(0);
  });

  it('without the town on screen the bed goes quiet, then the context idles until the next sound', () => {
    const { env, audio, ctx, live } = setup();
    audio.unlock();
    live(3000);
    env.advance(LISTENER_STALE_MS + 3000);
    expect(audio.debug().active).toEqual([]);
    env.advance(IDLE_SUSPEND_MS + 500);
    expect(audio.debug().idle).toBe(true);
    expect(ctx()!.state).toBe('suspended');
    audio.ui('open');
    expect(ctx()!.state).toBe('running');
    expect(audio.debug().voices).toBe(1);
  });

  it('birds are one-shot calls within the voice cap; nothing piles up over a long day', () => {
    const { audio, live, ctx } = setup();
    audio.unlock();
    live(60_000, listener({ zoom01: 1, sources: [{ kind: 'green', id: 'park', gain: 1, pan: 0 }] }));
    expect(audio.debug().voices).toBeLessThanOrEqual(MAX_VOICES);
    const t = ctx()!.currentTime;
    // Persistent sources (3 noise loops, the breeze LFO, the cricket oscillator) + a few voices at most.
    expect(ctx()!.sourcesPlayingAt(t).length).toBeLessThanOrEqual(5 + 3 * MAX_VOICES);
  });
});

describe('page hooks', () => {
  function page(hidden = false) {
    const handlers = new Map<string, Set<(e: Event) => void>>();
    const target = {
      addEventListener: (type: string, fn: (e: Event) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => handlers.get(type)?.delete(fn),
    };
    const fire = (type: string, ev: Partial<Event> = {}) => {
      for (const fn of [...(handlers.get(type) ?? [])]) fn({ type, target: null, ...ev } as Event);
    };
    const w = { ...target } as unknown as Window;
    const docHandlers = new Map<string, () => void>();
    const d = { visibilityState: hidden ? 'hidden' : 'visible', addEventListener: (t: string, fn: () => void) => docHandlers.set(t, fn) } as unknown as Document & { visibilityState: string };
    return { w, d, fire, handlers, docHandlers };
  }

  it('the first gesture unlocks (but not a click on the speaker toggle), later ones resume; visibility suspends; __runloopAudio reports', () => {
    const env = fakeEnv();
    const audio = new AudioEngine(env);
    const p = page();
    installPageHooks(audio, p.w, p.d);
    const toggle = { closest: (s: string) => (s === '[data-audio-toggle]' ? toggle : null) };
    p.fire('pointerdown', { target: toggle as unknown as EventTarget });
    expect(env.contexts).toHaveLength(0);
    p.fire('keydown');
    expect(env.contexts).toHaveLength(1);
    // The browser suspends it (an interruption): the next gesture resumes it.
    void (env.contexts[0] as FakeAudioContext).suspend();
    expect(audio.state).toBe('suspended');
    p.fire('pointerup');
    expect(audio.state).toBe('running');
    expect(env.contexts).toHaveLength(1);
    (p.d as { visibilityState: string }).visibilityState = 'hidden';
    p.docHandlers.get('visibilitychange')!();
    expect((p.w as unknown as { __runloopAudio: { hidden: boolean } }).__runloopAudio.hidden).toBe(true);
    const dbg = (p.w as unknown as { __runloopAudio: ReturnType<AudioEngine['debug']> }).__runloopAudio;
    expect(dbg).toMatchObject({ created: true, persistentNodes: PERSISTENT_NODES });
  });
});
