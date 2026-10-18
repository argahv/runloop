/**
 * Outdoor navigation (plan §8 S1): every door reaches every other door, and
 * following a distance field gives the same walk as world-engine's bfs.
 */
import { bfs } from '@runloop-world/world-engine';
import { describe, expect, it } from 'vitest';
import { cellAt, distanceField, loadTown, outdoorGrid, pathTo, stepsTo, type Cell } from '../src/index';
import { readCommons } from './load-commons';

const raw = readCommons();
const town = loadTown(raw.town, raw.interiors);
const grid = outdoorGrid(town);

describe('outdoor navigation on Runloop Commons', () => {
  it('connects every door to every other door', () => {
    for (const b of town.buildings) {
      const field = distanceField(town, b.def.id);
      for (const other of town.buildings) expect(field[other.doorIndex], `${other.def.id} → ${b.def.id}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('follows a field exactly as bfs walks from the target, reversed (same length as bfs from the start)', () => {
    const targets = [...town.buildings.map((b) => b.def.id), ...town.spots.flatMap((s) => s.slots.map((sl) => sl.id))];
    let checked = 0;
    for (const target of targets) {
      const field = distanceField(town, target);
      // Every 37th walkable cell as a start, so all regions of the map are covered.
      for (let i = (target.length * 7) % 37; i < field.length; i += 37) {
        if (!town.walkable[i]) continue;
        const from = cellAt(town, i);
        const walk = pathTo(town, from, target)!;
        const end = walk.at(-1)!;
        const reference = bfs(grid, end, from)!;
        expect(walk).toEqual([...reference].reverse().map((c) => [c[0], c[1]]));
        expect(walk.length - 1).toBe(field[i]);
        expect(bfs(grid, from, end)!.length).toBe(walk.length);
        expect(stepsTo(town, i, target)).toBe(field[i]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  it('walks only on walkable cells, never through an agent lot (P6), and ends at the door or spot cell', () => {
    const from = town.buildingById.get('bld_hearth_n1')!.def.door;
    for (const b of town.buildings) {
      const walk = pathTo(town, from, b.def.id)!;
      expect(walk.at(-1)).toEqual(b.def.door);
      for (const [x, y] of walk) expect(grid.isWalkable(x, y)).toBe(true);
    }
    const spot = town.spotById.get('spot_byte_bites')!;
    expect(pathTo(town, from, 'spot_byte_bites#2')!.at(-1)).toEqual(spot.def.cells[2]);
    expect(spot.def.cells).toContainEqual(pathTo(town, from, 'spot_byte_bites')!.at(-1));
  });

  it('returns null from an unwalkable start and throws on an unknown target', () => {
    const inside: Cell = [8, 9]; // inside Juniper House's footprint
    expect(grid.isWalkable(...inside)).toBe(false);
    expect(pathTo(town, inside, 'bld_corner_cafe')).toBeNull();
    expect(pathTo(town, [500, 500], 'bld_corner_cafe')).toBeNull();
    expect(() => distanceField(town, 'bld_nowhere')).toThrow(/Unknown navigation target/);
    expect(() => distanceField(town, 'bld_agent_hq_1')).toThrow(/Unknown navigation target/);
  });
});
