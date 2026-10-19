/**
 * The ambient town bed (contract §4b): breeze, high wind, birds (day),
 * crickets (night), murmur near busy places, water, a distant traffic hum,
 * and room tone inside buildings. It follows the camera through the mix
 * (`mix.ts`); `update` is called about four times a second and schedules
 * what happens in the next `LOOKAHEAD` seconds on the audio clock, so a late
 * timer never leaves a gap. All synthesis: looping noise buffers, filters,
 * a few oscillators.
 *
 * Persistent nodes: 28 here + 12 in the graph = 40 (the contract's cap).
 */
import type { AudioGraph } from './graph';
import { OUTDOOR_INSIDE_HZ, OUTDOOR_OPEN_HZ } from './graph';
import { INTERIOR_OUTDOOR_GAIN, smoothToward, type AmbientMix } from './mix';
import { between, createPan, type Rng } from './synth';

/** How far ahead events are scheduled (s). */
export const LOOKAHEAD = 0.6;
/** How fast levels follow the mix (s): a paused world fades out in ~1.5 s. */
export const LEVEL_TAU = 0.5;

/**
 * Each layer's gain at level 1, calibrated with `render.ts` (`?layers=1` on
 * the sound board prints each layer alone) so the default bed stays quiet
 * (about −37 to −40 dBFS RMS by day) and no layer dominates.
 */
export const TRIM = {
  breeze: 1.2,
  wind: 0.96,
  birds: 0.2,
  crickets: 0.11,
  murmur: 0.9,
  water: 2.2,
  /** The water's low rumble, relative to its grains. */
  rumble: 0.25,
  traffic: 0.4,
  /** The mix's room level (0.08), heard through the interior's −9 dB, kept under the voices. */
  room: 0.5 / INTERIOR_OUTDOOR_GAIN,
} as const;

export const SOUNDSCAPE_NODES = 28;

export interface BedLevels {
  breeze: number;
  wind: number;
  /** Calls per second. */
  birds: number;
  crickets: number;
  murmur: number;
  water: number;
  traffic: number;
  room: number;
  interior: boolean;
  /** A distant car is passing. */
  passing: boolean;
}

type Levels = { breeze: number; wind: number; birdsRate: number; crickets: number; murmur: number; water: number; traffic: number; room: number; day: number };
const LEVEL_KEYS = ['breeze', 'wind', 'birdsRate', 'crickets', 'murmur', 'water', 'traffic', 'room'] as const;

export type SpawnBird = (t: number, species: number, pan: number, peak: number) => void;

export class Soundscape {
  private readonly sources: AudioScheduledSourceNode[];
  private readonly breezeGain: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly windGain: GainNode;
  private readonly cricketOsc: OscillatorNode;
  private readonly cricketEnv: GainNode;
  private readonly cricketPan: AudioParam | null;
  private readonly murmurGain: GainNode;
  private readonly murmurPan: AudioParam | null;
  private readonly waterGain: GainNode;
  private readonly rumble: GainNode;
  private readonly waterPan: AudioParam | null;
  private readonly trafficLp: BiquadFilterNode;
  private readonly trafficGain: GainNode;
  private readonly roomGain: GainNode;

  private L: Levels = { breeze: 0, wind: 0, birdsRate: 0, crickets: 0, murmur: 0, water: 0, traffic: 0, room: 0, day: 1 };
  private pans = { murmur: 0, water: 0 };
  private gust = 0.6;
  private next = { gust: 0, syllable: 0, grain: 0, train: 0, call: 0, lfo: 0, pass: 0 };
  private pass: { start: number; dur: number } | null = null;
  private cricketVoice = 0;
  private murmurOn = false;
  private waterOn = false;
  private birdsOn = false;
  /** Inside a building (the outdoor bed is muffled). */
  inside = false;

