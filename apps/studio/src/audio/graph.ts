/**
 * The mixing graph (contract §4b):
 *
 *   ambient layers → outdoor (−9 dB inside) → outdoorLp (700 Hz inside) ┐
 *   room tone ───────────────────────────────────────────────────────── ambient ┐
 *   birds ── outdoor; birds → birdsSend (0.25) → reverb                          │
 *   UI voices → ui ── uiSend (0.1) → reverb                                     ├→ master → compressor (−18 dB, 3:1) → out
 *   cue voices → events ── eventsSend (0.2) → reverb                            │
 *   reverb (generated 1.6 s impulse) ────────────────────────────────────────── ┘
 *
 * Bus gains come from the settings (`busTargets`); the birds' reverb send
 * follows the ambient volume and the interior so it never outlives them.
 */
import { sliderGain } from './settings';
import type { Buffers } from './synth';
import type { AudioSettings } from './types';

export interface AudioGraph {
  ctx: BaseAudioContext;
  buffers: Buffers;
  master: GainNode;
  compressor: DynamicsCompressorNode;
  ambient: GainNode;
  outdoor: GainNode;
  outdoorLp: BiquadFilterNode;
  birds: GainNode;
  birdsSend: GainNode;
  ui: GainNode;
  uiSend: GainNode;
  events: GainNode;
  eventsSend: GainNode;
  reverb: ConvolverNode;
}

/** Persistent nodes the graph itself creates (the soundscape adds its own). */
export const GRAPH_NODES = 12;

export const BIRDS_SEND = 0.25;
export const UI_SEND = 0.1;
export const EVENTS_SEND = 0.2;
/** Inside a building the birds' reverb (which skips the interior lowpass) almost goes. */
export const BIRDS_SEND_INSIDE = 0.15;
/** 1 dB of headroom on the master: the busiest moment at full volume stays under 0.9 (render check). */
export const MASTER_HEADROOM = 0.89;
/** Outdoor lowpass: open outside, 700 Hz inside a building. */
export const OUTDOOR_OPEN_HZ = 18000;
export const OUTDOOR_INSIDE_HZ = 700;

export function buildGraph(ctx: BaseAudioContext, buffers: Buffers, out: AudioNode = ctx.destination): AudioGraph {
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const master = gain(0);
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 3;
  compressor.knee.value = 4;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.25;
  master.connect(compressor).connect(out);

  const reverb = ctx.createConvolver();
  reverb.buffer = buffers.impulse;
  reverb.connect(master);

  const ambient = gain(0);
  ambient.connect(master);
  const outdoor = gain(1);
  const outdoorLp = ctx.createBiquadFilter();
  outdoorLp.type = 'lowpass';
  outdoorLp.frequency.value = OUTDOOR_OPEN_HZ;
  outdoorLp.Q.value = 0.5;
  outdoor.connect(outdoorLp).connect(ambient);

  const birds = gain(1);
  birds.connect(outdoor);
  const birdsSend = gain(0);
  birds.connect(birdsSend).connect(reverb);

  const ui = gain(0);
  ui.connect(master);
  const uiSend = gain(UI_SEND);
  ui.connect(uiSend).connect(reverb);

  const events = gain(0);
  events.connect(master);
  const eventsSend = gain(EVENTS_SEND);
  events.connect(eventsSend).connect(reverb);

  return { ctx, buffers, master, compressor, ambient, outdoor, outdoorLp, birds, birdsSend, ui, uiSend, events, eventsSend, reverb };
}

export interface BusTargets {
  master: number;
  ambient: number;
  birdsSend: number;
  ui: number;
  events: number;
}

/**
 * Bus gains for the settings. `audible` = sound on and the tab visible.
 * Reduce sound: no ambient bed, UI −6 dB (cues are filtered by the engine).
 */
export function busTargets(s: AudioSettings, opts: { audible: boolean; interior?: boolean }): BusTargets {
  const ambient = s.reduce ? 0 : sliderGain(s.ambient);
  return {
    master: opts.audible && s.enabled ? MASTER_HEADROOM * sliderGain(s.master) : 0,
    ambient,
    birdsSend: BIRDS_SEND * ambient * (opts.interior ? BIRDS_SEND_INSIDE : 1),
    ui: sliderGain(s.ui) * (s.reduce ? 0.5 : 1),
    events: sliderGain(s.events),
  };
}

/** Glide a param to `v` over `seconds` from its current value (0 = now). */
export function rampTo(p: AudioParam, v: number, at: number, seconds: number): void {
  p.cancelScheduledValues(at);
  p.setValueAtTime(p.value, at);
  if (seconds <= 0) p.setValueAtTime(v, at);
  else p.linearRampToValueAtTime(v, at + seconds);
}

export function applyBuses(g: AudioGraph, t: BusTargets, at: number, seconds: number, opts: { master?: boolean; ambient?: boolean } = {}): void {
  if (opts.master !== false) rampTo(g.master.gain, t.master, at, seconds);
  if (opts.ambient !== false) {
    rampTo(g.ambient.gain, t.ambient, at, seconds);
    rampTo(g.birdsSend.gain, t.birdsSend, at, seconds);
  }
  rampTo(g.ui.gain, t.ui, at, seconds);
  rampTo(g.events.gain, t.events, at, seconds);
}
