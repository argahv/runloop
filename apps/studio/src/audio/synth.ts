/**
 * Sound synthesis (contract §4b): everything is generated with the Web Audio
 * API, with no audio files, samples or licences. Noise buffers and the reverb impulse
 * are made once per context; each UI sound, whoosh, cue and bird call is a
 * short-lived voice of oscillators and filtered noise with its own envelope.
 *
 * Levels here are pre-bus peaks: at full volume sliders a voice peaks at
 * about these values; the buses and the master scale them down (see
 * `render.ts` for the measured output).
 */
import type { EventCue, UiSound } from './types';

export type Rng = () => number;

/** A deterministic PRNG (mulberry32), so renders and tests repeat. */
export function seededRng(seed = 1): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

export interface Buffers {
  /** 4 s of looping pink noise (RMS ≈ 0.25). */
  pink: AudioBuffer;
  /** 4 s of looping brown noise (RMS ≈ 0.25). */
  brown: AudioBuffer;
  /** A 1.6 s stereo room: decaying, darkening noise. */
  impulse: AudioBuffer;
}

const NOISE_SECONDS = 4;
const LOOP_FADE_SECONDS = 0.05;

/** Make a loop seamless: the last `fade` samples blend into the first (equal power). */
function loopable(raw: Float32Array, n: number, fade: number): Float32Array {
  const out = raw.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const a = Math.sqrt(i / fade);
    out[i] = raw[i]! * a + raw[n + i]! * Math.sqrt(1 - a * a);
  }
  return out;
}

function normalise(x: Float32Array, rms: number): void {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = x[i]! - mean;
    sum += x[i]! * x[i]!;
  }
  const k = rms / Math.sqrt(sum / x.length || 1);
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-0.98, Math.min(0.98, x[i]! * k));
}

/** Pink noise (Paul Kellet's filter). */
export function pinkNoise(len: number, rng: Rng): Float32Array {
  const out = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

/** Brown noise (leaky integrated white noise, DC removed). */
export function brownNoise(len: number, rng: Rng): Float32Array {
  const out = new Float32Array(len);
  let last = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < len; i++) {
    last = (last + 0.02 * (rng() * 2 - 1)) / 1.02;
    // DC blocker
    py = last - px + 0.999 * py;
    px = last;
    out[i] = py;
  }
  return out;
}

export function makeBuffers(ctx: BaseAudioContext, rng: Rng): Buffers {
  const sr = ctx.sampleRate;
  const n = Math.round(NOISE_SECONDS * sr);
  const fade = Math.round(LOOP_FADE_SECONDS * sr);
  const make = (gen: (len: number, rng: Rng) => Float32Array) => {
    const raw = gen(n + fade, rng);
    normalise(raw, 0.25);
    const data = loopable(raw, n, fade);
    const b = ctx.createBuffer(1, n, sr);
    b.getChannelData(0).set(data);
    return b;
  };
  const pink = make(pinkNoise);
  const brown = make(brownNoise);

  const len = Math.round(1.6 * sr);
  const impulse = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t / 0.23) * Math.min(1, t / 0.01);
      // The tail gets darker: a one-pole lowpass closing over time.
      const k = 0.15 + 0.7 * Math.min(1, t / 1.2);
      lp = lp * k + (rng() * 2 - 1) * (1 - k);
      d[i] = lp * env;
    }
  }
  return { pink, brown, impulse };
}

// ── Voices ───────────────────────────────────────────────────────────

export type VoiceKind = 'ui' | 'bird' | 'event';

/** Each kind's level over the ambient bed (calibrated with `render.ts`): UI +2 dB, event cues +3 dB. */
export const VOICE_LEVEL: Readonly<Record<VoiceKind, number>> = { ui: 1.26, bird: 1, event: 1.41 };

/** A one-shot sound: its sources stop by `end`; `out` is its last gain (faded to steal it). */
export interface Voice {
  kind: VoiceKind;
  start: number;
  end: number;
  out: GainNode;
  sources: AudioScheduledSourceNode[];
}

export interface Synth {
  ctx: BaseAudioContext;
  buffers: Buffers;
  rng: Rng;
}

/** A stereo panner, or a plain gain where StereoPannerNode is missing. */
export function createPan(ctx: BaseAudioContext, pan = 0): { node: AudioNode; pan: AudioParam | null } {
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    return { node: p, pan: p.pan };
  }
  return { node: ctx.createGain(), pan: null };
}

class VoiceBuilder {
  readonly out: GainNode;
  readonly sources: AudioScheduledSourceNode[] = [];
  end: number;
  constructor(
    readonly s: Synth,
    dest: AudioNode,
    readonly t: number,
    readonly kind: VoiceKind,
  ) {
    this.out = s.ctx.createGain();
    this.out.gain.value = VOICE_LEVEL[kind];
    this.out.connect(dest);
    this.end = t;
  }

