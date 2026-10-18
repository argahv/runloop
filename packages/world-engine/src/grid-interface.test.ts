import { describe, expect, it } from 'vitest';
import { bfs, type Grid } from './grid';

/** A grid from ASCII rows ('#' blocked), with no world definition behind it. */
function asciiGrid(rows: string[]): Grid {
  const width = rows[0]!.length;
  const height = rows.length;
  return {
    width,
    height,
    isWalkable: (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height && rows[y]![x] !== '#',
  };
}

describe('bfs on a plain Grid', () => {
  it('routes around obstacles on any grid that only knows its bounds and walkability', () => {
    const g = asciiGrid(['.....', '.###.', '.....']);
    const path = bfs(g, [0, 1], [4, 1]);
    expect(path).toHaveLength(7);
    expect(path![0]).toEqual([0, 1]);
    expect(path!.at(-1)).toEqual([4, 1]);
    for (const [x, y] of path!) expect(g.isWalkable(x, y)).toBe(true);
  });

  it('returns null when the target is walled off, and memoizes per grid', () => {
    const g = asciiGrid(['..#..', '..#..']);
    expect(bfs(g, [0, 0], [4, 1])).toBeNull();
    const open = asciiGrid(['.....']);
    expect(bfs(open, [0, 0], [4, 0])).toBe(bfs(open, [0, 0], [4, 0]));
  });
});
