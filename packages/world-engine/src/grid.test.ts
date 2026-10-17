import { describe, expect, it } from 'vitest';
import { compileWorld } from './compile';
import type { Cell, WorldDefinition } from './definition';
import { bfs } from './grid';
import { campus } from './test-utils';

/** A minimal world around an ASCII grid. */
function tiny(grid: string[]) {
  const def: WorldDefinition = {
    id: 'tiny',
    version: 1,
    name: 'Tiny',
    tickHz: 10,
    ticksPerCell: 3,
    grid,
    zones: [{ id: 'z', label: 'Z', kind: 'build', rect: [0, 0, 1, 1], color: '#ffffff' }],
    hub: { center: [0, 0], core: [] },
    stations: [{ id: 's', zoneId: 'z', kind: 'build', label: 'S', cell: [0, 0], facing: 's', slots: [[0, 1]], overflow: [1, 1] }],
    props: [],
    activityRules: [],
    characterPresets: [{ id: 'p', label: 'P', color: '#ffffff', icon: 'x', home: [1, 1] }],
    defaultPreset: 'p',
  };
  return compileWorld(def);
}

const adjacent = (a: Cell, b: Cell) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

describe('bfs', () => {
  it('finds an inclusive shortest path with N,E,S,W tie-breaking', () => {
    const w = tiny(['....', '....', '....']);
    expect(bfs(w, [1, 2], [2, 1])).toEqual([
      [1, 2],
      [1, 1],
      [2, 1],
    ]);
    expect(bfs(w, [3, 2], [3, 2])).toEqual([[3, 2]]);
  });

  it('routes around walls and blocked footprints', () => {
    const w = tiny(['....', '....', '.##.', '....']);
    const path = bfs(w, [1, 3], [2, 1])!;
    expect(path.length).toBe(6); // 5 steps instead of 2: the wall forces a detour
    for (let i = 1; i < path.length; i++) expect(adjacent(path[i - 1]!, path[i]!)).toBe(true);
    expect(path.every(([x, y]) => w.isWalkable(x, y))).toBe(true);
    expect(bfs(w, [1, 3], [0, 0])).toBeNull(); // station footprint is blocked
  });

  it('returns null when the target is unreachable', () => {
    const w = tiny(['..#.', '..#.', '..#.']);
    expect(bfs(w, [1, 1], [3, 1])).toBeNull();
    expect(bfs(w, [1, 1], [9, 9])).toBeNull();
  });

  it('is deterministic and memoized per world', () => {
    const a = campus();
    const b = campus();
    const p1 = bfs(a, [10, 8], [3, 4]);
    expect(bfs(a, [10, 8], [3, 4])).toBe(p1); // memo hit
    expect(bfs(b, [10, 8], [3, 4])).toEqual(p1); // fresh world, same answer
    expect(Object.isFrozen(p1)).toBe(true);
    expect(p1!.length - 1).toBe(11); // |dx| + |dy| on open floor
  });
});