  /** An oscillator with an attack/decay envelope; `to` glides the pitch (exponentially) over `glide` s. */
  tone(o: { type?: OscillatorType; freq: number; to?: number; glide?: number; at?: number; attack: number; decay: number; peak: number; via?: AudioNode }): OscillatorNode {
    const { ctx } = this.s;
    const t = this.t + (o.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide ?? 0.09));
    const g = ctx.createGain();
    envelope(g.gain, t, o.attack, o.peak, o.decay);
    osc.connect(g).connect(o.via ?? this.out);
    this.add(osc, t, t + o.attack + o.decay * 1.6 + 0.02);
    return osc;
  }

  /** A burst of filtered noise. */
  noise(o: { buffer?: AudioBuffer; filter: BiquadFilterType; freq: number; q?: number; at?: number; attack: number; decay: number; peak: number }): void {
    const { ctx, buffers, rng } = this.s;
    const t = this.t + (o.at ?? 0);
    const buffer = o.buffer ?? buffers.pink;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = o.freq;
    f.Q.value = o.q ?? 0.7;
    const g = ctx.createGain();
    envelope(g.gain, t, o.attack, o.peak, o.decay);
    src.connect(f).connect(g).connect(this.out);
    const end = t + o.attack + o.decay * 1.6 + 0.02;
    src.start(t, between(rng, 0, Math.max(0, buffer.duration - (end - t) - 0.1)));
    this.add(src, t, end, true);
  }

  /** Track a source: start it (unless `started`, e.g. a buffer started at an offset) and stop it at `end`. */
  add(src: AudioScheduledSourceNode, start: number, end: number, started = false): void {
    if (!started) src.start(start);
    src.stop(end);
    this.sources.push(src);
    this.end = Math.max(this.end, end);
  }

  done(): Voice {
    const last = this.sources[this.sources.length - 1];
    const out = this.out;
    if (last) last.onended = () => out.disconnect();
    return { kind: this.kind, start: this.t, end: this.end, out, sources: this.sources };
  }
}

/** Attack (linear) then an exponential decay to ~2% after `decay` seconds. */
export function envelope(p: AudioParam, t: number, attack: number, peak: number, decay: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, decay / 4);
}

const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, A5 = 880, A4 = 440, F4 = 349.23, G4 = 392, E4 = 329.63;

/** The interface sounds: short, soft, mostly sine. */
export function uiVoice(s: Synth, dest: AudioNode, t: number, sound: UiSound): Voice {
  const v = new VoiceBuilder(s, dest, t, 'ui');
  switch (sound) {
    case 'hover':
      v.tone({ freq: 2600, attack: 0.001, decay: 0.025, peak: 0.14 });
      break;
    case 'select':
      v.tone({ type: 'triangle', freq: 660, attack: 0.003, decay: 0.14, peak: 0.34 });
      v.tone({ freq: 1320, attack: 0.003, decay: 0.1, peak: 0.12 });
      break;
    case 'open':
      v.tone({ freq: 520, to: 780, glide: 0.09, attack: 0.005, decay: 0.15, peak: 0.3 });
      v.noise({ filter: 'bandpass', freq: 1200, q: 1.5, attack: 0.004, decay: 0.06, peak: 0.6 });
      break;
    case 'close':
      v.tone({ freq: 700, to: 470, glide: 0.09, attack: 0.005, decay: 0.13, peak: 0.28 });
      break;
    case 'menu':
      v.tone({ freq: 196, to: 165, glide: 0.12, attack: 0.006, decay: 0.16, peak: 0.42 });
      // An octave up, so laptop speakers hear the low tone too.
      v.tone({ freq: 392, to: 330, glide: 0.12, attack: 0.006, decay: 0.14, peak: 0.12 });
      v.noise({ filter: 'bandpass', freq: 3000, q: 2, attack: 0.001, decay: 0.01, peak: 0.8 });
      break;
    case 'confirm':
      v.tone({ type: 'triangle', freq: E5, attack: 0.003, decay: 0.16, peak: 0.26 });
      v.tone({ type: 'triangle', freq: A5, at: 0.07, attack: 0.003, decay: 0.22, peak: 0.26 });
      break;
    case 'error': {
      const lp = s.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      lp.connect(v.out);
      v.tone({ type: 'triangle', freq: A4, attack: 0.004, decay: 0.16, peak: 0.34, via: lp });
      v.tone({ type: 'triangle', freq: F4, at: 0.11, attack: 0.004, decay: 0.24, peak: 0.34, via: lp });
      break;
    }
    case 'toggle':
      v.tone({ freq: 880, attack: 0.002, decay: 0.04, peak: 0.2 });
      break;
  }
  return v.done();
}

