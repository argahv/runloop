/**
 * The resident rig's pose maths (plan §5: "rig/residentRig.ts is the CPU
 * reference"). The vertex shader in residentMaterial.ts evaluates the same
 * formulas per vertex; this module is the tested reference and the source of
 * the shared constants (the shader is generated from them).
 *
 * Body (in cells; a resident is RESIDENT_HEIGHT tall, feet at y = 0, facing +z):
 * legs pivot at the hips, arms at the shoulders, the head at the neck. Every
 * angle is a pitch (rotation about +x, positive swings forward) except where named.
 */

export const RESIDENT_HEIGHT = 0.95;
export const BODY = {
  hipY: 0.42,
  shoulderY: 0.68,
  neckY: 0.72,
  shoulderX: 0.15,
  hipX: 0.07,
  /** Seat height of chairs, benches and sofas (furniture is modelled to it). */
  seatY: 0.26,
  /** Height of a bed's mattress top. */
  bedY: 0.3,
} as const;

/** Animation ids (instance attribute aAnim). */
export const ANIM = {
  idle: 0,
  walk: 1,
  sit: 2,
  work: 3,
  deskwork: 4,
  talk: 5,
  sittalk: 6,
  sleep: 7,
} as const;
export type AnimName = keyof typeof ANIM;
export type AnimId = (typeof ANIM)[AnimName];

export interface Pose {
  /** Whole-body vertical offset (cells). */
  bob: number;
  /** Lowers the body so the hips rest on a seat or the body lies on a bed (cells, ≥ 0 lowers). */
  drop: number;
  /** Whole-body pitch about the hips (−π/2 = lying on the back). */
  bodyPitch: number;
  torsoPitch: number;
  torsoRoll: number;
  headPitch: number;
  headYaw: number;
  armL: number;
  armR: number;
  /** Outward roll of the arms (gestures). */
  armSpread: number;
  legL: number;
  legR: number;
}

/** Walk cadence limits: legs never swing faster than this (rad/s), so high sim speeds slide a little rather than flail. */
export const MAX_STRIDE_OMEGA = 30;

/**
 * Gait for a walking speed in cells per wall second: the swing amplitude grows
 * with speed (a stroll becomes a brisk walk) and the swing rate is set so the
 * planted foot moves at ground speed (no foot slide) up to MAX_STRIDE_OMEGA.
 */
export function walkGait(cellsPerSecond: number): { omega: number; amp: number } {
  const v = Math.max(0, cellsPerSecond);
  const amp = Math.min(0.95, Math.max(0.5, 0.5 + 0.035 * v));
  const omega = Math.min(MAX_STRIDE_OMEGA, v / (BODY.hipY * amp));
  return { omega, amp };
}

/** Foot slide while walking: 1 − (planted-foot speed / ground speed). 0 = feet stick to the ground. */
export function footSlide(cellsPerSecond: number): number {
  if (cellsPerSecond <= 0) return 0;
  const { omega, amp } = walkGait(cellsPerSecond);
  // A pitch swing θ = amp·sin(φ) moves the sole at L·amp·ω at mid-stance (θ = 0).
  return Math.abs(1 - (BODY.hipY * amp * omega) / cellsPerSecond);
}

const NEUTRAL: Pose = {
  bob: 0,
  drop: 0,
  bodyPitch: 0,
  torsoPitch: 0,
  torsoRoll: 0,
  headPitch: 0,
  headYaw: 0,
  armL: 0,
  armR: 0,
  armSpread: 0,
  legL: 0,
  legR: 0,
};

/**
 * Limb angles for an animation.
 * - t: wall seconds (frozen under reduced motion);
 * - phase: per-resident offset (radians), so nobody moves in lockstep;
 * - walkPhase: the accumulated stride angle (∫ω dt), shared by all walkers;
 * - amp: the stride amplitude from walkGait;
 * - rig: 1 = full rig (T0), 0 = poses held still and only the walk bob moves (T1).
 */
export function limbAngles(anim: AnimId, t: number, phase: number, walkPhase: number, amp: number, rig: 0 | 1 = 1): Pose {
  const p: Pose = { ...NEUTRAL };
  const s = Math.sin;
  const tt = rig ? t : 0;
  switch (anim) {
    case ANIM.walk: {
      const ph = walkPhase + phase;
      p.bob = 0.03 * Math.abs(s(ph));
      if (rig) {
        p.legL = amp * s(ph);
        p.legR = -p.legL;
        p.armL = -0.8 * amp * s(ph);
        p.armR = -p.armL;
        p.torsoPitch = 0.06;
        p.torsoRoll = 0.035 * s(ph);
      }
      break;
    }
    case ANIM.idle:
      p.torsoPitch = 0.02 * s(tt * 1.6 + phase);
      p.torsoRoll = 0.03 * s(tt * 0.4 + phase);
      p.headYaw = 0.3 * s(tt * 0.23 + phase * 2);
      p.armL = 0.06;
      p.armR = 0.06;
      break;
    case ANIM.work:
      p.torsoPitch = 0.1;
      p.headPitch = 0.28;
      p.armL = 1.05 + 0.14 * s(tt * 13 + phase);
      p.armR = 1.05 + 0.14 * s(tt * 13 + phase + Math.PI);
      break;
    case ANIM.deskwork:
      p.drop = BODY.hipY - BODY.seatY;
      p.legL = 1.45;
      p.legR = 1.45;
      p.torsoPitch = 0.08;
      p.headPitch = 0.22;
      p.armL = 1.2 + 0.12 * s(tt * 14 + phase);
      p.armR = 1.2 + 0.12 * s(tt * 14 + phase + Math.PI);
      break;
    case ANIM.sit:
      p.drop = BODY.hipY - BODY.seatY;
      p.legL = 1.45;
      p.legR = 1.45;
      p.torsoPitch = -0.04 + 0.015 * s(tt * 1.4 + phase);
      p.headYaw = 0.25 * s(tt * 0.19 + phase * 3);
      p.armL = 0.55;
      p.armR = 0.55;
      break;
    case ANIM.talk:
      p.headPitch = 0.07 * s(tt * 2.6 + phase);
      p.headYaw = 0.12 * s(tt * 0.7 + phase);
      p.armR = 0.65 + 0.45 * s(tt * 3.1 + phase);
      p.armL = 0.2 + 0.25 * s(tt * 2.3 + phase + 1.3);
      p.armSpread = 0.25 + 0.15 * s(tt * 1.7 + phase);
      p.torsoRoll = 0.04 * s(tt * 1.1 + phase);
      break;
    case ANIM.sittalk:
      p.drop = BODY.hipY - BODY.seatY;
      p.legL = 1.45;
      p.legR = 1.45;
      p.headPitch = 0.06 * s(tt * 2.4 + phase);
      p.armR = 0.75 + 0.35 * s(tt * 2.9 + phase);
      p.armL = 0.6;
      p.armSpread = 0.15;
      break;
    case ANIM.sleep:
      p.bodyPitch = -Math.PI / 2;
      p.drop = -BODY.bedY;
      p.torsoPitch = 0.02 * s(tt * 0.9 + phase);
      break;
  }
  return p;
}

/** Every animation id, for tests. */
export const ANIM_IDS: readonly AnimId[] = Object.values(ANIM);
