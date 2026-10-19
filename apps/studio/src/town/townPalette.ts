/**
 * The town's materials (render draft §4 "Style rules"): a warm, bright world
 * of cream and peach walls, terracotta and teal roofs, sage grass and blue
 * water. Buildings take their wall, roof, trim and sign colours from the town
 * file; everything else is here.
 *
 * Rules:
 * - The Signature lime never appears in town materials (palette.test.ts keeps
 *   every daylight colour at CIEDE2000 ≥ 12 from it and from the semantic
 *   success/warning/failure colours).
 * - Only state glows: lit windows (occupied), signs (open), street lamps at
 *   night (the clock), agent beacons (connection). Glow colours are in GLOW.
 * - The theme never changes the town, the land beyond it or the time of day;
 *   it changes the chrome and the labels only.
 */

import { buildPalette, DARK_TOKENS, type ScenePalette, type SceneTokens } from '../scene/palette';

export const LIME = '#b8f36a';
export const SEMANTIC = { success: '#48c78e', warning: '#f5b84b', failure: '#ff6b76' } as const;

export const GROUND_COLORS = {
  /** Fallback grass when a cell has no district. */
  grass: '#a7c08b',
  park: '#9bbb7e',
  parkDark: '#86ad70',
  gardenSoil: '#9a7656',
  gardenRow: '#7fa463',
  water: '#6aa6c6',
  waterDeep: '#5a92b6',
  waterEdge: '#c9bea4',
  asphalt: '#646a74',
  asphaltDark: '#5a5f69',
  laneMark: '#efe6cf',
  sidewalk: '#e2d8c6',
  sidewalkJoint: '#d3c8b4',
  curb: '#c4b9a5',
  crosswalk: '#f3eee2',
  plazaA: '#e9dfcb',
  plazaB: '#dccfb6',
  path: '#d6c39b',
  footprint: '#cfc2ab',
  landmarkBase: '#d2c6af',
  /** Soil under lawns and gardens (curb faces). */
  soil: '#8c6c50',
  soilDark: '#6f553f',
} as const;

export const DECO_COLORS = {
  leafA: '#6f9e5a',
  leafB: '#5f9150',
  leafC: '#80ad62',
  coneA: '#4f8a5b',
  coneB: '#5d9a66',
  blossomA: '#f0b5c2',
  blossomB: '#e79db1',
  trunk: '#8a6446',
  bush: '#6a9957',
  bushDark: '#5b8a4b',
  flowerRed: '#eaa08f',
  flowerGold: '#f3dc9a',
  flowerViolet: '#b996d6',
  flowerWhite: '#f6f1e7',
  reeds: '#8ea76c',
  lampPost: '#454c57',
  lampHead: '#efe6d2',
  planter: '#b88a68',
  hydrant: '#c4553e',
  mailbox: '#3f6fa0',
  bikeRack: '#6d7581',
  parasolCloth: '#efe4d2',
  crate: '#b08a5e',
  signWood: '#8a6446',
  signPlate: '#f2e8d2',
  fence: '#f4ece0',
  fenceShade: '#ddd3c4',
  bench: '#9a6f4c',
  benchLeg: '#4c525c',
} as const;

export const LANDMARK_COLORS = {
  stone: '#d9cdb5',
  stoneDark: '#c3b69b',
  roofSlate: '#5d6b78',
  clockFace: '#f8f3e7',
  clockHand: '#2d2a26',
  fountainWater: '#82bad4',
  boardFrame: '#4a5160',
  boardFace: '#2e3644',
  bronze: '#8f7a5a',
} as const;

/** Building details that the town file does not set. */
export const BUILDING_COLORS = {
  windowDay: '#8eaec4',
  windowUnlit: '#46566a',
  door: '#7a5a42',
  doorstep: '#cbbda5',
  chimney: '#b2765a',
  awningCream: '#f6eedf',
  /** Base course at the foot of every wall. */
  plinth: '#bba98f',
  greenhouseGlass: '#cfe6df',
} as const;

/**
 * The agent headquarters keeps the Signature look (obsidian and graphite), so
 * a real agent's house reads as Runloop's at a glance. Its only lime is the
 * state beacon while the agent works (not in this list).
 */
export const AGENT_HQ_COLORS = {
  shell: '#5d636e',
  shellLight: '#727986',
  glass: '#93acc8',
  trim: '#33373f',
  roof: '#c3c7cd',
  forecourt: '#c8ccd2',
  pad: '#9aa1ab',
} as const;

/**
 * The run diorama inside an agent's headquarters (scene/ components at half
 * scale), in town materials: pale HQ greys with zone-tinted rooms, matte and
 * lit by the town's own sun and sky. Fixed, like the rest of the town: the
 * theme never repaints it (the standalone Live World page keeps the token
 * palette). Lime and the semantic colours stay for state only.
 */
export const HQ_DIORAMA_TOKENS: SceneTokens = {
  // About the HQ's roof grey (light enough for the matte branch), with darker room greys, so floors under the
  // midday sun stay grey (not white) and rooms keep their tint.
  obsidian: '#bec3ca',
  graphite: '#dde1e6',
  slate: '#8d95a0',
  slateHi: '#a5acb6',
  lime: LIME,
  ice: '#16181d',
  muted: AGENT_HQ_COLORS.shell,
  success: SEMANTIC.success,
  warning: SEMANTIC.warning,
  failure: SEMANTIC.failure,
  worldBg: AGENT_HQ_COLORS.forecourt,
  identity: [...DARK_TOKENS.identity],
  identityNeutral: DARK_TOKENS.identityNeutral,
};

/** The diorama's palette: matte (light branch), with rooms taking over half their zone's colour so they read under the sun. */
export function hqDioramaPalette(): ScenePalette {
  return { ...buildPalette(HQ_DIORAMA_TOKENS), zoneTint: 0.55 };
}

/** Resident details that are not part of an outfit. */
export const RESIDENT_COLORS = {
  shoe: '#3a3330',
  eye: '#2a2522',
  apron: '#f4ecdc',
  bag: '#7a5a42',
} as const;

/** Colours that glow (state only). Never compared with lime: they are light, not material. */
export const GLOW = {
  window: '#ffd18a',
  lamp: '#ffd89a',
  sign: '#fff1d6',
} as const;

/** Every daylight material colour (for the ΔE test). */
export function daylightMaterials(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (prefix: string, o: Record<string, string>) => {
    for (const [k, v] of Object.entries(o)) out[`${prefix}.${k}`] = v;
  };
  add('ground', GROUND_COLORS);
  add('deco', DECO_COLORS);
  add('landmark', LANDMARK_COLORS);
  add('building', BUILDING_COLORS);
  add('agentHq', AGENT_HQ_COLORS);
  add('resident', RESIDENT_COLORS);
  return out;
}
