import { readFileSync } from 'node:fs';
import { ReplayIndex } from '@runloop-world/replay';
import { codingMissionFixture } from '@runloop-world/testkit';
import { loadWorld, type Cell } from '@runloop-world/world-engine';
import { describe, expect, it } from 'vitest';
import { badgeDetail, STATE_BADGE } from './badges';
import {
  FLOOR_Y,
  ROOM_Y,
  classifyWalls,
  floorTiles,
  glowPaths,
  heightAt,
  hubRing,
  incidentStationId,
  pathPoints,
  stationFront,
} from './layout';

const world = loadWorld(JSON.parse(readFileSync(new URL('../../../../worlds/research-campus/world.json', import.meta.url), 'utf8')));
const adjacent = (a: Cell, b: Cell) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

describe('scene layout (derived from the world definition)', () => {
  it('classifies every wall cell; north/west room edges are tall back walls, south/east are curbs', () => {
    const walls = classifyWalls(world);
    const hashes = world.def.grid.join('').split('').filter((c) => c === '#').length;
    expect(walls).toHaveLength(hashes);
    const at = (x: number, y: number) => walls.find((w) => w.cell[0] === x && w.cell[1] === y)!;
    expect(at(4, 1).kind).toBe('back'); // research north wall
    expect(at(1, 4).kind).toBe('back'); // research west wall
    expect(at(4, 7).kind).toBe('curb'); // research south wall
    expect(at(9, 4).kind).toBe('curb'); // research east wall
    expect(at(1, 7).kind).toBe('back'); // SW corner continues the west wall
  });

  it('puts a floor tile on every non-wall cell', () => {
    const cells = world.width * world.height;
    expect(floorTiles(world).length + classifyWalls(world).length).toBe(cells);
  });

  it('builds glow paths along walkable, contiguous cells from the hub', () => {
    const ring = hubRing(world);
    expect(ring.length).toBeGreaterThan(0);
    const paths = glowPaths(world);
    const doors = world.def.zones.filter((z) => z.door && z.kind !== 'hub');
    expect(paths.filter((p) => !p.branch && p.key.startsWith('hub>')).length).toBe(doors.length + 1); // + the gate
    for (const p of paths) {
      p.cells.forEach((c, i) => {
        expect(world.isWalkable(c[0], c[1])).toBe(true);
        if (i > 0) expect(adjacent(p.cells[i - 1]!, c)).toBe(true);
      });
      if (!p.branch) expect(ring.some((r) => r[0] === p.cells[0]![0] && r[1] === p.cells[0]![1])).toBe(true);
    }
  });

  it('steps between corridor and room heights at the cell boundary', () => {
    expect(heightAt(world, 7, 9)).toBeCloseTo(FLOOR_Y);
    expect(heightAt(world, 4, 4)).toBeCloseTo(ROOM_Y);
    const mid = heightAt(world, 7, 7.5); // between door (7,7) and corridor (7,8)
    expect(mid).toBeGreaterThan(FLOOR_Y);
    expect(mid).toBeLessThan(ROOM_Y);
    // Path polylines get a vertical riser where the height changes.
    const pts = pathPoints(world, [[7, 8], [7, 7]], 0);
    expect(pts).toHaveLength(4);
  });

  it('faces stations towards their first slot', () => {
    expect(stationFront(world.stationsById['archive']!)).toEqual([0, 1]);
    expect(stationFront(world.stationsById['testrig']!)).toEqual([0, -1]);
  });
});

describe('scene derivations from Layer 1/2 state', () => {
  const events = codingMissionFixture();
  const index = new ReplayIndex(world, events);
  const seqOf = (pred: (e: (typeof events)[number]) => boolean) => events.find(pred)!.sequence;

  it('places the failing test incident at the station the tester used', () => {
    const failSeq = seqOf((e) => e.type === 'tool.call_completed' && e.payload.status === 'error');
    const later = index.stateAt(failSeq + 4); // tester has walked away (blocked → home)
    const inc = later.exec.incidents[0]!;
    // Without a remembered station it falls back to the first station the rules map the task kind to.
    expect(incidentStationId(world, later, inc, new Map())).toBe('probe');
    const cache = new Map<string, string>();
    expect(incidentStationId(world, index.stateAt(failSeq), inc, cache)).toBe('probe');
    expect(cache.get(inc.eventId)).toBe('probe');
  });

  it('badge text comes from the state (icon + label for every state, tool / reason detail)', () => {
    for (const b of Object.values(STATE_BADGE)) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.icon.length).toBeGreaterThan(0);
    }
    const blocked = index.stateAt(seqOf((e) => e.type === 'agent.state_changed' && e.payload.state === 'waiting'));
    expect(badgeDetail('waiting', 'tester', blocked, world)).toBe('Waiting · for a fix');
    const s = index.stateAt(seqOf((e) => e.type === 'tool.call_started' && e.payload.tool === 'run_command'));
    expect(badgeDetail('working', 'tester', s, world)).toBe('Working · run_command');
  });
});
