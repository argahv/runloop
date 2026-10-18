'use client';
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import { BackSide, CanvasTexture, Color, Fog, Mesh, MeshLambertMaterial, RepeatWrapping, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from 'three';
import { hexToRgb } from './color';
import { useTown } from './context';
import { timed } from './perf';
import { buildClouds } from './geometry/surroundMeshes';
import { CLOUD_TILE } from './townMaterial';

const srgb = (hex: string, out: Vector3) => {
  const [r, g, b] = hexToRgb(hex);
  return out.set(r, g, b);
};

/**
 * The sky dome: a gradient from the zenith to the horizon (sim time, sky.ts),
 * the haze the land fades into below it, the sun's glow and, at night, stars.
 * Colours are display (sRGB) values mixed exactly like three's fog, so the
 * hazy land and the sky meet without a seam.
 */
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  // The haze band at the horizon, and haze below it (where the land is).
  col = mix(uHaze, col, smoothstep(-0.005, 0.11, h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 900.0) * 0.9 + pow(s, 24.0) * 0.12) * uSunVis * smoothstep(-0.02, 0.04, h);
  if (uStars > 0.01 && h > 0.0) {
    vec3 p = d * 150.0;
    vec3 c = floor(p);
    float r = hash3(c);
    if (r > 0.993) {
      vec3 f = fract(p) - 0.5;
      float st = smoothstep(0.16, 0.0, length(f)) * uStars * smoothstep(0.03, 0.25, h);
      col += vec3(0.95, 0.96, 1.0) * st * (0.75 + 0.25 * sin(uTime * 1.7 + r * 90.0));
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Cloud drift and fading: clouds wrap around a tile, fade near its edge and when nearer than the camera's target (never in the way). */
const CLOUD_VERT_HEAD = /* glsl */ `
attribute vec3 aCenter;
uniform vec2 uDrift;
uniform float uCamDist;
varying float vCloudFade;
`;
const CLOUD_VERT_BODY = /* glsl */ `
vec2 wrapped = mod(aCenter.xz + uDrift + ${(CLOUD_TILE / 2).toFixed(1)}, ${CLOUD_TILE.toFixed(1)}) - ${(CLOUD_TILE / 2).toFixed(1)};
transformed.xz += wrapped - aCenter.xz;
float edge = max(abs(wrapped.x), abs(wrapped.y));
float camD = distance(cameraPosition, vec3(wrapped.x, aCenter.y, wrapped.y));
vCloudFade = smoothstep(${(CLOUD_TILE / 2).toFixed(1)}, ${(CLOUD_TILE / 2 - 90).toFixed(1)}, edge) * smoothstep(0.8 * uCamDist, 1.15 * uCamDist + 40.0, camD);
`;

/** Soft footprints of the clouds on a tiling texture (red = shade), sampled by the ground and the land. */
function cloudShadowTexture(clouds: { x: number; z: number; r: number }[]): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const k = size / CLOUD_TILE;
  for (const cl of clouds) {
    for (const ox of [-size, 0, size])
      for (const oz of [-size, 0, size]) {
        const x = (cl.x + CLOUD_TILE / 2) * k + ox;
        const y = (cl.z + CLOUD_TILE / 2) * k + oz;
        const r = cl.r * k;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(255,0,0,0.95)');
        grad.addColorStop(0.55, 'rgba(255,0,0,0.6)');
        grad.addColorStop(1, 'rgba(255,0,0,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(x, y, r * 1.25, r * 0.85, 0, 0, Math.PI * 2);
        g.fill();
      }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

const tmpColor = new Color();

/**
 * Sky, haze and clouds (contract §3): the dome and the scene fog follow sim
 * time; clouds drift with the wind and cast soft shadows while the world runs
 * (still when it is paused, static under reduced motion, six static clouds
 * and no shadows on lite).
 */
export const Atmosphere = memo(function Atmosphere({ lite, ambient }: { lite: boolean; ambient: boolean }) {
  const { frame, cam, uniforms, surround } = useTown();
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const lastMinute = useRef(-1);

  const sky = useMemo(() => {
    const geo = new SphereGeometry(1, 32, 16);
    const mat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        uZenith: { value: new Vector3() },
        uHorizon: { value: new Vector3() },
        uHaze: { value: new Vector3() },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Vector3(1, 0.95, 0.85) },
        uSunVis: { value: 1 },
        uStars: { value: 0 },
        uTime: { value: 0 },
      },
    });
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
  }, []);

  const clouds = useMemo(() => {
    const built = buildClouds(lite ? 6 : 16, 7);
    const mat = new MeshLambertMaterial({
      color: '#ffffff',
      emissive: new Color('#ffffff'),
      emissiveIntensity: 0.35,
      flatShading: true,
    });
    const u = { uDrift: { value: new Vector2() }, uCamDist: { value: 200 } };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDrift = u.uDrift;
      shader.uniforms.uCamDist = u.uCamDist;
      shader.vertexShader = CLOUD_VERT_HEAD + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${CLOUD_VERT_BODY}`);
      shader.fragmentShader =
        'varying float vCloudFade;\n' +
        shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > vCloudFade) discard;',
        );
    };
    mat.customProgramCacheKey = () => 'town-clouds';
    const mesh = new Mesh(built.geometry, mat);
    mesh.frustumCulled = false;
    return {
      mesh,
      mat,
      u,
      defs: built.clouds,
      shadow: lite ? null : cloudShadowTexture(built.clouds),
    };
  }, [lite]);

  useEffect(() => {
    const prev = scene.fog;
    const fog = new Fog('#d3e0ea', 400, 800);
    scene.fog = fog;
    return () => {
      scene.fog = prev;
    };
  }, [scene]);

  useEffect(() => {
    const old = uniforms.uCloudTex.value;
    if (clouds.shadow) uniforms.uCloudTex.value = clouds.shadow;
    return () => {
      uniforms.uCloudTex.value = old;
      clouds.shadow?.dispose();
      clouds.mesh.geometry.dispose();
      clouds.mat.dispose();
    };
  }, [clouds, uniforms]);

  useEffect(() => {
    surround.add(sky);
    surround.add(clouds.mesh);
    return () => {
      surround.delete(sky);
      surround.delete(clouds.mesh);
    };
  }, [surround, sky, clouds]);

  useEffect(
    () => () => {
      sky.geometry.dispose();
      (sky.material as ShaderMaterial).dispose();
    },
    [sky],
  );

  useFrame(
    timed(() => {
      const s = frame.sky;
      if (!s) return;
      const u = (sky.material as ShaderMaterial).uniforms;
      // Colours follow sim time; parsing them every frame is waste, so only when the minute has moved.
      const recolor = Math.abs(frame.minute - lastMinute.current) >= 0.1;
      if (recolor) {
        lastMinute.current = frame.minute;
        srgb(s.zenith, u.uZenith!.value);
        srgb(s.horizon, u.uHorizon!.value);
        srgb(s.haze, u.uHaze!.value);
        srgb(s.sunColor, u.uSunColor!.value);
        clouds.mat.color.set(s.cloud);
        clouds.mat.emissive.copy(tmpColor.set(s.cloud)).multiplyScalar(0.55 - 0.3 * s.night);
      }
      u.uSunDir!.value.set(s.sunDir[0], s.sunDir[1], s.sunDir[2]);
      u.uSunVis!.value = 1 - s.night;
      u.uStars!.value = s.stars;
      u.uTime!.value = frame.ambientT;
      // The dome follows the camera, inside the far plane.
      sky.position.copy(camera.position);
      sky.scale.setScalar(cam.ctl.view.d * 0.5 + 700);
      sky.updateMatrixWorld();

      const fog = scene.fog as Fog | null;
      if (fog) {
        if (recolor) fog.color.set(s.haze);
        fog.near = cam.fogNear;
        fog.far = cam.fogFar;
      }

      // Clouds: drift with the wind (ambient time), lit like the sky, tinted at dawn and dusk.
      const t = ambient ? frame.ambientT : 0;
      const dx = t * 2.2;
      const dz = t * 0.7;
      clouds.u.uDrift.value.set(dx, dz);
      clouds.u.uCamDist.value = cam.ctl.view.d;
      // Shadows: where the sun throws the clouds' footprints (mean height 75), moving with the drift; none at night.
      const sy = Math.max(0.3, s.sunDir[1]);
      uniforms.uCloudOffset.value.set(dx - (s.sunDir[0] / sy) * 75, dz - (s.sunDir[2] / sy) * 75);
      uniforms.uCloudShadow.value = clouds.shadow ? 0.2 * (1 - s.night) : 0;
    }),
  );

  return (
    <>
      <primitive object={sky} />
      <primitive object={clouds.mesh} />
    </>
  );
});
