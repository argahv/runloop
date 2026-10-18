import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { TownPlaces, cutRect } from '../place';
import { commons } from '../test-helpers';
import { GeoBuilder } from './builder';
import { buildBuildings } from './buildings';
import { buildDecoration } from './deco';
import { buildingFrame } from './frame';
import { buildGround, buildRoadPaint, buildWater } from './ground';
import { buildInterior, type WallSide } from './interior';

const tris = (g: BufferGeometry | null) => (g ? g.getAttribute('position').count / 3 : 0);
const finite = (g: BufferGeometry | null) => !g || Array.from(g.getAttribute('position').array as Float32Array).every(Number.isFinite);

describe('static town geometry (built once per town)', () => {
  const town = commons();
  const places = new TownPlaces(town);

  it('builds every layer with finite vertices and within the triangle budget', () => {
    const ground = buildGround(town).map((g) => g.build());
    const bgb = new GeoBuilder();
    const signs = buildBuildings(town, bgb);
    const buildings = bgb.build();
    const deco = buildDecoration(town, places, 42).build();
    const all = [...ground, buildRoadPaint(town).build(), buildWater(town).build(), buildings, deco];
    for (const g of all) expect(finite(g)).toBe(true);
    const total = all.reduce((n, g) => n + tris(g), 0);
    // The whole static town stays well under the 400k frame budget, leaving room for residents and interiors.
    expect(total).toBeLessThan(260_000);
    // Each signed building gets its façade sign and a two-sided blade sign.
    expect(signs.length).toBe(town.buildings.filter((b) => b.def.sign).length * 3);
  });

  it('tags every building’s vertices with its index (lit windows, cutaway)', () => {
    const gb = new GeoBuilder();
    buildBuildings(town, gb);
    const meta = gb.build()!.getAttribute('aMeta');
    const seen = new Set<number>();
    for (let i = 0; i < meta.count; i++) seen.add(meta.getY(i));
    for (const b of town.buildings) expect(seen.has(b.idx + 1), b.def.id).toBe(true);
  });

  it('decorates deterministically for a seed', () => {
    const a = buildDecoration(town, places, 7).build()!;
    const b = buildDecoration(town, places, 7).build()!;
    expect(Array.from(a.getAttribute('position').array as Float32Array)).toEqual(Array.from(b.getAttribute('position').array as Float32Array));
  });

  it('anchors decoration to its cell, so what stands in front of an open interior can be hidden whole', () => {
    const g = buildDecoration(town, places, 42).build()!;
    const meta = g.getAttribute('aMeta');
    const pos = g.getAttribute('position');
    let anchored = 0;
    for (let i = 0; i < meta.count; i++) {
      const a = meta.getW(i);
      if (a === 0) continue;
      anchored++;
      const cell = a - 1;
      const cx = cell % town.width;
      const cy = Math.floor(cell / town.width);
      expect(Number.isInteger(a) && cy < town.height).toBe(true);
      // Within a few cells of its anchor (a tree's crown overhangs a little).
      expect(Math.abs(pos.getX(i) - (cx - (town.width - 1) / 2))).toBeLessThan(2);
      expect(Math.abs(pos.getZ(i) - (cy - (town.height - 1) / 2))).toBeLessThan(2);
    }
    expect(anchored).toBeGreaterThan(meta.count / 3);
  });

  it('cuts the cells in front of an open interior (toward the camera), and nothing when closed', () => {
    const cafe = town.def.buildings.find((b) => b.id === 'bld_corner_cafe') ?? town.def.buildings[0]!;
    const [x, y, w, h] = cafe.footprint;
    expect(cutRect(town, null, Math.PI / 4)).toBeNull();
    expect(cutRect(town, cafe.id, Math.PI / 4)).toEqual([x - 1, y - 1, x + w + 3, y + h + 3]);
    expect(cutRect(town, cafe.id, (5 * Math.PI) / 4)).toEqual([x - 3, y - 3, x + w + 1, y + h + 1]);
    const lot = town.agentLots[0]!;
    const r = cutRect(town, lot.buildingId!, Math.PI / 4)!;
    expect(r[0]).toBeLessThanOrEqual(lot.rect[0]);
    expect(r[3]).toBe(lot.rect[1] + lot.rect[3] + 3);
  });

  it('builds every grid interior for every cutaway, with furniture inside the footprint', () => {
    const sides: WallSide[][] = [[], ['front', 'right'], ['front', 'left'], ['back', 'left'], ['back', 'right']];
    for (const b of town.buildings) {
      const interior = town.interiors[b.def.interior];
      if (!interior || interior.kind !== 'grid') continue;
      const f = buildingFrame(town, b);
      for (const cut of sides) {
        const g = buildInterior(interior, f, b.def.palette.wall, b.def.palette.trim, new Set(cut)).build()!;
        expect(finite(g)).toBe(true);
        g.computeBoundingBox();
        const bb = g.boundingBox!;
        const [x, y, w, h] = b.def.footprint;
        const half = (n: number) => n / 2 + 0.05;
        const cx = x + (w - 1) / 2 - (town.width - 1) / 2;
        const cz = y + (h - 1) / 2 - (town.height - 1) / 2;
        expect(bb.min.x).toBeGreaterThanOrEqual(cx - half(w));
        expect(bb.max.x).toBeLessThanOrEqual(cx + half(w));
        expect(bb.min.z).toBeGreaterThanOrEqual(cz - half(h));
        expect(bb.max.z).toBeLessThanOrEqual(cz + half(h));
      }
    }
  });
});
