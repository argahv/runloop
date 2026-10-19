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
  /** Warm key light from the south-west, high: lights tops and south faces (the left side on screen). */
  key: number;
  keyColor: string;
  /** Cool rim from the north-east, low: east faces (the right side on screen) and top edges. */
  rim: number;
  rimColor: string;
  /** Image-based reflections for glossy shells and glass. */
  env: number;
}

export interface ScenePalette {
  theme: SceneTheme;
  tokens: SceneTokens;
  /** Board base slab (top shows as the grout between tiles and the margin). */
  slabTop: string;
  slabSide: string;
  /** Hairline around the slab (tonal, not emissive). */
  slabEdge: string;
  /** Soft shadow the board casts on the stage (opacity; 0 = none). */
  boardShadow: number;
  /** Corridor and room floors (rooms are tinted per zone, see zoneFloor). */
  corridor: string;
  room: string;
  /** How far floor tiles vary in tone (0–1). */
  tileVariation: number;
  /** Contact darkening of floor tiles next to walls and machines (0–1). */
  occlusion: number;
  wall: string;
  wallCap: string;
  curb: string;
  /** Shade at the foot of walls and the slab (vertex gradient; 1 = none). */
  wallFoot: number;
  /** Walkways between the Atrium and each environment, at rest. */
  path: string;
  metal: string;
  metalDark: string;
  metalLight: string;
  /** Machine screens that carry no state right now (unlit glass). */
  screenOff: string;
  robotShell: string;
  robotJoint: string;
  /** The robots' visor: dark glass in both themes, so the eyes always read as light. */
  visor: string;
  /** Eye colours on the dark visor (the dark-theme semantic values, which are made for dark surfaces). */
  eyes: { idle: string; active: string; success: string; warning: string; failure: string; off: string };
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
  /** How much of its zone's colour a room floor takes (default by theme; the in-town diorama sets more). */
  zoneTint?: number;
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

const VISOR_EYES = (t: SceneTokens) => ({
  idle: DARK_TOKENS.ice,
  active: DARK_TOKENS.lime,
  success: DARK_TOKENS.success,
  warning: DARK_TOKENS.warning,
  failure: DARK_TOKENS.failure,
  off: mixHex(DARK_TOKENS.muted, t.obsidian, 0.1),
});

/**
 * Build the scene palette from tokens. Pure: the theme follows the canvas
 * token's lightness. Dark: an obsidian diorama under a warm key and a cool
 * rim. Light: the same model in pale, matte materials (an architectural
 * maquette), so it belongs to the light interface instead of sitting in it
 * as a dark box.
 */
export function buildPalette(t: SceneTokens): ScenePalette {
  const light = luminance(t.obsidian) > 0.5;
  const shared = {
    tokens: t,
    visor: mixHex(DARK_TOKENS.obsidian, '#000000', 0.2),
    eyes: VISOR_EYES(t),
    active: t.lime,
    success: t.success,
    warning: t.warning,
    failure: t.failure,
    muted: t.muted,
    ice: t.ice,
    identity: t.identity,
    identityNeutral: t.identityNeutral,
  };
  if (light) {
    return {
      ...shared,
      theme: 'light',
      // A white maquette on a pale grey plinth: floors a step darker than the walls, so the walls and robots stand out.
      slabTop: mixHex(t.slateHi, t.muted, 0.18),
      slabSide: mixHex(t.slateHi, t.muted, 0.3),
      slabEdge: t.graphite,
      boardShadow: 0.22,
      corridor: mixHex(t.obsidian, t.slateHi, 0.55),
      room: mixHex(t.obsidian, t.slate, 0.3),
      tileVariation: 0.45,
      occlusion: 0.16,
      wall: t.graphite,
      wallCap: t.graphite,
      curb: mixHex(t.graphite, t.obsidian, 0.5),
      wallFoot: 0.78,
      path: mixHex(t.slateHi, t.muted, 0.35),
      metal: mixHex(t.slate, t.slateHi, 0.6),
      metalDark: mixHex(t.slateHi, t.muted, 0.45),
      metalLight: t.graphite,
      screenOff: mixHex(t.ice, t.muted, 0.35),
      robotShell: t.graphite,
      robotJoint: mixHex(t.slateHi, t.muted, 0.6),
      // Lit like a white model on a desk, with the same warm/cool split as the dark scene.
      lights: {
        ambient: 0.4,
        hemiSky: '#ffffff',
        hemiGround: mixHex(t.slateHi, t.muted, 0.5),
        hemi: 0.85,
        key: 1.75,
        keyColor: '#fff0dc',
        rim: 0.9,
        rimColor: '#cfdcff',
        env: 0.35,
      },
      glow: false,
    };
  }
  return {
    ...shared,
    theme: 'dark',
    // Obsidian corridors, so the tinted rooms read as lit spaces.
    slabTop: mixHex(t.worldBg, t.obsidian, 0.5),
    slabSide: mixHex(t.graphite, t.slate, 0.35),
    slabEdge: mixHex(t.slateHi, t.ice, 0.18),
    boardShadow: 0,
    corridor: mixHex(t.graphite, t.obsidian, 0.45),
    room: mixHex(t.graphite, t.slate, 0.6),
    tileVariation: 0.6,
    occlusion: 0.32,
    wall: mixHex(t.slate, t.slateHi, 0.5),
    wallCap: mixHex(t.slateHi, t.ice, 0.06),
    curb: mixHex(t.slate, t.graphite, 0.2),
    wallFoot: 0.45,
    path: mixHex(t.slate, t.muted, 0.18),
    metal: t.slateHi,
    metalDark: mixHex(t.slate, t.obsidian, 0.35),
    metalLight: mixHex(t.slateHi, t.muted, 0.35),
    screenOff: mixHex(t.obsidian, t.slate, 0.4),
    robotShell: mixHex(t.ice, '#ffffff', 0.3),
    robotJoint: mixHex(t.muted, t.slate, 0.45),
    lights: {
      ambient: 0.15,
      hemiSky: '#a3b4d4',
      hemiGround: '#1a140e',
      hemi: 0.8,
      key: 3.3,
      keyColor: '#ffd3a3',
      rim: 2.0,
      rimColor: '#86a9ff',
      env: 0.5,
    },
    glow: true,
  };
}

/** Room floor colour: the zone's colour, desaturated, as a quiet tint of the floor. */
export function zoneFloor(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.room, desaturate(zoneColor, 0.45), p.zoneTint ?? (p.theme === 'light' ? 0.34 : 0.24));
}

/** Wall faces: the wall colour with a trace of the room's tint. */
export function zoneWall(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.wall, desaturate(zoneColor, 0.4), p.theme === 'light' ? 0.12 : 0.12);
}

/** Wall tops: the cap colour with more of the room's tint. */
export function zoneCap(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.wallCap, desaturate(zoneColor, 0.45), p.theme === 'light' ? 0.42 : 0.22);
}

/** Small accents in a zone's colour (pad outlines, signs): desaturated, never emissive. */
export function zoneAccent(p: ScenePalette, zoneColor: string): string {
  return mixHex(p.wallCap, desaturate(zoneColor, 0.55), p.theme === 'light' ? 0.6 : 0.42);
}

/**
 * A station screen at rest: dim glass in its environment's tint (it carries
 * no state, so it never glows past 1.0 and never blooms).
 */
export function zoneScreen(p: ScenePalette, zoneColor: string, lit: number): string {
  const tint = desaturate(zoneColor, 0.6);
  return p.theme === 'light' ? mixHex(mixHex(p.screenOff, '#ffffff', 0.4), tint, 0.25 + 0.2 * lit) : mixHex(p.screenOff, tint, 0.3 + 0.25 * lit);
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
