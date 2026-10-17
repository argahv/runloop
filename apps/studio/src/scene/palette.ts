import type { ExecState } from '@runloop-world/core';
import { Color } from 'three';
import { IDENTITY_HUES, identityIndex } from '../state/identity';

/**
 * Scene colours, derived from the design tokens in app/tokens.css (the only
 * colour source). The scene reads the tokens from the document, so the world
 * follows the theme; tests and SSR get the dark defaults below.
 *
 * Rules (docs/design/design-system.md, "The 3D world"): obsidian and graphite
 * architecture, desaturated zone tints, lime only for active execution,
 * semantic colours for outcomes, glow only on state-carrying elements.
 */

export type SceneTheme = 'dark' | 'light';

/** Token values the scene uses (CSS colour strings). */
export interface SceneTokens {
  obsidian: string;
  graphite: string;
  slate: string;
  slateHi: string;
  lime: string;
  ice: string;
  muted: string;
  success: string;
  warning: string;
  failure: string;
  worldBg: string;
  identity: string[];
  identityNeutral: string;
}

const TOKEN_NAMES: Record<Exclude<keyof SceneTokens, 'identity'>, string> = {
  obsidian: '--rl-obsidian',
  graphite: '--rl-graphite',
  slate: '--rl-slate',
  slateHi: '--rl-slate-hi',
  lime: '--rl-lime',
  ice: '--rl-ice',
  muted: '--rl-muted',
  success: '--rl-success',
  warning: '--rl-warning',
  failure: '--rl-failure',
  worldBg: '--rl-world-bg',
  identityNeutral: '--rl-id-neutral',
};

/** Dark-theme token values, used when no document is available. Keep in sync with tokens.css. */
export const DARK_TOKENS: SceneTokens = {
  obsidian: '#101114',
  graphite: '#1b1d22',
  slate: '#292c33',
  slateHi: '#33363e',
  lime: '#b8f36a',
  ice: '#e8ebf0',
  muted: '#9297a2',
  success: '#48c78e',
  warning: '#f5b84b',
  failure: '#ff6b76',
  worldBg: '#0c0d10',
  identity: ['#5aa9f5', '#e0946a', '#43c6d9', '#a08cf9', '#e67ccb', '#8fa4bf', '#c38bd9', '#cdb592'],
  identityNeutral: '#9297a2',
};

/** Read the scene tokens through a CSS custom-property getter (missing values fall back to dark). */
export function readTokens(get: (name: string) => string): SceneTokens {
  const out = { ...DARK_TOKENS, identity: [...DARK_TOKENS.identity] };
  for (const [key, name] of Object.entries(TOKEN_NAMES) as [keyof typeof TOKEN_NAMES, string][]) {
    const v = get(name).trim();
    if (v) out[key] = v;
  }
  for (let i = 0; i < IDENTITY_HUES; i++) {
    const v = get(`--rl-id-${i + 1}`).trim();
    if (v) out.identity[i] = v;
  }
  return out;
}

/** Current tokens from the document (dark defaults without one). */
export function documentTokens(): SceneTokens {
  if (typeof document === 'undefined') return DARK_TOKENS;
  const style = getComputedStyle(document.documentElement);
  return readTokens((name) => style.getPropertyValue(name));
}

export interface SceneLights {
  ambient: number;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  key: number;
  keyColor: string;
  fill: number;
  fillColor: string;
  env: number;
}

export interface ScenePalette {
  theme: SceneTheme;
  tokens: SceneTokens;
  /** Board base slab. */
  slabTop: string;
  slabSide: string;
  /** Hairline around the slab (tonal, not emissive). */
  slabEdge: string;
  /** Corridor and room floors (rooms are tinted per zone, see zoneFloor). */
  corridor: string;
  room: string;
  wall: string;
  wallCap: string;
  curb: string;
  /** Path inlays in the corridor floor. */
  inlay: string;
  metal: string;
  metalDark: string;
  metalLight: string;
  /** Machine screens that carry no state right now (unlit glass). */
  screenOff: string;
  robotShell: string;
  robotJoint: string;
  visor: string;
  /** Active execution only: working agent ring, running station. */
  active: string;
  success: string;
  warning: string;
  failure: string;
  /** Resolved incidents, idle details. */
  muted: string;
  /** Neutral light for "occupied" screens and selection rings. */
  ice: string;
  identity: readonly string[];
  identityNeutral: string;
  lights: SceneLights;
  /** Emissive glow (and bloom) is allowed: dark theme only, where light reads as light. */
  glow: boolean;
}

const luminance = (c: string) => {
  const col = new Color(c);
  return 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
};

/** Mix two colours (t = 0 → a, t = 1 → b) and return a hex string. */
export function mixHex(a: string, b: string, t: number): string {
  return `#${new Color(a).lerp(new Color(b), t).getHexString()}`;
}

/** Same hue, saturation scaled by `f` (0 = grey). */
export function desaturate(c: string, f: number): string {
  const col = new Color(c);
  const hsl = { h: 0, s: 0, l: 0 };
  col.getHSL(hsl);
  col.setHSL(hsl.h, hsl.s * f, hsl.l);
  return `#${col.getHexString()}`;
}

