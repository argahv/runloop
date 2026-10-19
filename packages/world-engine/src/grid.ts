import type { Cell } from './definition';

/**
 * What a path search needs from a map: its bounds and which cells can be
 * walked. A CompiledWorld is one; so is the town's outdoor grid
 * (@runloop-world/town), which the world simulation routes residents on.
 * isWalkable must return false outside the bounds.
 */
export interface Grid {
  readonly width: number;
  readonly height: number;
  isWalkable(x: number, y: number): boolean;
}

/** Fixed neighbour order N, E, S, W keeps paths deterministic. */
const DIRS: readonly Cell[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const cache = new WeakMap<Grid, Map<string, readonly Cell[] | null>>();

/**
 * Shortest 4-connected path from `from` to `to`, both inclusive, or null when
 * unreachable. `to` must be walkable; `from` may be any in-bounds cell (the
 * character's current cell). Results are memoized per grid and frozen —
 * copy before mutating.
 */
export function bfs(world: Grid, from: Cell, to: Cell): Cell[] | null {
  let memo = cache.get(world);
  if (!memo) {
    memo = new Map();
    cache.set(world, memo);
  }
  const k = `${from[0]},${from[1]}>${to[0]},${to[1]}`;
  if (memo.has(k)) return memo.get(k) as Cell[] | null;
  const path = search(world, from, to);
  const frozen = path ? Object.freeze(path.map((c) => Object.freeze(c) as Cell)) : null;
  memo.set(k, frozen);
  return frozen as Cell[] | null;
}

function search(world: Grid, from: Cell, to: Cell): Cell[] | null {
  const { width, height } = world;
  const inBounds = ([x, y]: Cell) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inBounds(from) || !world.isWalkable(to[0], to[1])) return null;
  if (from[0] === to[0] && from[1] === to[1]) return [[from[0], from[1]]];

  const idx = (x: number, y: number) => y * width + x;
  const prev = new Int32Array(width * height).fill(-1);
  const start = idx(from[0], from[1]);
  prev[start] = start;
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!world.isWalkable(nx, ny)) continue;
      const n = idx(nx, ny);
      if (prev[n] !== -1) continue;
      prev[n] = cur;
      if (nx === to[0] && ny === to[1]) return unwind(prev, n, start, width);
      queue.push(n);
    }
  }
  return null;
}

function unwind(prev: Int32Array, end: number, start: number, width: number): Cell[] {
  const out: Cell[] = [];
  for (let n = end; ; n = prev[n]!) {
    out.push([n % width, Math.floor(n / width)]);
    if (n === start) break;
  }
  return out.reverse();
}