  constructor(
    private readonly g: AudioGraph,
    private readonly rng: Rng,
    private readonly spawnBird: SpawnBird,
  ) {
    const { ctx, buffers } = g;
    const loop = (buffer: AudioBuffer, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.playbackRate.value = rate;
      return s;
    };
    const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const gain = (v = 0) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    // Two decorrelated pink loops (different rates and offsets) and one brown.
    const pinkA = loop(buffers.pink);
    const pinkB = loop(buffers.pink, 0.93);
    const brown = loop(buffers.brown);

    // Breeze: band-passed pink, swept slowly, two loops panned ±0.6, softened by a 600 Hz lowpass.
    const bpL = filter('bandpass', 560, 0.9);
    const bpR = filter('bandpass', 600, 0.9);
    const panL = createPan(ctx, -0.6);
    const panR = createPan(ctx, 0.6);
    const lp = filter('lowpass', 600, 0.3);
    this.breezeGain = gain();
    pinkA.connect(bpL).connect(panL.node).connect(lp);
    pinkB.connect(bpR).connect(panR.node).connect(lp);
    lp.connect(this.breezeGain).connect(g.outdoor);
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.08;
    const depth = gain(320);
    this.lfo.connect(depth);
    depth.connect(bpL.frequency);
    depth.connect(bpR.frequency);

    // High wind: pink above 1.2 kHz, in gusts.
    const hp = filter('highpass', 1200, 0.5);
    this.windGain = gain();
    pinkA.connect(hp).connect(this.windGain).connect(g.outdoor);

    // Crickets: one sine, two alternating voices (pitch and side), pulsed by an envelope.
    this.cricketOsc = ctx.createOscillator();
    this.cricketOsc.frequency.value = 4400;
    this.cricketEnv = gain();
    const cp = createPan(ctx, 0);
    this.cricketPan = cp.pan;
    this.cricketOsc.connect(this.cricketEnv).connect(cp.node).connect(g.outdoor);

    // Murmur: pink through two speech-ish bands, gated into syllables, panned to its source.
    const m1 = filter('bandpass', 450, 0.8);
    const m2 = filter('bandpass', 1100, 1.2);
    this.murmurGain = gain();
    const mp = createPan(ctx, 0);
    this.murmurPan = mp.pan;
    pinkB.connect(m1).connect(this.murmurGain);
    pinkB.connect(m2).connect(this.murmurGain);
    this.murmurGain.connect(mp.node).connect(g.outdoor);

    // Water: a narrow 1.8 kHz band in short grains, plus a low rumble.
    const wbp = filter('bandpass', 1800, 3);
    const wlp = filter('lowpass', 400, 0.5);
    this.waterGain = gain();
    this.rumble = gain();
    const wp = createPan(ctx, 0);
    this.waterPan = wp.pan;
    pinkA.connect(wbp).connect(this.waterGain);
    pinkA.connect(wlp).connect(this.rumble).connect(this.waterGain);
    this.waterGain.connect(wp.node).connect(g.outdoor);

    // Traffic: brown noise under 140 Hz; a pass-by sweeps it 200 → 120 Hz.
    this.trafficLp = filter('lowpass', 140, 0.6);
    this.trafficGain = gain();
    brown.connect(this.trafficLp).connect(this.trafficGain).connect(g.outdoor);

    // Room tone: brown noise; inside, the outdoor lowpass (700 Hz) shapes it.
    this.roomGain = gain();
    brown.connect(this.roomGain).connect(g.outdoor);

    this.sources = [pinkA, pinkB, brown, this.lfo, this.cricketOsc];
  }

  start(t: number): void {
    const [pinkA, pinkB, brown, lfo, crickets] = this.sources as [AudioBufferSourceNode, AudioBufferSourceNode, AudioBufferSourceNode, OscillatorNode, OscillatorNode];
    pinkA.start(t, 0);
    pinkB.start(t, 1.7);
    brown.start(t, 0.9);
    lfo.start(t);
    crickets.start(t);
    for (const k of Object.keys(this.next) as (keyof typeof this.next)[]) this.next[k] = t;
    this.next.pass = t + between(this.rng, 4, 10);
  }

  stop(t: number): void {
    for (const s of this.sources) {
      try {
        s.stop(t);
      } catch {
        // never started
      }
    }
  }

