/**
 * Offline renders (browser only): every sound and a few ambient scenes are
 * rendered with an OfflineAudioContext through the real graph, soundscape and
 * voices, then measured (peak and RMS). `check/render-check.mjs` runs this in
 * headless Chromium and fails when a sound is silent, clips (peak ≥ 0.9), or
 * the bed is not quiet, or when a setting does not change the output.
 */
import { LOOKAHEAD, Soundscape } from './ambient';
import { buildGraph, busTargets, rampTo, type AudioGraph } from './graph';
import { SILENT_MIX, ambientMix, type AmbientMix } from './mix';
import { DEFAULT_AUDIO_SETTINGS } from './settings';
import { birdVoice, cueVoice, makeBuffers, seededRng, uiVoice, whooshVoice, type Synth } from './synth';
import { EVENT_CUES, UI_SOUNDS, type AudioListener, type AudioSettings, type EventCue, type UiSound } from './types';

export const SAMPLE_RATE = 48000;
export const CLIP = 0.9;

export interface Measure {
  name: string;
  peak: number;
  rms: number;
  peakDb: number;
  rmsDb: number;
}

const db = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity);

function measure(name: string, buf: AudioBuffer, from = 0, to = buf.duration): Measure {
  let peak = 0;
  let sum = 0;
  let n = 0;
  const a = Math.floor(from * buf.sampleRate);
  const b = Math.min(buf.length, Math.floor(to * buf.sampleRate));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(d[i]!));
    for (let i = a; i < b; i++) {
      sum += d[i]! * d[i]!;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return { name, peak, rms, peakDb: db(peak), rmsDb: db(rms) };
}

interface Scene {
  ctx: OfflineAudioContext;
  graph: AudioGraph;
  synth: Synth;
}

async function render(seconds: number, settings: AudioSettings, play: (s: Scene) => void, opts: { interior?: boolean; seed?: number } = {}): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const rng = seededRng(opts.seed ?? 42);
  const buffers = makeBuffers(ctx, rng);
  const graph = buildGraph(ctx, buffers);
  const tg = busTargets(settings, { audible: true, interior: opts.interior ?? false });
  rampTo(graph.master.gain, tg.master, 0, 0);
  rampTo(graph.ambient.gain, tg.ambient, 0, 0);
  rampTo(graph.birdsSend.gain, tg.birdsSend, 0, 0);
  rampTo(graph.ui.gain, tg.ui, 0, 0);
  rampTo(graph.events.gain, tg.events, 0, 0);
  play({ ctx, graph, synth: { ctx, buffers, rng } });
  return ctx.startRendering();
}

/** Run the soundscape for `seconds` of a listener (its timer, pumped ahead of the render). */
function bed(s: Scene, listener: AudioListener, seconds: number, settings: AudioSettings, only?: (m: AmbientMix) => AmbientMix): Soundscape {
  const scape = new Soundscape(s.graph, s.synth.rng, (t, species, pan, peak) => {
    birdVoice(s.synth, s.graph.birds, t, species, pan, peak);
  });
  scape.start(0);
  const full = ambientMix(listener, { reduce: settings.reduce });
  const mix = only ? only(full) : full;
  let last = 0;
  for (let now = 0; now < seconds - LOOKAHEAD; now += 0.25) {
    scape.update(now, mix, now - last);
    last = now;
  }
  return scape;
}

export const SCENES: Record<string, AudioListener> = {
  'town · day': {
    x: 48, z: 36, zoom01: 0, az: 45, entered: null, level: 'town', minute: 11 * 60, night: 0, paused: false,
    sources: [
      { kind: 'green', id: 'forest', gain: 0.5, pan: -0.2 },
      { kind: 'field', id: 'field_1', gain: 0.4, pan: 0.5 },
      { kind: 'road', id: 'westway', gain: 0.5, pan: -0.6 },
      { kind: 'water', id: 'brook', gain: 0.3, pan: 0.2 },
      { kind: 'murmur', id: 'spot_fountain_rim', gain: 0.3, pan: 0 },
    ],
  },
  'street · café · day': {
    x: 40, z: 30, zoom01: 1, az: 45, entered: null, level: 'street', minute: 13 * 60, night: 0, paused: false,
    sources: [
      { kind: 'murmur', id: 'spot_cafe_patio', gain: 0.9, pan: -0.3 },
      { kind: 'murmur', id: 'bld_corner_cafe', gain: 0.6, pan: -0.5 },
      { kind: 'water', id: 'lm_fountain', gain: 0.7, pan: 0.4 },
      { kind: 'green', id: 'park_commons', gain: 0.4, pan: 0.6 },
      { kind: 'road', id: 'brook_road', gain: 0.3, pan: 0.8 },
    ],
  },
  'district · night': {
    x: 60, z: 40, zoom01: 0.5, az: 200, entered: null, level: 'district', minute: 23 * 60, night: 1, paused: false,
    sources: [
      { kind: 'green', id: 'park_commons', gain: 0.6, pan: -0.4 },
      { kind: 'field', id: 'field_2', gain: 0.3, pan: 0.7 },
      { kind: 'road', id: 'brook_road', gain: 0.3, pan: 0.1 },
    ],
  },
  'inside the café': {
    x: 40, z: 30, zoom01: 1, az: 45, entered: 'bld_corner_cafe', level: 'interior', minute: 13 * 60, night: 0, paused: false,
    sources: [
      { kind: 'murmur', id: 'spot_cafe_patio', gain: 0.9, pan: -0.3 },
      { kind: 'green', id: 'park_commons', gain: 0.4, pan: 0.6 },
    ],
  },
};
SCENES['town · day · paused'] = { ...SCENES['town · day']!, paused: true };

