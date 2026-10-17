import { Color } from 'three';

/** Scene colours: dark slate base, cyan/purple neon, amber accents. */
export const PALETTE = {
  slabTop: '#121a29',
  slabSide: '#0a0f19',
  tile: '#1b2436',
  corridorTile: '#161e2e',
  wall: '#1d2739',
  wallTop: '#2b3850',
  curb: '#253149',
  track: '#080c15',
  metal: '#323e55',
  metalDark: '#1c2536',
  metalLight: '#4a5874',
  rim: '#f59e0b',
  cyan: '#22d3ee',
  purple: '#a78bfa',
  amber: '#f59e0b',
  ok: '#34d399',
  err: '#f43f5e',
  warn: '#fbbf24',
  resolved: '#64748b',
  robotShell: '#eef2f8',
  robotJoint: '#9aa7bd',
  visor: '#070b16',
} as const;

/** A colour pushed above 1.0 so it glows (and blooms) on toneMapped={false} materials. */
export function glow(c: string | Color, intensity = 1.8): Color {
  return new Color(c).multiplyScalar(intensity);
}

/** Mix two hex colours (t = 0 → a, t = 1 → b). */
export function mix(a: string, b: string, t: number): Color {
  return new Color(a).lerp(new Color(b), t);
}
