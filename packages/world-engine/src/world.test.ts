import { describe, expect, it } from 'vitest';
import { compileWorld, destinationCells } from './compile';
import { WorldDefinitionSchema } from './definition';
import { bfs } from './grid';
import { campus, campusJson } from './test-utils';

describe('worlds/research-campus/world.json', () => {
  const world = campus();
  const def = world.def;

  it('parses and compiles', () => {
    expect(() => WorldDefinitionSchema.parse(campusJson())).not.toThrow();
    expect(world.width).toBe(24);
    expect(world.height).toBe(20);
    expect(def.grid.every((row) => row.length === world.width)).toBe(true);
  });

  it('blocks walls, station footprints, props and the hub core', () => {
    expect(world.isWalkable(1, 1)).toBe(false); // wall
    for (const s of def.stations) expect(world.isWalkable(...s.cell)).toBe(false);
    for (const p of def.props) expect(world.isWalkable(...p.cell)).toBe(false);
    for (const c of def.hub.core) expect(world.isWalkable(...c)).toBe(false);
    expect(world.isWalkable(0, 0)).toBe(true);
    expect(world.isWalkable(-1, 0)).toBe(false);
    expect(world.isWalkable(24, 0)).toBe(false);
  });

  it('has every slot, overflow cell and preset home walkable and reachable from every home', () => {
    const homes = def.characterPresets.map((p) => p.home);
    const cells = destinationCells(world);
    expect(cells.length).toBe(def.stations.reduce((n, s) => n + s.slots.length + 1, 0) + homes.length);
    for (const { label, cell } of cells) {
      expect(world.isWalkable(...cell), `${label} walkable`).toBe(true);
      for (const home of homes) expect(bfs(world, home, cell), `${label} reachable from [${home}]`).not.toBeNull();
    }
  });

  it('places slots next to their station and keeps destinations distinct', () => {
    for (const s of def.stations) {
      for (const slot of s.slots) expect(Math.abs(slot[0] - s.cell[0]) + Math.abs(slot[1] - s.cell[1])).toBe(1);
    }
    const keys = destinationCells(world).map(({ cell }) => cell.join(','));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('references existing zones, presets and station kinds', () => {
    for (const s of def.stations) expect(world.zonesById[s.zoneId]).toBeDefined();
    expect(world.presetsById[def.defaultPreset]).toBeDefined();
    for (const r of def.activityRules) expect(world.stationsByKind[r.stationKind]?.length).toBeGreaterThan(0);
    // Stations of a kind are sorted by id (deterministic allocation order).
    for (const list of Object.values(world.stationsByKind)) {
      expect(list.map((s) => s.id)).toEqual(list.map((s) => s.id).sort());
    }
  });
});

describe('compileWorld', () => {
  it('rejects slots that are not walkable', () => {
    const def = campusJson();
    def.stations[0]!.slots = [[1, 1]];
    expect(() => compileWorld(WorldDefinitionSchema.parse(def))).toThrow(/slot 0 \[1,1\] is not walkable/);
  });

  it('rejects ragged grids and an unknown default preset', () => {
    const def = campusJson();
    def.grid[3] = def.grid[3]!.slice(1);
    def.defaultPreset = 'nobody';
    expect(() => compileWorld(WorldDefinitionSchema.parse(def))).toThrow(/grid row 3.*defaultPreset nobody/);
  });
});