const MAX: AudioSettings = { enabled: true, master: 1, ambient: 1, ui: 1, events: 1, reduce: false };
const BED_SECONDS = 10;
const BED_FROM = 3;

export async function renderUi(sound: UiSound | 'whoosh', settings: AudioSettings = DEFAULT_AUDIO_SETTINGS): Promise<Measure> {
  const buf = await render(1.6, settings, (s) => {
    if (sound === 'whoosh') whooshVoice(s.synth, s.graph.ui, 0.05, 0.7, 0.6);
    else uiVoice(s.synth, s.graph.ui, 0.05, sound);
  });
  return measure(sound, buf);
}

export async function renderCue(cue: EventCue, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS): Promise<Measure> {
  const buf = await render(2.5, settings, (s) => void cueVoice(s.synth, s.graph.events, 0.05, cue, 0));
  return measure(cue, buf);
}

export async function renderBed(name: string, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS, only?: (m: AmbientMix) => AmbientMix): Promise<Measure> {
  const l = SCENES[name]!;
  const buf = await render(BED_SECONDS, settings, (s) => void bed(s, l, BED_SECONDS, settings, only), { interior: l.entered !== null });
  return measure(name, buf, BED_FROM);
}

const LAYERS = {
  breeze: ['breeze'],
  wind: ['wind'],
  birds: ['birdsRate'],
  crickets: ['crickets'],
  murmur: ['murmur', 'murmurPan'],
  water: ['water', 'waterPan'],
  traffic: ['traffic', 'trafficPan'],
  room: ['room'],
} as const satisfies Record<string, readonly (keyof AmbientMix)[]>;

/** Each layer of a scene alone (for tuning the trims). */
export async function renderLayers(name: string, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS): Promise<Measure[]> {
  const out: Measure[] = [];
  for (const [layer, keys] of Object.entries(LAYERS)) {
    const m = await renderBed(name, settings, (full) => {
      const one: AmbientMix = { ...SILENT_MIX, day: full.day, interior: full.interior };
      for (const k of keys) (one as unknown as Record<string, number>)[k] = full[k] as number;
      return one;
    });
    out.push({ ...m, name: `${name} · ${layer}` });
  }
  return out;
}

export interface CheckRow {
  group: 'ui' | 'cue' | 'bed' | 'settings' | 'stack';
  name: string;
  measure?: Measure;
  expect: string;
  ok: boolean;
}

