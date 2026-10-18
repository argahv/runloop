/**
 * Minimap geometry (immersive contract §5.3 Minimap): north-up, the whole
 * town fitted with a margin. Map units follow WorldMap (cell i spans
 * [i, i+1]); camera positions are grid cells (cell centres are integers), so
 * a grid point maps to grid + 0.5. Pure; unit-tested.
 */
export interface MiniTransform {
  scale: number;
  ox: number;
  oy: number;
}

/** Fit a town of `tw`×`th` cells into `w`×`h` px with `pad` px around it. */
export function miniTransform(tw: number, th: number, w: number, h: number, pad = 8): MiniTransform {
  const scale = Math.min((w - 2 * pad) / tw, (h - 2 * pad) / th);
  return { scale, ox: (w - tw * scale) / 2, oy: (h - th * scale) / 2 };
}

/** Map units (cell i spans [i, i+1]) → px. */
export const mapToMini = (t: MiniTransform, x: number, y: number) => ({ x: t.ox + x * t.scale, y: t.oy + y * t.scale });

/** A grid point (camera target, footprint corner) → px. */
export const gridToMini = (t: MiniTransform, gx: number, gz: number) => mapToMini(t, gx + 0.5, gz + 0.5);

/** px → grid point (for goto). */
export const miniToGrid = (t: MiniTransform, px: number, py: number) => ({ x: (px - t.ox) / t.scale - 0.5, z: (py - t.oy) / t.scale - 0.5 });

/**
 * The view's footprint when the renderer cannot report one (no TownApi, the
 * 2D map): a box of the viewport's size at `zoom` px per cell around the target.
 */
export function approxFootprint(x: number, z: number, zoom: number, vw: number, vh: number): [number, number][] {
  const hw = vw / zoom / 2;
  const hh = vh / zoom / 2;
  return [
    [x - hw, z + hh],
    [x + hw, z + hh],
    [x + hw, z - hh],
    [x - hw, z - hh],
  ];
}