/** A camera fly's whoosh: band-passed pink noise rising then falling, panned across. */
export function whooshVoice(s: Synth, dest: AudioNode, t: number, seconds: number, pan: number): Voice {
  const { ctx, buffers, rng } = s;
  const v = new VoiceBuilder(s, dest, t, 'ui');
  const d = Math.max(0.25, Math.min(2.5, seconds));
  const src = ctx.createBufferSource();
  src.buffer = buffers.pink;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(1600, t + d * 0.4);
  bp.frequency.exponentialRampToValueAtTime(500, t + d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.7, t + d * 0.4);
  g.gain.linearRampToValueAtTime(0, t + d);
  const p = createPan(ctx, -pan);
  if (p.pan) p.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, pan)), t + d);
  src.connect(bp).connect(g).connect(p.node).connect(v.out);
  src.start(t, between(rng, 0, Math.max(0, buffers.pink.duration - d - 0.1)));
  v.add(src, t, t + d + 0.02, true);
  return v.done();
}

/** The four event cues. */
export function cueVoice(s: Synth, dest: AudioNode, t: number, cue: EventCue, pan = 0): Voice {
  const { ctx } = s;
  const v = new VoiceBuilder(s, dest, t, 'event');
  const p = createPan(ctx, pan);
  p.node.connect(v.out);
  const via = p.node;
  switch (cue) {
    case 'agentLive':
      v.tone({ freq: C5, attack: 0.008, decay: 0.9, peak: 0.22, via });
      v.tone({ freq: G5, at: 0.04, attack: 0.008, decay: 0.9, peak: 0.17, via });
      v.tone({ freq: C6, at: 0.04, attack: 0.01, decay: 0.5, peak: 0.04, via });
      break;
    case 'needsApproval':
      for (const at of [0, 0.22]) {
        // An FM bell: carrier 880 Hz, modulator 1210 Hz, index 2 decaying.
        const tt = t + at;
        const car = v.tone({ freq: 880, at, attack: 0.002, decay: 0.7, peak: 0.24, via });
        const mod = ctx.createOscillator();
        mod.frequency.value = 1210;
        const depth = ctx.createGain();
        depth.gain.setValueAtTime(2 * 1210, tt);
        depth.gain.setTargetAtTime(0, tt, 0.08);
        mod.connect(depth).connect(car.frequency);
        v.add(mod, tt, tt + 0.6);
      }
      break;
    case 'incident':
      v.tone({ freq: 196, to: 165, glide: 0.12, attack: 0.004, decay: 0.22, peak: 0.4, via });
      v.tone({ freq: 392, to: 330, glide: 0.12, attack: 0.004, decay: 0.18, peak: 0.14, via });
      v.noise({ buffer: s.buffers.brown, filter: 'lowpass', freq: 120, attack: 0.004, decay: 0.15, peak: 1.2 });
      v.tone({ type: 'triangle', freq: G4, at: 0.26, attack: 0.01, decay: 0.4, peak: 0.17, via });
      v.tone({ type: 'triangle', freq: E4, at: 0.46, attack: 0.01, decay: 0.6, peak: 0.17, via });
      break;
    case 'taskDone':
      [C5, E5, G5, C6].forEach((freq, i) => v.tone({ type: 'triangle', freq, at: i * 0.07, attack: 0.004, decay: i === 3 ? 0.7 : 0.3, peak: 0.2 - i * 0.012, via }));
      break;
  }
  return v.done();
}

interface Species {
  curve: [number, number, number];
  chirps: [number, number];
  dur: [number, number];
  gap: [number, number];
}

/** Three made-up songbirds: a rising warbler, a falling sparrow, a low finch. */
export const SPECIES: readonly Species[] = [
  { curve: [3200, 4600, 3800], chirps: [3, 6], dur: [0.06, 0.09], gap: [0.04, 0.08] },
  { curve: [4300, 3500, 4000], chirps: [2, 4], dur: [0.08, 0.12], gap: [0.08, 0.14] },
  { curve: [2700, 3500, 2900], chirps: [2, 3], dur: [0.1, 0.12], gap: [0.1, 0.18] },
];

/** One bird call: 2–6 chirps on one oscillator (a pitch curve and a short envelope each). */
export function birdVoice(s: Synth, dest: AudioNode, t: number, species: number, pan: number, peak: number): Voice {
  const { ctx, rng } = s;
  const sp = SPECIES[Math.abs(species) % SPECIES.length]!;
  const v = new VoiceBuilder(s, dest, t, 'bird');
  const p = createPan(ctx, pan);
  p.node.connect(v.out);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0;
  osc.connect(g).connect(p.node);
  const jitter = between(rng, 0.92, 1.08);
  const n = Math.round(between(rng, sp.chirps[0], sp.chirps[1]));
  let at = t;
  for (let i = 0; i < n; i++) {
    const d = between(rng, sp.dur[0], sp.dur[1]);
    const curve = new Float32Array(sp.curve.map((f) => f * jitter * between(rng, 0.97, 1.03)));
    osc.frequency.setValueCurveAtTime(curve, at, d);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak * between(rng, 0.6, 1), at + 0.005);
    g.gain.setTargetAtTime(0, at + 0.005, 0.08 / 4);
    at += d + between(rng, sp.gap[0], sp.gap[1]);
  }
  v.add(osc, t, at + 0.05);
  return v.done();
}
