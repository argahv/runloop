/**
 * Day and night from the world clock (DL-011: the sky follows sim time, the
 * theme never changes it). Pure: keyframes at 04:30, 05:30, 07:00, 12:00,
 * 17:30, 19:30 and 22:00, interpolated per minute (and wrapping at midnight),
 * plus a sun that rises in the east, stands south at noon and sets in the west.
 *
 * Scene axes: +x east, +y up, +z south (town rows grow southward).
 */
import { hexToRgb, rgbToHex } from './color';

export interface Sky {
  /** Unit vector from the ground towards the key light (sun by day, moon by night). */
  sunDir: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  ambient: number;
  ambientColor: string;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  /** 0 = full day … 1 = full night: drives lit windows, lamps and signs. */
  night: number;
}

interface Key {
  m: number;
  sunColor: string;
  sun: number;
  ambient: number;
  ambientColor: string;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  night: number;
}

/** Keyframes in minutes of day (ascending). Between 22:00 and 04:30 it is full night. */
const KEYS: readonly Key[] = [
  { m: 270, sunColor: '#9fb2ff', sun: 0.55, ambient: 0.4, ambientColor: '#8ea0d8', hemiSky: '#4d5f96', hemiGround: '#1d1f2e', hemi: 0.75, night: 1 },
  { m: 330, sunColor: '#ffb385', sun: 0.6, ambient: 0.45, ambientColor: '#b2a7c8', hemiSky: '#7a7fb0', hemiGround: '#352c33', hemi: 0.8, night: 0.8 },
  { m: 420, sunColor: '#ffd3a4', sun: 2.3, ambient: 0.45, ambientColor: '#fff1e2', hemiSky: '#bccfe6', hemiGround: '#6c5a48', hemi: 0.72, night: 0.1 },
  { m: 720, sunColor: '#fff5e6', sun: 3.0, ambient: 0.45, ambientColor: '#ffffff', hemiSky: '#d2e4f4', hemiGround: '#8a7a62', hemi: 0.75, night: 0 },
  { m: 1050, sunColor: '#ffdcae', sun: 2.6, ambient: 0.45, ambientColor: '#fff3e6', hemiSky: '#c7d5e8', hemiGround: '#7c6650', hemi: 0.74, night: 0.02 },
  { m: 1170, sunColor: '#ff9c6e', sun: 1.0, ambient: 0.47, ambientColor: '#d8b8c4', hemiSky: '#8a82b4', hemiGround: '#40343c', hemi: 0.8, night: 0.6 },
  { m: 1320, sunColor: '#9fb2ff', sun: 0.55, ambient: 0.4, ambientColor: '#8ea0d8', hemiSky: '#4d5f96', hemiGround: '#1d1f2e', hemi: 0.75, night: 1 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpHex = (a: string, b: string, t: number) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]);
};
/** Smoothstep easing, so the light never changes slope abruptly at a keyframe. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Sun direction for a (fractional) minute of day; null when it is below the horizon. */
export function sunDirection(minute: number): [number, number, number] | null {
  // 06:00 → east, 12:00 → south and highest, 18:00 → west (a little later in summer: 05:45–18:45).
  const a = ((minute - 345) / 780) * Math.PI;
  if (a <= 0 || a >= Math.PI) return null;
  const elev = Math.sin(a);
  const x = Math.cos(a);
  const v: [number, number, number] = [x * 0.9, 0.2 + elev * 1.1, 0.55 + 0.25 * elev];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Moonlight comes from a fixed high north-west-ish direction (still lighting the south faces a little). */
const MOON: [number, number, number] = (() => {
  const v: [number, number, number] = [-0.35, 0.85, 0.4];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
})();

/** The sky at a (fractional) minute of day, 0 ≤ minute < 1440 (values outside wrap). */
export function skyAt(minuteOfDay: number): Sky {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  let a = KEYS[KEYS.length - 1]!;
  let b = KEYS[0]!;
  let span = b.m + 1440 - a.m;
  let t = (m >= a.m ? m - a.m : m + 1440 - a.m) / span;
  for (let i = 0; i + 1 < KEYS.length; i++) {
    if (m >= KEYS[i]!.m && m < KEYS[i + 1]!.m) {
      a = KEYS[i]!;
      b = KEYS[i + 1]!;
      span = b.m - a.m;
      t = (m - a.m) / span;
      break;
    }
  }
  const k = ease(t);
  const night = lerp(a.night, b.night, k);
  // The key light blends from the moon (night 1) to the sun (night 0); below the horizon it is the moon.
  const sun = sunDirection(m);
  // Fades in from the horizon, so the key light never jumps when the sun rises or sets.
  const w = sun ? Math.min(1, Math.max(0, 1 - night)) * Math.min(1, Math.max(0, (sun[1] - 0.18) / 0.25)) : 0;
  const dir: [number, number, number] = sun
    ? [lerp(MOON[0], sun[0], w), lerp(MOON[1], sun[1], w), lerp(MOON[2], sun[2], w)]
    : [...MOON];
  const n = Math.hypot(...dir);
  return {
    sunDir: [dir[0] / n, dir[1] / n, dir[2] / n],
    sunColor: lerpHex(a.sunColor, b.sunColor, k),
    sunIntensity: lerp(a.sun, b.sun, k),
    ambient: lerp(a.ambient, b.ambient, k),
    ambientColor: lerpHex(a.ambientColor, b.ambientColor, k),
    hemiSky: lerpHex(a.hemiSky, b.hemiSky, k),
    hemiGround: lerpHex(a.hemiGround, b.hemiGround, k),
    hemi: lerp(a.hemi, b.hemi, k),
    night,
  };
}

/** Rough perceived brightness of a sky (for tests and tuning): key plus ambient light. */
export function skyBrightness(s: Sky): number {
  const lum = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return s.sunIntensity * lum(s.sunColor) * Math.max(0, s.sunDir[1]) + s.ambient * lum(s.ambientColor) + s.hemi * 0.5 * (lum(s.hemiSky) + lum(s.hemiGround));
}
