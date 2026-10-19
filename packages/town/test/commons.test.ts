/**
 * Structural checks on Runloop Commons that need no raster. Reachability and
 * walkability are compileTown's (S1); the S0 layout was checked with them
 * when it was made (see worlds/runloop-commons/README.md).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  interiorToTown,
  parseInteriorDefinition,
  parseTownDefinition,
  rotatedSize,
  step,
  type Cell,
  type GridInterior,
  type InteriorDefinition,
  type Rect,
} from '../src/index';
import { WORLDS_DIR, readCommons } from './load-commons';

const raw = readCommons();
const town = parseTownDefinition(raw.town);
const interiors: Record<string, InteriorDefinition> = Object.fromEntries(
  Object.entries(raw.interiors).map(([id, d]) => [id, parseInteriorDefinition(d)]),
);

const cellsOf = ([x, y, w, h]: Rect): Cell[] => {
  const out: Cell[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]);
  return out;
};
const key = ([x, y]: Cell) => `${x},${y}`;
const inRect = ([x, y]: Cell, [rx, ry, rw, rh]: Rect) => x >= rx && y >= ry && x < rx + rw && y < ry + rh;
const gridOf = (id: string) => {
  const i = interiors[id];
  if (!i || i.kind !== 'grid') throw new Error(`${id} is not a grid interior`);
  return i;
};
const sizeOf = (i: GridInterior): [number, number] => [i.grid[0]!.length, i.grid.length];
const usesTagged = (i: InteriorDefinition, ...tags: string[]) =>
  i.kind === 'grid' ? i.furniture.filter((f) => tags.every((t) => f.tags.includes(t))).reduce((n, f) => n + f.uses.length, 0) : 0;

/** Sidewalk rects of every road. */
const sidewalks: Rect[] = town.roads.flatMap((r) => {
  const [x, y, w, h] = r.rect;
  return r.sidewalks.map((s): Rect => ({ n: [x, y - 1, w, 1], s: [x, y + h, w, 1], w: [x - 1, y, 1, h], e: [x + w, y, 1, h] })[s] as Rect);
});
const onRoad = (c: Cell) => town.roads.some((r) => inRect(c, r.rect));
const onSidewalk = (c: Cell) => !onRoad(c) && sidewalks.some((s) => inRect(c, s));

