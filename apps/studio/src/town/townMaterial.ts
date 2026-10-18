/**
 * The static town's material: vertex-coloured Lambert plus a few uniforms the
 * renderer drives from world state (only state glows), and the atmosphere
 * (decorative: cloud shadows drifting over the ground, water shimmer):
 * - uNight (0 day … 1 night, from the sky): lamps, lit windows and open signs;
 * - uBld, one texel per building: r = occupied (windows lit), g = hidden (its
 *   interior is open), b = open now (its sign glows);
 * - uDim: the town dims while an interior is open;
 * - uFoliage: decoration with an optional rank above it is dropped (low quality);
 * - uCut: a rectangle of town cells (x0, y0, x1, y1, end-exclusive) whose
 *   anchored decoration (trees, props) is hidden: what stands in front of an
 *   open interior. x1 ≤ x0 hides nothing;
 * - uLiftBld / uRoofLift / uLiftBase / uWallsHidden: flying into a building,
 *   its roof (everything above uLiftBase) lifts 6 units and dissolves while its
 *   walls give way to the interior's cutaway;
 * - uCloudTex / uCloudOffset / uCloudShadow: soft cloud shadows on the ground
 *   (a tiling texture of the clouds' footprints, moved with the wind and the sun);
 * - uTime: ambient seconds (frozen while the world is paused or under reduced motion) for the water's shimmer.
 */
import { Color, DataTexture, MeshLambertMaterial, MeshStandardMaterial, RGBAFormat, RepeatWrapping, UnsignedByteType, Vector2, Vector4, type Material, type Side, type Texture } from 'three';
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
  uLiftBld: { value: number };
  uRoofLift: { value: number };
  uLiftBase: { value: number };
  uWallsHidden: { value: number };
  uCloudTex: { value: Texture };
  uCloudOffset: { value: Vector2 };
  uCloudShadow: { value: number };
  uTime: { value: number };
}

/** Size (scene units) of the tile the cloud-shadow texture covers. */
export const CLOUD_TILE = 1200;

/** A blank cloud-shadow texture until the clouds are built. */
function blankCloudTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.needsUpdate = true;
  return t;
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
    uLiftBld: { value: 0 },
    uRoofLift: { value: 0 },
    uLiftBase: { value: 0 },
    uWallsHidden: { value: 0 },
    uCloudTex: { value: blankCloudTexture() },
    uCloudOffset: { value: new Vector2() },
    uCloudShadow: { value: 0 },
    uTime: { value: 0 },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec4 aMeta;
uniform sampler2D uBld;
uniform vec4 uCut;
uniform float uTownW;
uniform float uLiftBld;
uniform float uRoofLift;
uniform float uLiftBase;
varying float vGlowKind;
varying float vOpt;
varying float vCut;
varying float vLift;
varying vec3 vBldState;
varying vec3 vTownWorld;
`;

const VERT_BODY = /* glsl */ `
vLift = 0.0;
if (uLiftBld > 0.5 && abs(aMeta.y - uLiftBld) < 0.5) {
  if (transformed.y > uLiftBase) {
    transformed.y += 6.0 * uRoofLift * uRoofLift * (3.0 - 2.0 * uRoofLift);
    vLift = 1.0;
  } else {
    vLift = 2.0;
  }
}
vTownWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
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
uniform float uRoofLift;
uniform float uWallsHidden;
uniform sampler2D uCloudTex;
uniform vec2 uCloudOffset;
uniform float uCloudShadow;
varying float vLift;
varying vec3 vTownWorld;
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
if (vLift > 1.5 && uWallsHidden > 0.5) discard;
if (vLift > 0.5 && vLift < 1.5 && fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) < uRoofLift) discard;
if ((vBldState.g > 0.5 && vLift < 0.5) || vCut > 0.5) discard;
diffuseColor.rgb *= 1.0 - uCloudShadow * texture2D(uCloudTex, (vTownWorld.xz - uCloudOffset) / ${CLOUD_TILE.toFixed(1)} + 0.5).r;
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

/** The pond, the Brook and the lake: a soft sheen from the sun, shimmering while the world runs. */
export function createWaterMaterial(u: TownUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.16, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  patch(m, u, 'town-water');
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    base.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform float uNight;', 'uniform float uNight;\nuniform float uTime;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
vec2 wp = vTownWorld.xz;
float r1 = sin(wp.x * 1.7 + wp.y * 0.9 + uTime * 1.3) + sin(wp.x * -0.8 + wp.y * 2.1 + uTime * 1.7);
float r2 = sin(wp.x * 2.6 - wp.y * 1.4 - uTime * 2.1) + sin(wp.y * 3.1 + uTime * 0.9);
normal = normalize(normal + vec3(r1, 0.0, r2) * 0.045);
// By night the water goes slate, not electric blue under the moon's blue sky light.
vec3 waterGrey = vec3(dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2)));
diffuseColor.rgb = mix(diffuseColor.rgb, waterGrey * vec3(0.75, 0.85, 0.95), uNight * 0.75);`,
      );
  };
  return m;
}

/**
 * The land beyond the town (terrain and trees): vertex-coloured Lambert with
 * the same cloud shadows as the town's ground. `instanced` for the trees.
 */
export function createLandMaterial(u: TownUniforms, instanced: boolean): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudTex = u.uCloudTex;
    shader.uniforms.uCloudOffset = u.uCloudOffset;
    shader.uniforms.uCloudShadow = u.uCloudShadow;
    shader.uniforms.uDim = u.uDim;
    shader.vertexShader =
      'varying vec3 vLandWorld;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 landWp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
landWp = instanceMatrix * landWp;
#endif
vLandWorld = (modelMatrix * landWp).xyz;`,
      );
    shader.fragmentShader =
      'varying vec3 vLandWorld;\nuniform sampler2D uCloudTex;\nuniform vec2 uCloudOffset;\nuniform float uCloudShadow;\nuniform float uDim;\n' +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= 1.0 - uCloudShadow * texture2D(uCloudTex, (vLandWorld.xz - uCloudOffset) / ${CLOUD_TILE.toFixed(1)} + 0.5).r;`,
        )
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= 1.0 - 0.42 * uDim;');
  };
  m.customProgramCacheKey = () => `land-${instanced}`;
  return m;
}
