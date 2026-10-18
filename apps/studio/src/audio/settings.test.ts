import { describe, expect, it } from 'vitest';
import { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS, loadAudioSettings, mergeAudioSettings, parseAudioSettings, saveAudioSettings, sliderGain } from './settings';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}
const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('audio settings', () => {
  it('defaults: on, master 0.6, ambient 0.5, UI 0.4, events 0.7, not reduced', () => {
    expect(DEFAULT_AUDIO_SETTINGS).toEqual({ enabled: true, master: 0.6, ambient: 0.5, ui: 0.4, events: 0.7, reduce: false });
    expect(loadAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('clamps volumes, ignores junk and unknown fields', () => {
    expect(parseAudioSettings({ master: 2, ambient: -1, ui: Number.NaN, events: '0.3', reduce: 'yes', enabled: false, extra: 1 })).toEqual({
      ...DEFAULT_AUDIO_SETTINGS,
      master: 1,
      ambient: 0,
      enabled: false,
    });
    expect(parseAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings([1, 2])).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(mergeAudioSettings({ ...DEFAULT_AUDIO_SETTINGS, ui: 0.9 }, { master: 0.333 })).toEqual({ ...DEFAULT_AUDIO_SETTINGS, ui: 0.9, master: 0.33 });
  });

  it('persists per viewer in runloop.audio.v1 and reads it back', () => {
    const st = memoryStorage();
    const s = { ...DEFAULT_AUDIO_SETTINGS, master: 0.25, reduce: true, enabled: false };
    expect(saveAudioSettings(s, st)).toBe(true);
    expect(JSON.parse(st.map.get(AUDIO_SETTINGS_KEY)!)).toEqual(s);
    expect(loadAudioSettings(st)).toEqual(s);
  });

  it('survives storage that throws or holds corrupt data', () => {
    expect(loadAudioSettings(throwing)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(saveAudioSettings(DEFAULT_AUDIO_SETTINGS, throwing)).toBe(false);
    const st = memoryStorage();
    st.map.set(AUDIO_SETTINGS_KEY, '{not json');
    expect(loadAudioSettings(st)).toEqual(DEFAULT_AUDIO_SETTINGS);
    st.map.set(AUDIO_SETTINGS_KEY, JSON.stringify({ ui: 0.1 }));
    expect(loadAudioSettings(st)).toEqual({ ...DEFAULT_AUDIO_SETTINGS, ui: 0.1 });
  });

  it('slider taper: 0 is silent, half is −12 dB, full is unity', () => {
    expect(sliderGain(0)).toBe(0);
    expect(20 * Math.log10(sliderGain(0.5))).toBeCloseTo(-12.04, 1);
    expect(sliderGain(1)).toBe(1);
    expect(sliderGain(3)).toBe(1);
  });
});
