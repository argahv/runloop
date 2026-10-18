/**
 * The static town's material: vertex-coloured Lambert plus a few uniforms the
 * renderer drives from world state (only state glows):
 * - uNight (0 day … 1 night, from the sky): lamps, lit windows and open signs;
 * - uBld, one texel per building: r = occupied (windows lit), g = hidden (its
 *   interior is open), b = open now (its sign glows);
 * - uDim: the town dims while an interior is open;
 * - uFoliage: decoration with an optional rank above it is dropped (low quality);
 * - uCut: a rectangle of town cells (x0, y0, x1, y1, end-exclusive) whose
 *   anchored decoration (trees, props) is hidden: what stands in front of an
 *   open interior. x1 ≤ x0 hides nothing.
 */
import { Color, DataTexture, Vector4, MeshLambertMaterial, MeshStandardMaterial, RGBAFormat, UnsignedByteType, type Material, type Side, type Texture } from 'three';
import { BUILDING_COLORS, GLOW } from './townPalette';

export interface TownUniforms {
  uNight: { value: number };
  uDim: { value: number };
  uFoliage: { value: number };
  uCut: { value: Vector4 };
  uTownW: { value: number };
  uBld: { value: DataTexture };
  uGlowWindow: { value: Color };
  uGlowLamp: { value: Color };
  uGlowSign: { value: Color };
  uWindowDark: { value: Color };
}

/** Per-building state texture (RGBA8, one texel per building index). */
export function buildingStateTexture(count: number): DataTexture {
  const n = Math.max(1, count);
  const t = new DataTexture(new Uint8Array(n * 4), n, 1, RGBAFormat, UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function createTownUniforms(buildingCount: number, townWidth: number): TownUniforms {
  return {
    uNight: { value: 0 },
    uDim: { value: 0 },
    uFoliage: { value: 1 },
    uCut: { value: new Vector4(0, 0, 0, 0) },
    uTownW: { value: townWidth },
    uBld: { value: buildingStateTexture(buildingCount) },
    // Glow colours are pushed above 1 so lit windows read at night without bloom.
    uGlowWindow: { value: new Color(GLOW.window).multiplyScalar(1.15) },
    uGlowLamp: { value: new Color(GLOW.lamp).multiplyScalar(1.6) },
    uGlowSign: { value: new Color(GLOW.sign).multiplyScalar(0.55) },
    uWindowDark: { value: new Color(BUILDING_COLORS.windowUnlit) },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec4 aMeta;
uniform sampler2D uBld;
uniform vec4 uCut;
uniform float uTownW;
varying float vGlowKind;
varying float vOpt;
varying float vCut;
varying vec3 vBldState;
`;

const VERT_BODY = /* glsl */ `
vGlowKind = aMeta.x;
vOpt = aMeta.z;
vBldState = vec3(0.0);
if (aMeta.y > 0.5) vBldState = texelFetch(uBld, ivec2(int(aMeta.y + 0.5) - 1, 0), 0).rgb;
vCut = 0.0;
if (aMeta.w > 0.5) {
  float cellIdx = floor(aMeta.w + 0.5) - 1.0;
  float cy = floor((cellIdx + 0.5) / uTownW);
  float cx = cellIdx - cy * uTownW;
  if (cx >= uCut.x && cx < uCut.z && cy >= uCut.y && cy < uCut.w) vCut = 1.0;
}
`;

const FRAG_HEAD = /* glsl */ `
uniform float uNight;
uniform float uDim;
uniform float uFoliage;
uniform vec3 uGlowWindow;
uniform vec3 uGlowLamp;
uniform vec3 uGlowSign;
uniform vec3 uWindowDark;
varying float vGlowKind;
varying float vOpt;
varying float vCut;
varying vec3 vBldState;
vec3 townGlow;
`;

/** After the vertex colour is applied: discard hidden/optional fragments, darken unlit windows, pick the glow. */
const FRAG_COLOR = /* glsl */ `
if (vBldState.g > 0.5 || vCut > 0.5) discard;
if (vOpt > 0.0 && vOpt > uFoliage) discard;
townGlow = vec3(0.0);
if (vGlowKind > 0.5 && vGlowKind < 1.5) {
  // Window: warm when its building is occupied (faintly by day, fully at night), dark glass otherwise.
  float lit = vBldState.r;
  diffuseColor.rgb = mix(diffuseColor.rgb, uWindowDark, uNight * (1.0 - lit) * 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, uGlowWindow * 0.75, lit * (0.07 + 0.6 * uNight));
  townGlow = uGlowWindow * lit * uNight * 0.9;
} else if (vGlowKind > 1.5 && vGlowKind < 2.5) {
  townGlow = uGlowLamp * smoothstep(0.3, 0.7, uNight);
} else if (vGlowKind > 2.5) {
  townGlow = diffuseColor.rgb * uGlowSign * 2.0 * vBldState.b * uNight;
}
`;

const FRAG_END = /* glsl */ `
gl_FragColor.rgb *= 1.0 - 0.42 * uDim;
`;

/** Patch a material with the town's per-vertex state. `extra` adds uniforms (e.g. a sign atlas). */
function patch(m: Material, u: TownUniforms, key: string): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
    shader.fragmentShader =
      FRAG_HEAD +
      shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += townGlow;')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${FRAG_END}`);
  };
  m.customProgramCacheKey = () => key;
}

/** Ground, buildings and decoration. */
export function createTownMaterial(u: TownUniforms, side: Side): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true, side });
  patch(m, u, `town-static-${side}`);
  return m;
}

/** Shop signs: the atlas texture, glowing at night while open. */
export function createSignMaterial(u: TownUniforms, map: Texture): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true, map });
  patch(m, u, 'town-sign');
  return m;
}

/** The pond: a soft sheen from the sun. */
export function createWaterMaterial(u: TownUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.05 });
  patch(m, u, 'town-water');
  return m;
}
