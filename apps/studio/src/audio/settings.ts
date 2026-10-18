/**
 * Sound settings: defaults, parsing (every field clamped, anything unreadable
 * falls back to its default), and per-viewer persistence in localStorage
 * `runloop.audio.v1`. Storage can be missing or throw (private windows,
 * blocked site data): reads fall back to the defaults, writes are skipped.
 */
import type { AudioSettings } from './types';

export const AUDIO_SETTINGS_KEY = 'runloop.audio.v1';

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = Object.freeze({
  enabled: true,
  master: 0.6,
  ambient: 0.5,
  ui: 0.4,
  events: 0.7,
  reduce: false,
});

const VOLUMES = ['master', 'ambient', 'ui', 'events'] as const;
const FLAGS = ['enabled', 'reduce'] as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A complete, clamped settings object from anything (unknown fields are dropped). */
export function parseAudioSettings(raw: unknown, base: AudioSettings = DEFAULT_AUDIO_SETTINGS): AudioSettings {
  const out: AudioSettings = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of VOLUMES) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(clamp01(v) * 100) / 100;
  }
  for (const k of FLAGS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  return out;
}

/** Merge a partial update into settings (clamped). */
export function mergeAudioSettings(s: AudioSettings, p: Partial<AudioSettings>): AudioSettings {
  return parseAudioSettings(p, s);
}

export function sameAudioSettings(a: AudioSettings, b: AudioSettings): boolean {
  return VOLUMES.every((k) => a[k] === b[k]) && FLAGS.every((k) => a[k] === b[k]);
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadAudioSettings(storage: ReadStorage | null = defaultStorage()): AudioSettings {
  if (!storage) return { ...DEFAULT_AUDIO_SETTINGS };
  try {
    const raw = storage.getItem(AUDIO_SETTINGS_KEY);
    return raw ? parseAudioSettings(JSON.parse(raw) as unknown) : { ...DEFAULT_AUDIO_SETTINGS };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

/** Returns false when the settings could not be stored (they still apply for this page). */
export function saveAudioSettings(s: AudioSettings, storage: WriteStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(parseAudioSettings(s)));
    return true;
  } catch {
    return false;
  }
}

/**
 * A slider (0…1) to a gain. Squared, a rough loudness taper: half-way is
 * −12 dB, so the low half of the slider stays usable for a quiet bed.
 */
export function sliderGain(v: number): number {
  const c = clamp01(v);
  return c * c;
}

/** dB of a linear gain (−Infinity for 0). */
export function toDb(g: number): number {
  return g > 0 ? 20 * Math.log10(g) : -Infinity;
}