/** Build the scene palette from tokens. Pure: the theme follows the canvas token's lightness. */
export function buildPalette(t: SceneTokens): ScenePalette {
  const light = luminance(t.obsidian) > 0.5;
  if (light) {
    return {
      theme: 'light',
      tokens: t,
      slabTop: mixHex(t.obsidian, t.slateHi, 0.35),
      slabSide: mixHex(t.slateHi, t.muted, 0.35),
      slabEdge: mixHex(t.slateHi, t.muted, 0.2),
      corridor: mixHex(t.graphite, t.slate, 0.35),
      room: t.graphite,
      wall: t.slateHi,
      wallCap: mixHex(t.graphite, t.slate, 0.2),
      curb: t.slate,
      inlay: mixHex(t.obsidian, t.slateHi, 0.9),
      metal: mixHex(t.slateHi, t.muted, 0.28),
      metalDark: mixHex(t.slateHi, t.muted, 0.55),
      metalLight: mixHex(t.graphite, t.slate, 0.6),
      screenOff: mixHex(t.ice, t.muted, 0.25),
      robotShell: mixHex(t.slate, t.slateHi, 0.5),
      robotJoint: mixHex(t.slateHi, t.muted, 0.65),
      visor: t.ice,
      active: t.lime,
      success: t.success,
      warning: t.warning,
      failure: t.failure,
      muted: t.muted,
      ice: t.ice,
      identity: t.identity,
      identityNeutral: t.identityNeutral,
      // Tuned so top faces render close to their token colour and sides fall off (no tone mapping).
      lights: {
        ambient: 0.9,
        hemiSky: '#ffffff',
        hemiGround: mixHex(t.slateHi, t.muted, 0.5),
        hemi: 0.8,
        key: 1.6,
        keyColor: '#ffffff',
        fill: 0.3,
        fillColor: '#eef1f6',
        env: 0.25,
      },
      glow: false,
    };
  }
  return {
    theme: 'dark',
    tokens: t,
    slabTop: mixHex(t.obsidian, t.graphite, 0.3),
    slabSide: mixHex(t.worldBg, '#000000', 0.25),
    slabEdge: mixHex(t.slateHi, t.ice, 0.12),
    corridor: t.graphite,
    room: mixHex(t.graphite, t.slate, 0.3),
    wall: t.slate,
    wallCap: mixHex(t.slateHi, t.ice, 0.1),
    curb: mixHex(t.slate, t.graphite, 0.3),
    inlay: mixHex(t.graphite, t.slateHi, 0.75),
    metal: t.slateHi,
    metalDark: mixHex(t.slate, t.obsidian, 0.35),
    metalLight: mixHex(t.slateHi, t.muted, 0.35),
    screenOff: mixHex(t.obsidian, t.slate, 0.4),
    robotShell: mixHex(t.ice, t.muted, 0.08),
    robotJoint: mixHex(t.muted, t.slate, 0.35),
    visor: t.obsidian,
    active: t.lime,
    success: t.success,
    warning: t.warning,
    failure: t.failure,
    muted: t.muted,
    ice: t.ice,
    identity: t.identity,
    identityNeutral: t.identityNeutral,
    lights: {
      ambient: 0.75,
      hemiSky: '#dfe5ee',
      hemiGround: t.obsidian,
      hemi: 0.85,
      key: 2.4,
      keyColor: '#fff8ef',
      fill: 0.7,
      fillColor: '#c9d3e3',
      env: 0.45,
    },
    glow: true,
  };
}

/** Room floor colour: the zone's colour, desaturated, as a quiet tint of the floor. */
export function zoneFloor(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.room, desaturate(zoneColor, 0.35), p.theme === 'light' ? 0.16 : 0.11);
}

/** Wall tops: the wall colour with a trace of the room's tint. */
export function zoneCap(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.wallCap, desaturate(zoneColor, 0.4), p.theme === 'light' ? 0.3 : 0.14);
}

/** Small accents in a zone's colour (wall caps, pad outlines, signs): desaturated, never emissive. */
export function zoneAccent(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.wallCap, desaturate(zoneColor, 0.45), p.theme === 'light' ? 0.5 : 0.3);
}

/**
 * An agent's identity colour in the scene: the same --rl-id-N token the
 * timeline, roster and Network view use (state/identity.ts decides N).
 */
export function identityHex(p: ScenePalette, exec: ExecState, agentId: string): string {
  const i = identityIndex(exec, agentId);
  return i === null ? p.identityNeutral : (p.identity[i - 1] ?? p.identityNeutral);
}

/**
 * A colour for a state-carrying emissive element. In the dark theme it is
 * pushed above 1.0 so it glows (and blooms on high quality); in the light
 * theme it stays a flat colour, because glow does not read on a light canvas.
 */
export function stateGlow(p: ScenePalette, c: string, intensity = 1.6): Color {
  return new Color(c).multiplyScalar(p.glow ? intensity : 1);
}

/** Mix two colours (t = 0 → a, t = 1 → b). */
export function mix(a: string, b: string, t: number): Color {
  return new Color(a).lerp(new Color(b), t);
}
