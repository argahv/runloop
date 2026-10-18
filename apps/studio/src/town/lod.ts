/**
 * Level of detail for residents and agents (plan §5): by projected height in
 * pixels, with ±15% hysteresis so a zoom resting near a boundary never flickers.
 *
 * | Tier | Projected height | Residents          | Agents                  |
 * | T0   | ≥ 28 px          | rigged instances   | full robot              |
 * | T1   | 10–28 px         | same mesh, bob     | robot, no limb motion   |
 * | T2   | < 10 px          | dots               | diamond marker + beacon |
 *
 * One tier per frame (not per resident): under the perspective camera it is
 * taken at the nearest ground in view (the bottom of the screen), so the
 * residents closest to the viewer always get the detail.
 */

export type Tier = 0 | 1 | 2;

export const T0_PX = 28;
export const T1_PX = 10;
export const HYSTERESIS = 0.15;

/**
 * The tier for a projected height. `prev` is last frame's tier: entering a
 * finer tier needs 15% above its boundary, leaving one needs 15% below it.
 * `t0Px` lets adaptive quality tighten the full-rig band.
 */
export function tierFor(px: number, prev: Tier | null, t0Px = T0_PX): Tier {
  if (prev === null) return px >= t0Px ? 0 : px >= T1_PX ? 1 : 2;
  const enter0 = prev === 0 ? t0Px * (1 - HYSTERESIS) : t0Px * (1 + HYSTERESIS);
  const enter1 = prev === 2 ? T1_PX * (1 + HYSTERESIS) : T1_PX * (1 - HYSTERESIS);
  if (px >= enter0) return 0;
  if (px >= enter1) return 1;
  return 2;
}

/** Projected height (px) of an object `height` units tall at `dist` units from a perspective camera (vertical field of view `fovYDeg`, canvas `canvasH` px tall). */
export function projectedHeightPersp(height: number, dist: number, fovYDeg: number, canvasH: number): number {
  return (height * canvasH) / (2 * Math.max(1e-6, dist) * Math.tan((fovYDeg * Math.PI) / 360));
}
