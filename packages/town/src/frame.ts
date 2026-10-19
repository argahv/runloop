/**
 * Interior frames. Interiors are authored facing south (door on the bottom
 * row). A building facing another way rotates its interior about the
 * footprint; rotations only, never mirrors, so furniture keeps its handedness.
 */
import type { Cell, Dir } from './schema';

/** The interior's [w, h] once placed with `facing` (east and west swap the axes). */
export function rotatedSize(size: readonly [number, number], facing: Dir): [number, number] {
  return facing === 'e' || facing === 'w' ? [size[1], size[0]] : [size[0], size[1]];
}

/**
 * Town cell of interior cell `cell` for an interior of `size` placed at
 * `origin` (the footprint's top-left cell) with `facing`.
 */
export function interiorToTown(cell: Cell, size: readonly [number, number], origin: Cell, facing: Dir): Cell {
  const [ix, iy] = cell;
  const [w, h] = size;
  const [x0, y0] = origin;
  switch (facing) {
    case 's':
      return [x0 + ix, y0 + iy];
    case 'n':
      return [x0 + w - 1 - ix, y0 + h - 1 - iy];
    case 'e':
      return [x0 + iy, y0 + w - 1 - ix];
    case 'w':
      return [x0 + h - 1 - iy, y0 + ix];
  }
}

const VECTORS: Record<Dir, readonly [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** A direction in the interior's authoring frame, seen in the town. */
export function rotateDir(dir: Dir, facing: Dir): Dir {
  const [dx, dy] = VECTORS[dir];
  // The linear part of interiorToTown for each facing.
  const [tx, ty] =
    facing === 's' ? [dx, dy] : facing === 'n' ? [-dx, -dy] : facing === 'e' ? [dy, -dx] : [-dy, dx];
  return tx === 0 ? (ty < 0 ? 'n' : 's') : tx > 0 ? 'e' : 'w';
}

/** The cell one step from `cell` in direction `dir`. */
export function step(cell: Cell, dir: Dir): Cell {
  const [dx, dy] = VECTORS[dir];
  return [cell[0] + dx, cell[1] + dy];
}
