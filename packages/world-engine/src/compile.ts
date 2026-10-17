import { parseWorldDefinition, type Cell, type CharacterPreset, type Station, type StationKind, type WorldDefinition, type Zone } from './definition';
import type { CompiledWorld } from './types';

const key = (x: number, y: number) => `${x},${y}`;

/**
 * Build lookup tables for a world definition. Throws on structural errors
 * (ragged grid, dangling ids, slots or homes that are not walkable).
 */
export function compileWorld(def: WorldDefinition): CompiledWorld {
  const height = def.grid.length;
  const width = def.grid[0]!.length;
  const problems: string[] = [];
  def.grid.forEach((row, y) => {
    if (row.length !== width) problems.push(`grid row ${y} has length ${row.length}, expected ${width}`);
  });

  const blocked = new Set<string>();
  def.grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') blocked.add(key(x, y));
  });
  for (const s of def.stations) blocked.add(key(...s.cell));
  for (const p of def.props) blocked.add(key(...p.cell));
  for (const c of def.hub.core) blocked.add(key(...c));

  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const isWalkable = (x: number, y: number) =>
    Number.isInteger(x) && Number.isInteger(y) && inBounds(x, y) && !blocked.has(key(x, y));

  const zonesById: Record<string, Zone> = {};
  for (const z of def.zones) {
    if (zonesById[z.id]) problems.push(`duplicate zone id ${z.id}`);
    zonesById[z.id] = z;
  }

  const stationsById: Record<string, Station> = {};
  const stationsByKind: Partial<Record<StationKind, Station[]>> = {};
  for (const s of def.stations) {
    if (stationsById[s.id]) problems.push(`duplicate station id ${s.id}`);
    stationsById[s.id] = s;
    (stationsByKind[s.kind] ??= []).push(s);
    if (!zonesById[s.zoneId]) problems.push(`station ${s.id}: unknown zone ${s.zoneId}`);
    if (!inBounds(...s.cell)) problems.push(`station ${s.id}: cell out of bounds`);
    s.slots.forEach((c, i) => {
      if (!isWalkable(...c)) problems.push(`station ${s.id}: slot ${i} [${c}] is not walkable`);
    });
    if (!isWalkable(...s.overflow)) problems.push(`station ${s.id}: overflow [${s.overflow}] is not walkable`);
  }
  for (const list of Object.values(stationsByKind)) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const presetsById: Record<string, CharacterPreset> = {};
  for (const p of def.characterPresets) {
    if (presetsById[p.id]) problems.push(`duplicate preset id ${p.id}`);
    presetsById[p.id] = p;
    if (!isWalkable(...p.home)) problems.push(`preset ${p.id}: home [${p.home}] is not walkable`);
  }
  if (!presetsById[def.defaultPreset]) problems.push(`defaultPreset ${def.defaultPreset} is not a preset`);

  if (problems.length) throw new Error(`Invalid world "${def.id}": ${problems.join('; ')}`);
  return { def, width, height, isWalkable, zonesById, stationsById, stationsByKind, presetsById };
}

/** Parse (zod) and compile a world definition from JSON. */
export function loadWorld(raw: unknown): CompiledWorld {
  return compileWorld(parseWorldDefinition(raw));
}

/** Cells a character may be routed to: every slot, every overflow cell and every preset home. */
export function destinationCells(world: CompiledWorld): { label: string; cell: Cell }[] {
  const out: { label: string; cell: Cell }[] = [];
  for (const s of world.def.stations) {
    s.slots.forEach((cell, i) => out.push({ label: `${s.id} slot ${i}`, cell }));
    out.push({ label: `${s.id} overflow`, cell: s.overflow });
  }
  for (const p of world.def.characterPresets) out.push({ label: `${p.id} home`, cell: p.home });
  return out;
}
