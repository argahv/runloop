import { describe, expect, it } from 'vitest';
import { deltaE2000 } from '../color';
import { skyAt } from '../sky';
import { commons } from '../test-helpers';
import { LIME, SEMANTIC } from '../townPalette';
import { CAR_COLORS, FIELD_TONES, LAND_COLORS, TREE_TONES, buildClouds, buildCountryWater, buildFarms, buildFields, buildMountains, buildRoadsOut, buildTerrain, treeGeometry } from './surroundMeshes';
import { AMBIENT_CLEARANCE, LAND_Y, birdPose, carPose, rectDist, surroundLayout, terrainHeight } from './surroundings';

const town = commons();
const L = surroundLayout(town, 42);
const nearestLot = (x: number, z: number) => Math.min(...L.agentRects.map((r) => rectDist(x, z, r)));
const tris = (g: { getAttribute(n: string): { count: number }; index: { count: number } | null } | null) => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);

describe('the land beyond the town (immersive contract §3)', () => {
  it('lays out roads out, the Brook, a lake, farms, fields, trees, cars and birds', () => {
    expect(L.roads.filter((r) => r.kind === 'road').map((r) => r.id).sort()).toEqual(['road_out_east', 'road_out_north', 'road_out_south', 'road_out_west']);
    expect(L.farms.length).toBe(8);
    expect(L.fields.length).toBeGreaterThan(20);
    expect(L.trees.length).toBeGreaterThan(400);
    expect(L.trees.length).toBeLessThanOrEqual(1500);
    expect(L.cars.reduce((a, c) => a + c.cars, 0)).toBeLessThanOrEqual(10);
    expect(L.cars.reduce((a, c) => a + c.liteCars, 0)).toBeLessThanOrEqual(4);
    expect(L.flocks.length).toBeGreaterThanOrEqual(2);
    expect(L.bridges.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic', () => {
    const again = surroundLayout(town, 42);
    expect(again.trees).toEqual(L.trees);
    expect(again.fields).toEqual(L.fields);
    expect(again.farms).toEqual(L.farms);
  });

  it('keeps every decorative car, bird and farm at least 12 cells from every agent lot (W2)', () => {
    const car = { x: 0, z: 0, yaw: 0 };
    for (const r of L.cars) {
      for (let i = 0; i < r.cars; i++) {
        for (let t = 0; t < 600; t += 0.37) {
          carPose(r, i, t, car);
          expect(nearestLot(car.x, car.z)).toBeGreaterThanOrEqual(AMBIENT_CLEARANCE);
        }
      }
    }
    // Cars never use Ridge Road or Eastway (the ring roads by the Agent District).
    const ridge = town.def.roads.find((r) => r.id === 'road_ridge')!;
    const eastway = town.def.roads.find((r) => r.id === 'road_eastway')!;
    const scene = (r: readonly number[]) => ({ x0: r[0]! - 48, z0: r[1]! - 36, x1: r[0]! + r[2]! - 48, z1: r[1]! + r[3]! - 36 });
    for (const r of L.cars) for (const p of r.pts) {
      expect(rectDist(p.x, p.z, scene(ridge.rect))).toBeGreaterThan(1);
      expect(rectDist(p.x, p.z, scene(eastway.rect))).toBeGreaterThan(1);
    }
    const bird = { x: 0, y: 0, z: 0, yaw: 0, flap: 0 };
    for (const f of L.flocks) {
      for (let i = 0; i < f.birds; i++) {
        for (let t = 0; t < 300; t += 0.5) {
          birdPose(f, i, t, bird);
          expect(nearestLot(bird.x, bird.z)).toBeGreaterThanOrEqual(AMBIENT_CLEARANCE);
          expect(rectDist(bird.x, bird.z, L.birdExclusion)).toBeGreaterThan(0);
        }
      }
    }
    for (const f of L.farms) expect(nearestLot(f.x, f.z) - 14).toBeGreaterThanOrEqual(AMBIENT_CLEARANCE);
  });

  it('holds still: positions are a function of ambient time only (paused = same time = same place)', () => {
    const a = { x: 0, z: 0, yaw: 0 };
    const b = { x: 0, z: 0, yaw: 0 };
    carPose(L.cars[0]!, 0, 123.4, a);
    carPose(L.cars[0]!, 0, 123.4, b);
    expect(a).toEqual(b);
  });

  it('meets the town flat at its edge and rises to hills in the north', () => {
    for (const [x, z] of [
      [0, -L.hz - 5],
      [L.hx + 10, 0],
      [0, L.hz + 2],
    ] as const)
      expect(terrainHeight(L, x, z)).toBe(LAND_Y);
    expect(terrainHeight(L, 150, -420)).toBeGreaterThan(10);
    // Flat under the Brook and the lake.
    expect(terrainHeight(L, 200, 38 + 20 + 5 * Math.sin(200 / 90 + 0.8) + 2.5 * Math.sin(200 / 37 + 2.1))).toBe(LAND_Y);
    expect(terrainHeight(L, L.lake.cx, L.lake.cz)).toBe(LAND_Y);
  });

  it('stays inside its budget: ≤ 70k triangles (trees ≤ 1,500 × 30)', () => {
    const tree = tris(treeGeometry());
    expect(tree).toBeLessThanOrEqual(30);
    const total =
      tris(buildTerrain(L, false)) +
      tris(buildRoadsOut(L).build()) +
      tris(buildFields(L).build()) +
      tris(buildFarms(L).gb.build()) +
      tris(buildCountryWater(L).build()) +
      tris(buildMountains()) +
      tris(buildClouds(16, 7).geometry) +
      L.trees.length * tree;
    expect(total).toBeLessThan(70_000);
  });

  it('builds finite geometry', () => {
    for (const g of [buildTerrain(L, true), buildRoadsOut(L).build()!, buildFields(L).build()!, buildFarms(L).gb.build()!, buildCountryWater(L).build()!, buildMountains()]) {
      const p = g.getAttribute('position').array as Float32Array;
      expect(p.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('keeps lime and the semantic colours out of the countryside and the sky', () => {
    const colours: Record<string, string> = {};
    for (const [k, v] of Object.entries(LAND_COLORS)) colours[`land.${k}`] = v;
    FIELD_TONES.forEach((c, i) => (colours[`field.${i}`] = c));
    TREE_TONES.forEach((c, i) => (colours[`tree.${i}`] = c));
    CAR_COLORS.forEach((c, i) => (colours[`car.${i}`] = c));
    for (let m = 0; m < 1440; m += 30) {
      const s = skyAt(m);
      for (const k of ['zenith', 'horizon', 'haze', 'cloud'] as const) colours[`sky.${k}.${m}`] = s[k];
    }
    const near: string[] = [];
    for (const [k, c] of Object.entries(colours)) {
      if (deltaE2000(c, LIME) < 12) near.push(`${k} ~ lime`);
      for (const [s, ref] of Object.entries(SEMANTIC)) if (deltaE2000(c, ref) < 12) near.push(`${k} ~ ${s}`);
    }
    expect(near).toEqual([]);
  });
});
