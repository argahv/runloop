/**
 * compileTown on Runloop Commons and on broken towns (plan §8 S1): the
 * Commons compiles, agent lots front a road, every problem of a broken town
 * is reported at once, and contentHash and decorate agree across processes.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROUND,
  TownCompileError,
  canonicalJson,
  checkTown,
  compileTown,
  decorate,
  fnv1a64,
  freeAgentLots,
  hash32,
  isWalkableGround,
  loadTown,
  parseInteriorDefinition,
  parseTownDefinition,
  rectCells,
  validateClaim,
  type InteriorDefinition,
  type TownDefinition,
} from '../src/index';
import { readCommons } from './load-commons';

const raw = readCommons();
const town = loadTown(raw.town, raw.interiors);
const def = parseTownDefinition(raw.town);
const interiors: Record<string, InteriorDefinition> = Object.fromEntries(
  Object.entries(raw.interiors).map(([id, d]) => [id, parseInteriorDefinition(d)]),
);
const clone = <T>(v: T): T => structuredClone(v);
const REPO = path.resolve(import.meta.dirname, '../../..');

describe('compileTown: Runloop Commons', () => {
  it('compiles without problems and keeps the content hash of the raw files', () => {
    expect(checkTown(def, interiors).problems).toEqual([]);
    expect(town.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(compileTown(def, interiors).contentHash).toBe(town.contentHash);
    expect(town.buildings).toHaveLength(def.buildings.length);
    expect(town.width * town.height).toBe(town.raster.ground.length);
  });

  it('has at least six agent lots fronting a road, all free, with nothing walkable inside (P6)', () => {
    expect(town.agentLots.length).toBeGreaterThanOrEqual(6);
    for (const lot of town.agentLots) {
      for (const [x, y] of rectCells(lot.rect)) expect(town.walkable[y * town.width + x], `${lot.id} ${x},${y}`).toBe(0);
    }
    expect(freeAgentLots(town, new Set()).map((l) => l.id)).toEqual(town.agentLots.map((l) => l.id).sort());
  });

  it('gives each building its slots on every floor, and homes beds for the maximum population', () => {
    const cafe = town.buildingById.get('bld_corner_cafe')!;
    expect(cafe.slots.map((s) => s.id)).toContain('table_1#0@0');
    const [open, close] = [cafe.def.hours!.open, cafe.def.hours!.close].map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
    expect(cafe.hours).toEqual({ open, close });
    const flats = town.buildingById.get('bld_hearth_flats_n')!;
    expect(flats.slots.filter((s) => s.tags.includes('sleep'))).toHaveLength(24);
    expect(new Set(flats.slots.map((s) => s.id)).size).toBe(flats.slots.length);
    const beds = town.buildings.filter((b) => b.isHome).reduce((n, b) => n + b.slots.filter((s) => s.tags.includes('sleep')).length, 0);
    expect(beds).toBeGreaterThanOrEqual(def.population.max);
  });

  it('indexes doors and spot cells by cell', () => {
    for (const b of town.buildings) expect(town.doorAt.get(b.doorIndex)).toBe(b.def.id);
    for (const s of town.spots) s.cellIndex.forEach((c, i) => expect(town.spotSlotAt.get(c)).toEqual({ spotId: s.def.id, slot: i }));
    for (const b of town.buildings) expect(town.raster.ground[b.doorIndex]).toBe(GROUND.door);
  });

  it('validates housing claims onto agent lots', () => {
    const [first, second] = town.agentLots;
    expect(validateClaim(town, first!.id, new Set())).toEqual({ ok: true, buildingId: first!.buildingId });
    expect(validateClaim(town, first!.id, new Set([first!.id]))).toEqual({ ok: false, code: 'lot_unavailable' });
    expect(validateClaim(town, 'lot_corner_cafe', new Set())).toEqual({ ok: false, code: 'lot_unavailable' });
    expect(validateClaim(town, 'lot_nowhere', new Set())).toEqual({ ok: false, code: 'unknown_entity' });
    expect(freeAgentLots(town, new Set([first!.id])).map((l) => l.id)).not.toContain(first!.id);
    expect(freeAgentLots(town, new Set([first!.id])).map((l) => l.id)).toContain(second!.id);
  });
});

describe('compileTown: broken towns report every problem at once', () => {
  it('lists overlaps, a moved door, an agent lot off the road, a duplicate id, a stranded spot and a bad schedule together', () => {
    const t: TownDefinition = clone(def);
    // A lot overlapping its neighbour.
    t.lots.find((l) => l.id === 'lot_hearth_n2')!.rect = [12, 5, 10, 10];
    // A door that is not where the interior's D lands.
    t.buildings.find((b) => b.id === 'bld_corner_cafe')!.door = [25, 44];
    // An agent lot moved off Foundry Road.
    t.lots.find((l) => l.id === 'lot_agent_6')!.rect = [77, 21, 12, 10];
    // A duplicate id.
    t.spots.push({ ...clone(t.spots[0]!), cells: [[60, 33]] });
    // A spot cell on grass.
    t.spots.find((s) => s.id === 'spot_green_walk')!.cells.push([1, 1]);
    // A schedule with a gap.
    const sched = t.schedules[0]!;
    const [first, second] = sched.blocks;
    second!.from = first!.to === '07:10' ? '07:20' : '07:10';
    const { problems, compiled } = checkTown(t, interiors);
    expect(compiled).toBeNull();
    const text = problems.join('\n');
    expect(text).toMatch(/lot_hearth_n2: overlaps lot_hearth_n1/);
    expect(text).toMatch(/bld_corner_cafe: door 25,44 is not where the interior's D lands/);
    expect(text).toMatch(/lot_agent_6: does not front a road/);
    expect(text).toMatch(/id spot_fountain_rim is used twice/);
    expect(text).toMatch(/spot_green_walk: cell 1,1 is not walkable/);
    expect(text).toContain(`schedule ${sched.id}: ${first!.id} ends at ${first!.to} but ${second!.id} starts at ${second!.from}`);
    expect(() => compileTown(t, interiors)).toThrow(TownCompileError);
  });

  it('rejects a building on an agent lot, a walkable cell inside one, and an unreachable door', () => {
    const t: TownDefinition = clone(def);
    const house = clone(t.buildings.find((b) => b.id === 'bld_hearth_n1')!);
    t.buildings.push({ ...house, id: 'bld_squatter', lotId: 'lot_agent_1', footprint: [52, 7, 8, 7], door: [55, 13] });
    // A plaza with no way in.
    t.areas.push({ id: 'area_island', kind: 'plaza', rect: [1, 40, 1, 2] });
    const text = checkTown(t, interiors).problems.join('\n');
    expect(text).toMatch(/bld_squatter: stands on lot_agent_1, which is reserved for an agent/);
    expect(text).toMatch(/lot_agent_1: walkable cell .* inside an agent lot \(P6\)/);
    expect(text).toMatch(/walkable cells cannot be reached/);
  });

  it('checks interiors: one door, furniture on reachable floor, uses beside their furniture', () => {
    const broken = clone(interiors['house']!) as Extract<InteriorDefinition, { kind: 'grid' }>;
    broken.grid = [...broken.grid.slice(0, -1), '##DD####'];
    broken.furniture[0]!.uses[0]!.cell = [4, 4];
    const text = checkTown(def, { ...interiors, house: broken }).problems.join('\n');
    expect(text).toMatch(/interior house: needs exactly one D/);
    const shifted = clone(interiors['house']!) as Extract<InteriorDefinition, { kind: 'grid' }>;
    shifted.furniture[0]!.uses[0]!.cell = [4, 4];
    expect(checkTown(def, { ...interiors, house: shifted }).problems.join('\n')).toMatch(/interior house.bed_a: use at 4,4 is not beside the furniture/);
  });

  it('needs enough beds and work slots for the maximum population', () => {
    const t: TownDefinition = clone(def);
    t.population.max = 400;
    const text = checkTown(t, interiors).problems.join('\n');
    expect(text).toMatch(/population.max 400 exceeds the \d+ beds/);
    expect(text).toMatch(/role engineer: \d+ work slots for up to \d+ workers/);
  });
});

describe('decorate', () => {
  const items = decorate(town, 42);

  it('places the fixed items and scatters the rules, never on a walkable cell from the rules', () => {
    expect(items.length).toBeGreaterThan(def.decoration.fixed.length + 100);
    const fixed = def.decoration.fixed.length;
    const cells = new Set<string>();
    items.forEach((d, i) => {
      const k = `${d.cell[0]},${d.cell[1]}`;
      expect(cells.has(k), `two items at ${k}`).toBe(false);
      cells.add(k);
      if (i >= fixed) expect(isWalkableGround(town.raster.ground[d.cell[1] * town.width + d.cell[0]]!), `${d.kind} at ${k}`).toBe(false);
    });
    for (const lot of town.agentLots) for (const d of items.slice(fixed)) expect(d.cell[0] >= lot.rect[0] && d.cell[0] < lot.rect[0] + lot.rect[2] && d.cell[1] >= lot.rect[1] && d.cell[1] < lot.rect[1] + lot.rect[3], `${d.kind} in ${lot.id}`).toBe(false);
  });

  it('keeps each rule’s items at least minSpacing apart', () => {
    const lamps = items.slice(def.decoration.fixed.length).filter((d) => d.kind === 'lamp');
    expect(lamps.length).toBeGreaterThan(5);
    for (let i = 0; i < lamps.length; i++)
      for (let j = i + 1; j < lamps.length; j++) {
        const dx = Math.abs(lamps[i]!.cell[0] - lamps[j]!.cell[0]);
        const dy = Math.abs(lamps[i]!.cell[1] - lamps[j]!.cell[1]);
        expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(6);
      }
  });

  it('is identical for a seed and differs between seeds', () => {
    expect(canonicalJson(decorate(town, 42))).toBe(canonicalJson(items));
    expect(canonicalJson(decorate(town, 43))).not.toBe(canonicalJson(items));
  });
});

describe('determinism across processes', () => {
  it('computes the same contentHash, decoration and hash32 draws in a child process', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'print-digest.ts'), '42'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    const theirs = JSON.parse(child.stdout) as { contentHash: string; decoration: string; hash32: number[] };
    expect(theirs).toEqual({
      contentHash: town.contentHash,
      decoration: fnv1a64(canonicalJson(decorate(town, 42))),
      hash32: [hash32(42, 'dec', 480, 3), hash32(42, 'sched', 7), hash32(-5, 'x', 2 ** 40)],
    });
  });
});