/** Every check (S4 and the brief): non-silent, never clipping, a quiet bed, settings that change the output. */
export async function runRenderCheck(): Promise<{ ok: boolean; rows: CheckRow[] }> {
  const rows: CheckRow[] = [];
  const add = (r: CheckRow) => rows.push(r);
  const SILENT_DB = -90;

  for (const sound of [...UI_SOUNDS, 'whoosh' as const]) {
    const d = await renderUi(sound);
    const m = await renderUi(sound, MAX);
    add({ group: 'ui', name: `${sound} (default)`, measure: d, expect: 'peak > −50 dBFS and < 0.9', ok: d.peakDb > -50 && d.peak < CLIP });
    add({ group: 'ui', name: `${sound} (max volume)`, measure: m, expect: 'peak < 0.9', ok: m.peak < CLIP && m.peakDb > -40 });
  }
  for (const cue of EVENT_CUES) {
    const d = await renderCue(cue);
    const m = await renderCue(cue, MAX);
    add({ group: 'cue', name: `${cue} (default)`, measure: d, expect: 'peak > −40 dBFS and < 0.9', ok: d.peakDb > -40 && d.peak < CLIP });
    add({ group: 'cue', name: `${cue} (max volume)`, measure: m, expect: 'peak < 0.9', ok: m.peak < CLIP });
  }
  for (const name of Object.keys(SCENES)) {
    const d = await renderBed(name);
    add({ group: 'bed', name: `${name} (default)`, measure: d, expect: 'RMS −56…−32 dBFS, peak < 0.9', ok: d.rmsDb > -56 && d.rmsDb < -32 && d.peak < CLIP });
  }
  const loud = await renderBed('street · café · day', MAX);
  add({ group: 'bed', name: 'street · café · day (max volume)', measure: loud, expect: 'RMS < −12 dBFS, peak < 0.9', ok: loud.rmsDb < -12 && loud.peak < CLIP });

  // The busiest moment the pacing allows, at full volume: the busiest bed, the four cues 1.2 s apart
  // (the limiter's spacing), clicks and a camera whoosh on top of the first. The worst of five seeds.
  let stack: Measure | null = null;
  for (const seed of [1, 7, 42, 99, 2024]) {
    const buf = await render(
      9,
      MAX,
      (s) => {
        bed(s, SCENES['street · café · day']!, 9, MAX);
        EVENT_CUES.forEach((cue, i) => cueVoice(s.synth, s.graph.events, 3 + i * 1.2, cue, 0));
        uiVoice(s.synth, s.graph.ui, 3, 'select');
        uiVoice(s.synth, s.graph.ui, 3.02, 'menu');
        uiVoice(s.synth, s.graph.ui, 4.2, 'error');
        whooshVoice(s.synth, s.graph.ui, 2.8, 0.8, 0.5);
      },
      { seed },
    );
    const m = measure('busiest moment (max volume, worst of 5)', buf);
    if (!stack || m.peak > stack.peak) stack = m;
  }
  stack = stack!;
  add({ group: 'stack', name: stack.name, measure: stack, expect: 'peak < 0.9', ok: stack.peak < CLIP });

  // Settings audibly change the output.
  const base = await renderBed('street · café · day');
  const variants: [string, Partial<AudioSettings>, (m: Measure) => boolean, string][] = [
    ['bed · master 30%', { master: 0.3 }, (m) => m.rmsDb < base.rmsDb - 6, '≥ 6 dB quieter'],
    ['bed · ambient 100%', { ambient: 1 }, (m) => m.rmsDb > base.rmsDb + 6, '≥ 6 dB louder'],
    ['bed · ambient off', { ambient: 0 }, (m) => m.rmsDb < SILENT_DB, 'silent'],
    ['bed · sound off (mute)', { enabled: false }, (m) => m.rmsDb < SILENT_DB, 'silent'],
    ['bed · reduce sound', { reduce: true }, (m) => m.rmsDb < SILENT_DB, 'silent'],
  ];
  for (const [name, p, ok, expect] of variants) {
    const m = await renderBed('street · café · day', { ...DEFAULT_AUDIO_SETTINGS, ...p });
    add({ group: 'settings', name, measure: m, expect: `${expect} (default ${base.rmsDb} dB)`, ok: ok(m) });
  }
  const sel = await renderUi('select');
  const uiChecks: [string, Partial<AudioSettings>, (m: Measure) => boolean, string][] = [
    ['select · UI off', { ui: 0 }, (m) => m.rmsDb < SILENT_DB, 'silent'],
    ['select · UI 100%', { ui: 1 }, (m) => m.rmsDb > sel.rmsDb + 6, '≥ 6 dB louder'],
    ['select · reduce sound (−6 dB)', { reduce: true }, (m) => Math.abs(m.rmsDb - (sel.rmsDb - 6)) < 1, '6 dB quieter'],
  ];
  for (const [name, p, ok, expect] of uiChecks) {
    const m = await renderUi('select', { ...DEFAULT_AUDIO_SETTINGS, ...p });
    add({ group: 'settings', name, measure: m, expect: `${expect} (default ${sel.rmsDb} dB)`, ok: ok(m) });
  }
  const done = await renderCue('taskDone');
  for (const [name, p, ok, expect] of [
    ['taskDone · events off', { events: 0 }, (m: Measure) => m.rmsDb < SILENT_DB, 'silent'],
    ['taskDone · events 30%', { events: 0.3 }, (m: Measure) => m.rmsDb < done.rmsDb - 6, '≥ 6 dB quieter'],
  ] as const) {
    const m = await renderCue('taskDone', { ...DEFAULT_AUDIO_SETTINGS, ...p });
    add({ group: 'settings', name, measure: m, expect: `${expect} (default ${done.rmsDb} dB)`, ok: ok(m) });
  }
  return { ok: rows.every((r) => r.ok), rows };
}
