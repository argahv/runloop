/**
 * The ambient bed's mix rules (contract §4b), pure: from where the camera is
 * (the town's listener) to each layer's level. The engine smooths these and
 * turns them into gains and events.
 *
 * day = 1 − night, z = zoom01 (0 the whole town … 1 street level), green =
 * greenery near the camera. Murmur comes only from `murmur` sources, which
 * the town derives from simulated occupancy at busy places; ids in `exclude`
 * (agent buildings and lots) are dropped as a second guard.
 */
import type { AudioListener } from './types';

export interface AmbientMix {
  /** Layer levels 0…1, before each layer's trim and the ambient volume. */
  breeze: number;
  /** High wind: the wide view's air. */
  wind: number;
  /** Bird calls per second (day). */
  birdsRate: number;
  /** Night insects. */
  crickets: number;
  murmur: number;
  murmurPan: number;
  water: number;
  waterPan: number;
  traffic: number;
  trafficPan: number;
  /** 0 … 1 day, for traffic pass-bys. */
  day: number;
  /** Inside a building: the outdoor bed −9 dB through a 700 Hz lowpass, plus room tone. */
  interior: boolean;
  room: number;
}

export const SILENT_MIX: Readonly<AmbientMix> = Object.freeze({
  breeze: 0,
  wind: 0,
  birdsRate: 0,
  crickets: 0,
  murmur: 0,
  murmurPan: 0,
  water: 0,
  waterPan: 0,
  traffic: 0,
  trafficPan: 0,
  day: 1,
  interior: false,
  room: 0,
});

/** The outdoor bed inside a building: −9 dB. */
export const INTERIOR_OUTDOOR_GAIN = Math.pow(10, -9 / 20);
export const ROOM_TONE = 0.08;
/** A small town always has a few birds, even over rooftops. */
const GREEN_FLOOR = 0.1;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const clampPan = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0);

export function ambientMix(l: AudioListener | null, opts: { reduce?: boolean; exclude?: ReadonlySet<string> } = {}): AmbientMix {
  if (!l || opts.reduce) return { ...SILENT_MIX };
  const z = clamp01(l.zoom01);
  const night = clamp01(l.night);
  const day = 1 - night;
  const sources = opts.exclude?.size ? l.sources.filter((s) => !opts.exclude!.has(s.id)) : l.sources;

  let green = GREEN_FLOOR;
  let murmurSum = 0;
  let murmurPanSum = 0;
  let water = 0;
  let waterPan = 0;
  let road = 0;
  let trafficPan = 0;
  for (const s of sources) {
    const g = clamp01(s.gain);
    if (s.kind === 'green') green += g;
    else if (s.kind === 'field') green += 0.5 * g;
    else if (s.kind === 'murmur') {
      murmurSum += g;
      murmurPanSum += g * clampPan(s.pan);
    } else if (s.kind === 'water' && g > water) {
      water = g;
      waterPan = clampPan(s.pan);
    } else if (s.kind === 'road' && g > road) {
      road = g;
      trafficPan = clampPan(s.pan);
    }
  }
  green = clamp01(green);
  const live = l.paused ? 0 : 1;
  const interior = l.entered !== null || l.level === 'interior';
  return {
    breeze: (0.35 + 0.25 * (1 - z)) * (l.paused ? 0.5 : 1),
    wind: 0.25 * (1 - z) * (1 - z),
    birdsRate: 0.5 * day * green * (0.25 + 0.75 * z) * live,
    crickets: night * (0.35 + 0.65 * green) * live,
    murmur: Math.min(1, murmurSum) * (0.2 + 0.8 * z) * live,
    murmurPan: murmurSum > 0 ? clampPan(murmurPanSum / murmurSum) : 0,
    water: water * z,
    waterPan,
    traffic: (0.15 + 0.2 * (1 - z)) * (0.4 + 0.6 * day) * live,
    trafficPan,
    day,
    interior,
    room: interior ? ROOM_TONE : 0,
  };
}

/** One step of exponential smoothing toward `target` (τ in seconds). τ ≤ 0 jumps. */
export function smoothToward(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || dt <= 0) return tau <= 0 ? target : current;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}
