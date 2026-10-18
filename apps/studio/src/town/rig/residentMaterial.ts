/**
 * The residents' shader rig (plan §5): MeshLambertMaterial patched so each
 * vertex rotates about its part's pivot with the same formulas as
 * `limbAngles` in residentRig.ts (the tested CPU reference). Per instance:
 * aInst = (anim, phase, style, dim flag) and the outfit colours.
 *
 * Angle conventions follow residentRig.ts: a positive limb pitch swings
 * forward (+z), a positive torso or head pitch leans forward.
 */
import { Color, MeshLambertMaterial } from 'three';
import { RESIDENT_COLORS } from '../townPalette';
import { ANIM, BODY, RESIDENT_HEIGHT } from './residentRig';

export interface ResidentUniforms {
  uTime: { value: number };
  uWalkPhase: { value: number };
  uWalkAmp: { value: number };
  uRig: { value: number };
  uDim: { value: number };
}

export function createResidentUniforms(): ResidentUniforms {
  return { uTime: { value: 0 }, uWalkPhase: { value: 0 }, uWalkAmp: { value: 0.6 }, uRig: { value: 1 }, uDim: { value: 0 } };
}

const f = (n: number) => n.toFixed(5);
const c3 = (hex: string) => {
  const c = new Color(hex);
  return `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;
};

const HEAD = /* glsl */ `
attribute float aPart;
attribute float aMat;
attribute vec4 aInst;
attribute vec3 aTop;
attribute vec3 aBottom;
attribute vec3 aSkin;
attribute vec3 aHair;
uniform float uTime;
uniform float uWalkPhase;
uniform float uWalkAmp;
uniform float uRig;
varying vec3 vResColor;
varying float vDimFlag;

vec3 rx(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 ry(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
vec3 rz(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }

// Pose (mirrors limbAngles): bob, drop, bodyPitch, torsoPitch, torsoRoll, headPitch, headYaw, armL, armR, armSpread, legL, legR.
float pBob, pDrop, pBody, pTorsoP, pTorsoR, pHeadP, pHeadY, pArmL, pArmR, pSpread, pLegL, pLegR;
bool pSeated;

void evalPose(float anim, float ph) {
  float tt = uRig > 0.5 ? uTime : 0.0;
  pBob = 0.0; pDrop = 0.0; pBody = 0.0; pTorsoP = 0.0; pTorsoR = 0.0; pHeadP = 0.0; pHeadY = 0.0;
  pArmL = 0.0; pArmR = 0.0; pSpread = 0.0; pLegL = 0.0; pLegR = 0.0; pSeated = false;
  float seatDrop = ${f(BODY.hipY - BODY.seatY)};
  if (anim < ${ANIM.walk}.5 && anim > ${ANIM.walk}.0 - 0.5) {
    float w = uWalkPhase + ph;
    pBob = 0.03 * abs(sin(w));
    if (uRig > 0.5) {
      pLegL = uWalkAmp * sin(w); pLegR = -pLegL;
      pArmL = -0.8 * uWalkAmp * sin(w); pArmR = -pArmL;
      pTorsoP = 0.06; pTorsoR = 0.035 * sin(w);
    }
  } else if (anim < ${ANIM.idle}.5) {
    pTorsoP = 0.02 * sin(tt * 1.6 + ph); pTorsoR = 0.03 * sin(tt * 0.4 + ph); pHeadY = 0.3 * sin(tt * 0.23 + ph * 2.0);
    pArmL = 0.06; pArmR = 0.06;
  } else if (anim < ${ANIM.work}.5 && anim > ${ANIM.work}.0 - 0.5) {
    pTorsoP = 0.1; pHeadP = 0.28;
    pArmL = 1.05 + 0.14 * sin(tt * 13.0 + ph); pArmR = 1.05 + 0.14 * sin(tt * 13.0 + ph + 3.14159);
  } else if (anim < ${ANIM.deskwork}.5 && anim > ${ANIM.deskwork}.0 - 0.5) {
    pDrop = seatDrop; pLegL = 1.45; pLegR = 1.45; pTorsoP = 0.08; pHeadP = 0.22; pSeated = true;
    pArmL = 1.2 + 0.12 * sin(tt * 14.0 + ph); pArmR = 1.2 + 0.12 * sin(tt * 14.0 + ph + 3.14159);
  } else if (anim < ${ANIM.sit}.5 && anim > ${ANIM.sit}.0 - 0.5) {
    pDrop = seatDrop; pLegL = 1.45; pLegR = 1.45; pSeated = true;
    pTorsoP = -0.04 + 0.015 * sin(tt * 1.4 + ph); pHeadY = 0.25 * sin(tt * 0.19 + ph * 3.0);
    pArmL = 0.55; pArmR = 0.55;
  } else if (anim < ${ANIM.talk}.5 && anim > ${ANIM.talk}.0 - 0.5) {
    pHeadP = 0.07 * sin(tt * 2.6 + ph); pHeadY = 0.12 * sin(tt * 0.7 + ph);
    pArmR = 0.65 + 0.45 * sin(tt * 3.1 + ph); pArmL = 0.2 + 0.25 * sin(tt * 2.3 + ph + 1.3);
    pSpread = 0.25 + 0.15 * sin(tt * 1.7 + ph); pTorsoR = 0.04 * sin(tt * 1.1 + ph);
  } else if (anim < ${ANIM.sittalk}.5 && anim > ${ANIM.sittalk}.0 - 0.5) {
    pDrop = seatDrop; pLegL = 1.45; pLegR = 1.45; pSeated = true;
    pHeadP = 0.06 * sin(tt * 2.4 + ph); pArmR = 0.75 + 0.35 * sin(tt * 2.9 + ph); pArmL = 0.6; pSpread = 0.15;
  } else {
    pBody = -1.5707963; pDrop = -${f(BODY.bedY)}; pTorsoP = 0.02 * sin(tt * 0.9 + ph);
  }
}

// One rigid transform per part: limb about its pivot, then the torso about the hips, then the whole body.
vec3 rigPoint(vec3 p, float part, bool isNormal) {
  vec3 hip = isNormal ? vec3(0.0) : vec3(0.0, ${f(BODY.hipY)}, 0.0);
  if (part > 3.5) {
    float a = part < 4.5 ? pLegL : pLegR;
    p = rx(p - hip, -a) + hip;
  } else {
    if (part > 1.5) {
      bool left = part < 2.5;
      vec3 sh = isNormal ? vec3(0.0) : vec3(left ? -${f(BODY.shoulderX)} : ${f(BODY.shoulderX)}, ${f(BODY.shoulderY)}, 0.0);
      float a = left ? pArmL : pArmR;
      p = rx(rz(p - sh, left ? -pSpread : pSpread), -a) + sh;
    } else if (part > 0.5) {
      vec3 nk = isNormal ? vec3(0.0) : vec3(0.0, ${f(BODY.neckY)}, 0.0);
      p = rx(ry(p - nk, pHeadY), pHeadP) + nk;
    }
    p = rz(rx(p - hip, pTorsoP), pTorsoR) + hip;
  }
  if (pBody != 0.0) {
    p = rx(p, pBody);
    if (!isNormal) p.z += ${f(RESIDENT_HEIGHT * 0.95)};
  }
  if (!isNormal) {
    p.y += pBob - pDrop;
    if (pSeated) p.z -= 0.1;
  }
  return p;
}
`;

const NORMAL = /* glsl */ `
evalPose(aInst.x, aInst.y);
vec3 objectNormal = rigPoint(normal, aPart, true);
`;

const POSITION = /* glsl */ `
vec3 transformed = rigPoint(position, aPart, false);
float accStyle = floor(aMat / 16.0);
if (accStyle > 0.5 && abs(accStyle - 1.0 - aInst.z) > 0.5) transformed = vec3(0.0);
float matId = aMat - accStyle * 16.0;
vec3 col = aTop;
if (matId > 0.5 && matId < 1.5) col = aBottom;
else if (matId > 1.5 && matId < 2.5) col = aSkin;
else if (matId > 2.5 && matId < 3.5) col = aHair;
else if (matId > 3.5 && matId < 4.5) col = ${c3(RESIDENT_COLORS.shoe)};
else if (matId > 4.5 && matId < 5.5) col = ${c3(RESIDENT_COLORS.eye)};
else if (matId > 5.5 && matId < 6.5) col = ${c3(RESIDENT_COLORS.apron)};
else if (matId > 6.5 && matId < 7.5) col = ${c3(RESIDENT_COLORS.bag)};
else if (matId > 7.5) col = aTop * 0.72;
vResColor = col;
vDimFlag = aInst.w;
`;

export function createResidentMaterial(u: ResidentUniforms): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ color: '#ffffff' });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = (HEAD + shader.vertexShader)
      .replace('#include <beginnormal_vertex>', NORMAL)
      .replace('#include <begin_vertex>', POSITION);
    shader.fragmentShader =
      'uniform float uDim;\nvarying vec3 vResColor;\nvarying float vDimFlag;\n' +
      shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vResColor;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= 1.0 - 0.42 * uDim * vDimFlag;');
  };
  m.customProgramCacheKey = () => 'town-residents-v1';
  return m;
}
