/**
 * Test helpers: a minimal fake of the Web Audio nodes the engine uses (it
 * records automation; it makes no sound) and a fake page environment with a
 * manual clock and timers. Tests only. Real rendering is checked in a real
 * browser by `check/render-check.mjs` (OfflineAudioContext).
 */
import type { EngineEnv } from './engine';

export interface ParamEvent {
  type: 'set' | 'linear' | 'exp' | 'target' | 'curve' | 'cancel';
  v: number;
  t: number;
}

export class FakeParam {
  events: ParamEvent[] = [];
  constructor(public value = 0) {}
  setValueAtTime(v: number, t: number) {
    this.events.push({ type: 'set', v, t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ type: 'linear', v, t });
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.events.push({ type: 'exp', v, t });
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number) {
    this.events.push({ type: 'target', v, t });
    this.value = v;
    return this;
  }
  setValueCurveAtTime(c: ArrayLike<number>, t: number) {
    this.events.push({ type: 'curve', v: c[c.length - 1] ?? 0, t });
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events.push({ type: 'cancel', v: this.value, t });
    return this;
  }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  constructor(readonly ctx: FakeAudioContext, readonly kind: string) {}
  connect<T>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect() {
    this.outputs.length = 0;
  }
}

class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;
  start(t = 0) {
    if (this.started !== null) throw new Error('InvalidStateError: start called twice');
    this.started = t;
  }
  stop(t = 0) {
    if (this.started === null) throw new Error('InvalidStateError: stop before start');
    this.stopped = t;
  }
}

class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(i: number) {
    return this.data[i]!;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 8000;
  state: 'running' | 'suspended' | 'closed' = 'running';
  onstatechange: (() => void) | null = null;
  readonly destination = new FakeNode(this, 'destination');
  /** Every node created, in order. */
  readonly nodes: FakeNode[] = [];
  readonly params: FakeParam[] = [];

  private param(v: number) {
    const p = new FakeParam(v);
    this.params.push(p);
    return p;
  }
  private add<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return this.add(Object.assign(new FakeNode(this, 'gain'), { gain: this.param(1) }));
  }
  createOscillator() {
    return this.add(Object.assign(new FakeSource(this, 'oscillator'), { type: 'sine', frequency: this.param(440), detune: this.param(0) }));
  }
  createBufferSource() {
    return this.add(Object.assign(new FakeSource(this, 'buffer'), { buffer: null as FakeBuffer | null, loop: false, playbackRate: this.param(1) }));
  }
  createBiquadFilter() {
    return this.add(Object.assign(new FakeNode(this, 'biquad'), { type: 'lowpass', frequency: this.param(350), Q: this.param(1), gain: this.param(0) }));
  }
  createDynamicsCompressor() {
    return this.add(
      Object.assign(new FakeNode(this, 'compressor'), { threshold: this.param(-24), knee: this.param(30), ratio: this.param(12), attack: this.param(0.003), release: this.param(0.25) }),
    );
  }
  createConvolver() {
    return this.add(Object.assign(new FakeNode(this, 'convolver'), { buffer: null as FakeBuffer | null, normalize: true }));
  }
  createStereoPanner() {
    return this.add(Object.assign(new FakeNode(this, 'panner'), { pan: this.param(0) }));
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume() {
    this.setState('running');
    return Promise.resolve();
  }
  suspend() {
    this.setState('suspended');
    return Promise.resolve();
  }
  private setState(s: FakeAudioContext['state']) {
    if (this.state === s) return;
    this.state = s;
    this.onstatechange?.();
  }
  /** Sources created and not yet stopped by `t`. */
  sourcesPlayingAt(t: number) {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource && n.started !== null && n.started <= t && (n.stopped === null || n.stopped > t));
  }
}

export interface FakeEnv extends EngineEnv {
  contexts: FakeAudioContext[];
  clock: { ms: number };
  /** Advance wall time and run due timers. */
  advance(ms: number): void;
  store: Map<string, string>;
}

export function fakeEnv(opts: { supported?: boolean; stored?: unknown } = {}): FakeEnv {
  const clock = { ms: 1000 };
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  let nextId = 1;
  const store = new Map<string, string>();
  if (opts.stored !== undefined) store.set('runloop.audio.v1', JSON.stringify(opts.stored));
  const contexts: FakeAudioContext[] = [];
  const env: FakeEnv = {
    supported: opts.supported ?? true,
    contexts,
    clock,
    store,
    createContext: () => {
      const c = new FakeAudioContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    now: () => clock.ms,
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock.ms + ms, every: ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearInterval: (id) => void timers.delete(id as unknown as number),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock.ms + ms, every: null, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => void timers.delete(id as unknown as number),
    advance: (ms) => {
      const end = clock.ms + ms;
      // The audio clock moves with the wall clock while its context runs.
      const moveTo = (to: number) => {
        for (const c of contexts) if (c.state === 'running') c.currentTime += (to - clock.ms) / 1000;
        clock.ms = to;
      };
      for (;;) {
        let next: [number, { at: number; every: number | null; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        const [id, t] = next;
        moveTo(t.at);
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      moveTo(end);
    },
  };
  return env;
}
