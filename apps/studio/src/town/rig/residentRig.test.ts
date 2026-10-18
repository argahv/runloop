import { describe, expect, it } from 'vitest';
import { ANIM, ANIM_IDS, BODY, MAX_STRIDE_OMEGA, footSlide, limbAngles, walkGait } from './residentRig';

const WALK_CELLS_PER_MINUTE = 3;

describe('resident rig (CPU reference)', () => {
  it('keeps every limb in bounds for every animation', () => {
    for (const anim of ANIM_IDS) {
      for (let i = 0; i < 400; i++) {
        const t = i * 0.037;
        const p = limbAngles(anim, t, (i * 1.3) % 6.28, i * 0.4, 0.8);
        for (const v of [p.armL, p.armR, p.legL, p.legR]) expect(Math.abs(v)).toBeLessThanOrEqual(1.6);
        for (const v of [p.torsoPitch, p.torsoRoll, p.headPitch, p.headYaw, p.armSpread]) expect(Math.abs(v)).toBeLessThanOrEqual(0.45);
        expect(p.bob).toBeGreaterThanOrEqual(0);
        expect(p.bob).toBeLessThan(0.05);
        expect(Math.abs(p.bodyPitch)).toBeLessThanOrEqual(Math.PI / 2);
      }
    }
  });
  it('seats the hips on the seat and lays sleepers on the bed', () => {
    for (const a of [ANIM.sit, ANIM.deskwork, ANIM.sittalk]) expect(BODY.hipY - limbAngles(a, 0, 0, 0, 0.5).drop).toBeCloseTo(BODY.seatY, 6);
    const s = limbAngles(ANIM.sleep, 0, 0, 0, 0.5);
    expect(s.bodyPitch).toBeCloseTo(-Math.PI / 2, 6);
    expect(-s.drop).toBeCloseTo(BODY.bedY, 6);
  });
  it('keeps feet planted at 1× and 4× (foot slide under 5%)', () => {
    for (const speed of [1, 4]) expect(footSlide(WALK_CELLS_PER_MINUTE * speed)).toBeLessThan(0.05);
    // Faster than the cadence cap, the legs stop speeding up (they may slide).
    expect(walkGait(1000).omega).toBe(MAX_STRIDE_OMEGA);
  });
  it('walks with opposite legs and arms, and holds a still pose at T1', () => {
    const p = limbAngles(ANIM.walk, 0, 0, 1, 0.6);
    expect(p.legL).toBeCloseTo(-p.legR, 9);
    expect(Math.sign(p.armL)).toBe(-Math.sign(p.legL));
    const still = limbAngles(ANIM.walk, 0, 0, 1, 0.6, 0);
    expect(still.legL).toBe(0);
    expect(still.bob).toBeGreaterThan(0);
    // Idle stays restrained.
    for (let t = 0; t < 30; t += 0.5) expect(Math.abs(limbAngles(ANIM.idle, t, 0, 0, 0.5).torsoPitch)).toBeLessThan(0.05);
  });
});