  /** Follow the mix at audio time `now` (dt = seconds since the last update) and schedule the next LOOKAHEAD. */
  update(now: number, mix: AmbientMix, dt: number): void {
    const { rng, L } = this;
    const step = Math.min(1, Math.max(0, dt));
    for (const k of LEVEL_KEYS) L[k] = smoothToward(L[k], mix[k], step, LEVEL_TAU);
    L.day = mix.day;
    this.pans.murmur = smoothToward(this.pans.murmur, mix.murmurPan, step, 0.3);
    this.pans.water = smoothToward(this.pans.water, mix.waterPan, step, 0.3);
    const horizon = now + LOOKAHEAD;

    // Continuous layers: glide toward their level.
    this.breezeGain.gain.setTargetAtTime(L.breeze * TRIM.breeze, now, 0.15);
    if (now >= this.next.gust) {
      this.gust = between(rng, 0.35, 1);
      this.next.gust = now + between(rng, 3, 6);
    }
    this.windGain.gain.setTargetAtTime(L.wind * TRIM.wind * this.gust, now, 1.2);
    this.roomGain.gain.setTargetAtTime(L.room * TRIM.room, now, 0.3);
    this.rumble.gain.setTargetAtTime(TRIM.rumble, now, 0.3);
    this.murmurPan?.setTargetAtTime(this.pans.murmur, now, 0.3);
    this.waterPan?.setTargetAtTime(this.pans.water, now, 0.3);
    if (now >= this.next.lfo) {
      this.lfo.frequency.setTargetAtTime(between(rng, 0.05, 0.12), now, 4);
      this.next.lfo = now + between(rng, 15, 25);
    }

    // Inside a building: the outdoor bed −9 dB through 700 Hz.
    if (mix.interior !== this.inside) {
      this.inside = mix.interior;
      this.g.outdoor.gain.setTargetAtTime(this.inside ? INTERIOR_OUTDOOR_GAIN : 1, now, 0.25);
      this.g.outdoorLp.frequency.setTargetAtTime(this.inside ? OUTDOOR_INSIDE_HZ : OUTDOOR_OPEN_HZ, now, 0.25);
    }

    // Traffic: a steady hum, and now and then (by day) a distant car passing.
    if (!this.pass && now >= this.next.pass) {
      if (rng() < L.day && L.traffic > 0.01) this.pass = { start: now + 0.05, dur: 2.5 };
      this.next.pass = now + between(rng, 8, 20);
    }
    let swell = 0;
    let freq = 140;
    if (this.pass) {
      const u = (now - this.pass.start) / this.pass.dur;
      if (u >= 1) this.pass = null;
      else if (u >= 0) {
        swell = Math.sin(Math.PI * u) ** 2;
        freq = 200 - 80 * u;
      }
    }
    this.trafficGain.gain.setTargetAtTime(L.traffic * TRIM.traffic * (1 + 1.5 * swell), now, 0.3);
    this.trafficLp.frequency.setTargetAtTime(freq, now, 0.3);

    // Murmur syllables.
    const murmur = L.murmur * TRIM.murmur;
    let t = Math.max(this.next.syllable, now);
    if (murmur > 1e-4 || this.murmurOn) {
      while (t < horizon) {
        this.murmurGain.gain.setTargetAtTime(murmur > 1e-4 ? murmur * between(rng, 0.4, 1) : 0, t, 0.035);
        t += between(rng, 0.12, 0.3);
      }
      this.murmurOn = murmur > 1e-4;
    } else t = horizon;
    this.next.syllable = t;

    // Water grains.
    const water = L.water * TRIM.water;
    t = Math.max(this.next.grain, now);
    if (water > 1e-4 || this.waterOn) {
      while (t < horizon) {
        const d = between(rng, 0.04, 0.09);
        this.waterGain.gain.setTargetAtTime(water * between(rng, 0.6, 1), t, 0.01);
        this.waterGain.gain.setTargetAtTime(water * 0.3, t + d * 0.5, d * 0.4);
        t += d + between(rng, 0, 0.07);
      }
      this.waterOn = water > 1e-4;
      if (!this.waterOn) this.waterGain.gain.setTargetAtTime(0, t, 0.1);
    } else t = horizon;
    this.next.grain = t;

    // Cricket trains: 3–5 pulses of 18 ms at 30 Hz, voices alternating.
    t = Math.max(this.next.train, now);
    while (t < horizon) {
      const level = L.crickets * TRIM.crickets;
      if (level < 1e-4) {
        t += 0.4;
        continue;
      }
      this.cricketVoice ^= 1;
      const a = this.cricketVoice === 1;
      this.cricketOsc.frequency.setValueAtTime(a ? 4400 + between(rng, -150, 150) : 4250 + between(rng, -100, 100), t);
      this.cricketPan?.setValueAtTime(a ? -0.4 : 0.35, t);
      const n = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const tp = t + i / 30;
        this.cricketEnv.gain.setValueAtTime(0, tp);
        this.cricketEnv.gain.linearRampToValueAtTime(level, tp + 0.004);
        this.cricketEnv.gain.linearRampToValueAtTime(0, tp + 0.018);
      }
      t += n / 30 + between(rng, 0.2, 0.6);
    }
    this.next.train = t;

    // Bird calls: a Poisson process at birdsRate calls/s.
    const rate = L.birdsRate;
    if (rate < 0.005) {
      this.birdsOn = false;
    } else {
      const wait = () => Math.min(30, Math.max(0.25, -Math.log(1 - rng()) / rate));
      if (!this.birdsOn) this.next.call = now + wait();
      this.birdsOn = true;
      while (this.next.call < horizon) {
        this.spawnBird(Math.max(now, this.next.call), Math.floor(rng() * 3), between(rng, -0.7, 0.7), TRIM.birds * between(rng, 0.5, 1));
        this.next.call += wait();
      }
    }
  }

  get levels(): BedLevels {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const { L } = this;
    return {
      breeze: r(L.breeze),
      wind: r(L.wind * this.gust),
      birds: r(L.birdsRate),
      crickets: r(L.crickets),
      murmur: r(L.murmur),
      water: r(L.water),
      traffic: r(L.traffic),
      room: r(L.room),
      interior: this.inside,
      passing: this.pass !== null,
    };
  }
}