describe('Runloop Commons', () => {
  it('is the plan’s 96×72 town at 3 cells per minute, starting at 08:00 with 80 residents', () => {
    expect(town.size).toEqual([96, 72]);
    expect(town.walkCellsPerMinute).toBe(3);
    expect(town.startTime).toBe('08:00');
    expect(town.population.default).toBe(80);
  });

  it('has the plan’s districts', () => {
    const labels = town.districts.map((d) => d.label);
    expect(labels).toEqual(expect.arrayContaining(['Civic Atrium', 'Hearth Row', 'Market Street', 'Research Park', 'Agent District']));
  });

  it('uses every id once, in the plan’s id patterns', () => {
    const ids = [
      ...town.districts,
      ...town.roads,
      ...town.crossings,
      ...town.areas,
      ...town.landmarks,
      ...town.lots,
      ...town.buildings,
      ...town.spots,
      ...town.orgs,
    ].map((o) => o.id);
    const agentBuildings = town.lots.flatMap((l) => (l.buildingId ? [l.buildingId] : []));
    const all = [...ids, ...agentBuildings];
    expect(new Set(all).size).toBe(all.length);
    for (const id of [...town.districts, ...town.lots, ...town.buildings, ...town.spots, ...town.orgs].map((o) => o.id)) {
      expect(id).toMatch(/^(dst|lot|bld|spot|org)_[a-z0-9_]+$/);
    }
  });

  it('keeps districts and lots apart, lots off roads and sidewalks, and each lot inside its district', () => {
    const district = new Map<string, string>();
    for (const d of town.districts) for (const r of d.rects) for (const c of cellsOf(r)) {
      expect(district.has(key(c)), `${d.id} overlaps ${district.get(key(c))} at ${key(c)}`).toBe(false);
      district.set(key(c), d.id);
    }
    const lotAt = new Map<string, string>();
    for (const l of town.lots) for (const c of cellsOf(l.rect)) {
      expect(lotAt.has(key(c)), `${l.id} overlaps ${lotAt.get(key(c))}`).toBe(false);
      lotAt.set(key(c), l.id);
      expect(onRoad(c) || onSidewalk(c), `${l.id} on a road at ${key(c)}`).toBe(false);
      expect(district.get(key(c)), `${l.id} at ${key(c)}`).toBe(l.districtId);
    }
  });

  it('gives each building its interior’s footprint and door, inside its lot, facing its street', () => {
    const lots = new Map(town.lots.map((l) => [l.id, l]));
    for (const b of town.buildings) {
      const lot = lots.get(b.lotId)!;
      expect(lot, b.id).toBeDefined();
      expect(lot.use).toBe('building');
      expect(b.facing).toBe(lot.frontage);
      const inner = gridOf(b.interior);
      const size = sizeOf(inner);
      expect(b.footprint.slice(2), b.id).toEqual(rotatedSize(size, b.facing));
      for (const c of cellsOf(b.footprint)) expect(inRect(c, lot.rect), `${b.id} footprint`).toBe(true);
      const last = inner.grid.length - 1;
      const d: Cell = [inner.grid[last]!.indexOf('D'), last];
      expect(b.door, b.id).toEqual(interiorToTown(d, size, [b.footprint[0], b.footprint[1]], b.facing));
      // The cell in front of the door is outside the footprint.
      expect(inRect(step(b.door, b.facing), b.footprint)).toBe(false);
    }
  });

  it('reserves at least six empty 12×10 agent lots that front a road, sized for the agent HQ', () => {
    const hq = interiors[town.agentHq.interior]!;
    expect(hq.kind).toBe('world');
    if (hq.kind !== 'world') return;
    const world = JSON.parse(readFileSync(path.join(WORLDS_DIR, hq.world, 'world.json'), 'utf8')) as { grid: string[] };
    expect([world.grid[0]!.length * hq.scale, world.grid.length * hq.scale]).toEqual(hq.size);
    expect(hq).toMatchObject({ world: 'research-campus', scale: 0.5, size: [12, 10] });

    const agentLots = town.lots.filter((l) => l.use === 'agent');
    expect(agentLots.length).toBeGreaterThanOrEqual(6);
    for (const l of agentLots) {
      expect(l.rect.slice(2), l.id).toEqual(hq.size);
      expect(town.buildings.some((b) => b.lotId === l.id), `${l.id} is pre-placed`).toBe(false);
      const [x, y, w, h] = l.rect;
      const edge: Cell[] = {
        n: Array.from({ length: w }, (_, i): Cell => [x + i, y - 1]),
        s: Array.from({ length: w }, (_, i): Cell => [x + i, y + h]),
        w: Array.from({ length: h }, (_, j): Cell => [x - 1, y + j]),
        e: Array.from({ length: h }, (_, j): Cell => [x + w, y + j]),
      }[l.frontage];
      for (const c of edge) {
        expect(onSidewalk(c), `${l.id}: ${key(c)} is not sidewalk`).toBe(true);
        expect(onRoad(step(c, l.frontage)), `${l.id}: no road beyond ${key(c)}`).toBe(true);
      }
    }
  });

  it('keeps every outdoor spot out of lots and agent lots (P6), one spot per cell', () => {
    const seen = new Set<string>();
    for (const s of town.spots) for (const c of s.cells) {
      expect(seen.has(key(c)), `${s.id} reuses ${key(c)}`).toBe(false);
      seen.add(key(c));
      expect(town.lots.some((l) => inRect(c, l.rect)), `${s.id} in a lot at ${key(c)}`).toBe(false);
      expect(onRoad(c), `${s.id} on a road`).toBe(false);
    }
  });

  it('references only known districts, orgs, interiors, schedules and buildings', () => {
    const districts = new Set(town.districts.map((d) => d.id));
    const orgs = new Set(town.orgs.map((o) => o.id));
    const schedules = new Set(town.schedules.map((s) => s.id));
    const buildings = new Map(town.buildings.map((b) => [b.id, b]));
    expect(orgs.has('org_home')).toBe(true);
    for (const l of town.lots) expect(districts.has(l.districtId)).toBe(true);
    for (const s of town.spots) expect(districts.has(s.districtId)).toBe(true);
    for (const b of town.buildings) {
      if (b.orgId) expect(orgs.has(b.orgId), b.id).toBe(true);
      expect(interiors[b.interior], b.id).toBeDefined();
      expect((b.access === 'residents') === (b.orgId === null), `${b.id}: homes and only homes have no org`).toBe(true);
    }
    for (const r of town.roles) {
      expect(schedules.has(r.schedule), r.id).toBe(true);
      for (const id of r.work?.buildings ?? []) expect(buildings.has(id), `${r.id} → ${id}`).toBe(true);
    }
  });

  it('has schedules that tile the whole day', () => {
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    for (const s of town.schedules) {
      let total = 0;
      s.blocks.forEach((b, i) => {
        expect(b.to, `${s.id}.${b.id}`).toBe(s.blocks[(i + 1) % s.blocks.length]!.from);
        total += (minutes(b.to) - minutes(b.from) + 1440) % 1440;
      });
      expect(total, s.id).toBe(1440);
    }
  });

  it('houses its maximum population and gives every role enough work slots at that size', () => {
    const homes = town.buildings.filter((b) => b.access === 'residents');
    const beds = homes.reduce((n, b) => n + usesTagged(interiors[b.interior]!, 'sleep') * b.floors, 0);
    expect(beds).toBe(town.population.max);
    expect(beds).toBeGreaterThanOrEqual(120);
    const shares = town.roles.reduce((n, r) => n + r.share, 0);
    for (const r of town.roles) {
      if (!r.work) continue;
      const tag = r.work.tag ?? 'work';
      const slots = r.work.buildings.reduce((n, id) => {
        const b = town.buildings.find((x) => x.id === id)!;
        return n + usesTagged(interiors[b.interior]!, 'work', tag) * b.floors;
      }, 0);
      expect(slots, r.id).toBeGreaterThanOrEqual(Math.ceil((beds * r.share) / shares));
    }
  });

  it('has somewhere to eat, socialise and stroll outdoors, and food beyond home', () => {
    for (const tag of ['eat', 'socialize', 'stroll', 'rest'] as const) {
      expect(town.spots.some((s) => s.tags.includes(tag)), tag).toBe(true);
    }
    const publicEat = town.buildings.filter((b) => b.access === 'public').reduce((n, b) => n + usesTagged(interiors[b.interior]!, 'eat'), 0);
    expect(publicEat).toBeGreaterThanOrEqual(20);
  });

  it('includes interiors for homes, the café, the office, the lab and workshop, and the agent HQ', () => {
    for (const id of ['house', 'flats', 'cafe', 'office', 'lab', 'workshop', 'agent_hq']) expect(interiors[id], id).toBeDefined();
  });

  it('gives every grid interior one door on its bottom row, walls round the edge, and furniture on the floor', () => {
    for (const [id, i] of Object.entries(interiors)) {
      if (i.kind !== 'grid') continue;
      const [w, h] = sizeOf(i);
      expect(i.grid.every((r) => r.length === w), id).toBe(true);
      const doors = i.grid.flatMap((r, y) => [...r].flatMap((ch, x) => (ch === 'D' ? [[x, y]] : [])));
      expect(doors, id).toHaveLength(1);
      expect(doors[0]![1]).toBe(h - 1);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
          expect(edge ? '#wD'.includes(i.grid[y]![x]!) : i.grid[y]![x] === '.', `${id} ${x},${y}`).toBe(true);
        }
      const covered = new Set<string>();
      for (const f of i.furniture) {
        expect(new Set(i.furniture.map((g) => g.id)).size).toBe(i.furniture.length);
        for (const c of f.cells) {
          expect(i.grid[c[1]]?.[c[0]], `${id}.${f.id}`).toBe('.');
          expect(covered.has(key(c)), `${id}.${f.id} overlaps`).toBe(false);
          covered.add(key(c));
        }
        if (f.uses.length) expect(f.tags.some((t) => ['sleep', 'rest', 'eat', 'work', 'socialize', 'stroll'].includes(t)), `${id}.${f.id}`).toBe(true);
      }
    }
  });
});
