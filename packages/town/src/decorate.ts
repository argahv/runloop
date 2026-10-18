/**
 * Trees and street props from the town's decoration rules. Deterministic for
 * a town and seed (hash32 orders the candidates, no state), and decoration
 * never stands on a walkable cell, so it never blocks a door, sidewalk,
 * crosswalk or spot. Fixed items are placed as authored.
 *
 * Ground a rule may use:
 * - grass, park, garden: that ground;
 * - yard: lot ground outside footprints and front walks (never an agent lot);
 * - sidewalk_edge / plaza_edge: an unwalkable cell (grass, planted ground or
 *   yard) beside a sidewalk / plaza;
 * - water_edge: a water cell beside the bank.
 */
import type { CompiledTown } from './compile';
import { inRect } from './raster';
import { GROUND } from './raster';
import { hash32 } from './rng';
import type { Cell, DecoKind } from './schema';

export interface DecorationItem {
  kind: DecoKind;
  cell: Cell;
  yaw: 0 | 90 | 180 | 270;
}

type DecoGround = 'grass' | 'park' | 'garden' | 'yard' | 'plaza_edge' | 'sidewalk_edge' | 'water_edge';

/** Which decoration grounds each cell offers. */
function groundSets(town: CompiledTown): Record<DecoGround, Uint8Array> {
  const { width, height, raster } = town;
  const g = raster.ground;
  const n = width * height;
  const agent = new Uint8Array(n);
  for (const l of town.agentLots) {
    for (let y = l.rect[1]; y < l.rect[1] + l.rect[3]; y++) for (let x = l.rect[0]; x < l.rect[0] + l.rect[2]; x++) agent[y * width + x] = 1;
  }
  const sets = {
    grass: new Uint8Array(n),
    park: new Uint8Array(n),
    garden: new Uint8Array(n),
    yard: new Uint8Array(n),
    plaza_edge: new Uint8Array(n),
    sidewalk_edge: new Uint8Array(n),
    water_edge: new Uint8Array(n),
  };
  const soft = (i: number) => !agent[i] && (g[i] === GROUND.grass || g[i] === GROUND.park || g[i] === GROUND.garden || g[i] === GROUND.lot);
  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = (i - x) / width;
    const near = (code: number) =>
      (y > 0 && g[i - width] === code) || (x < width - 1 && g[i + 1] === code) || (y < height - 1 && g[i + width] === code) || (x > 0 && g[i - 1] === code);
    if (g[i] === GROUND.grass) sets.grass[i] = 1;
    if (g[i] === GROUND.park) sets.park[i] = 1;
    if (g[i] === GROUND.garden) sets.garden[i] = 1;
    if (g[i] === GROUND.lot && !agent[i]) sets.yard[i] = 1;
    if (soft(i) && near(GROUND.plaza)) sets.plaza_edge[i] = 1;
    if (soft(i) && near(GROUND.sidewalk)) sets.sidewalk_edge[i] = 1;
    if (g[i] === GROUND.water && (near(GROUND.grass) || near(GROUND.park) || near(GROUND.path) || near(GROUND.garden))) sets.water_edge[i] = 1;
  }
  return sets;
}

/** Trees and props from the decoration rules; identical for a given town and seed. */
export function decorate(town: CompiledTown, seed: number): DecorationItem[] {
  const { width, height, def } = town;
  const n = width * height;
  const sets = groundSets(town);
  const used = new Uint8Array(n);
  const out: DecorationItem[] = [];
  for (const f of def.decoration.fixed) {
    used[f.cell[1] * width + f.cell[0]] = 1;
    out.push({ kind: f.kind, cell: [f.cell[0], f.cell[1]], yaw: f.yaw ?? 0 });
  }
  const byKind = new Map<DecoKind, Uint8Array>();
  def.decoration.rules.forEach((rule, ri) => {
    const districtIdx = rule.district ? def.districts.findIndex((d) => d.id === rule.district) : -1;
    const eligible: number[] = [];
    for (let i = 0; i < n; i++) {
      if (used[i] || !rule.on.some((on) => sets[on][i])) continue;
      if (districtIdx >= 0 && town.districtAt[i] !== districtIdx) continue;
      eligible.push(i);
    }
    const target = Math.floor((eligible.length * rule.density) / 100);
    const order = eligible.map((i) => [hash32(seed, 'deco', ri, i), i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let kindMap = byKind.get(rule.kind);
    if (!kindMap) byKind.set(rule.kind, (kindMap = new Uint8Array(n)));
    const r = rule.minSpacing - 1;
    let placed = 0;
    for (const [, i] of order) {
      if (placed >= target) break;
      if (used[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      let clear = true;
      for (let dy = -r; dy <= r && clear; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && kindMap[ny * width + nx]) {
            clear = false;
            break;
          }
        }
      }
      if (!clear) continue;
      used[i] = 1;
      kindMap[i] = 1;
      placed++;
      out.push({ kind: rule.kind, cell: [x, y], yaw: ((hash32(seed, 'yaw', i) % 4) * 90) as DecorationItem['yaw'] });
    }
  });
  return out;
}

/** Whether a decoration item stands inside `rect` (for renderers bucketing by chunk). */
export function decorationIn(items: readonly DecorationItem[], rect: [number, number, number, number]): DecorationItem[] {
  return items.filter((d) => inRect(d.cell, rect));
}
