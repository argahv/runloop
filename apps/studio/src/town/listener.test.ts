import { describe, expect, it } from 'vitest';
import { DEG, viewOf } from './cameraMath';
import { sceneX, sceneZ } from './coords';
import { rectDist, surroundLayout } from './geometry/surroundings';
import { computeListener, fixedSources } from './listener';
import { commons, fixtureSnapshot } from './test-helpers';

const town = commons();
const layout = surroundLayout(town, 42);
const fixed = fixedSources(town, layout);
const f = { width: town.width, height: town.height };

function listenAt(gx: number, gy: number, zoom: number) {
  const view = viewOf({ x: sceneX(f, gx), z: sceneZ(f, gy), zoom, az: 45 * DEG, tilt: 37 * DEG }, { width: 1440, height: 900 });
  return computeListener({ town, snapshot: fixtureSnapshot(), layout, fixed, view, fit: 10, street: 51, level: 'street', entered: null, minute: 720, night: 0, paused: false });
}

describe('the soundscape listener (TownListener, contract §4b)', () => {
  it('hears the busy café and the fountain by the Civic Atrium, panned within the stereo field', () => {
    const l = listenAt(36, 40, 51);
    expect(l.zoom01).toBe(1);
    expect(l.x).toBeCloseTo(36, 6);
    for (const s of l.sources) {
      expect(s.gain).toBeGreaterThan(0);
      expect(s.gain).toBeLessThanOrEqual(1);
      expect(Math.abs(s.pan)).toBeLessThanOrEqual(1);
    }
    expect(l.sources.some((s) => s.kind === 'water' && s.id === 'lmk_fountain')).toBe(true);
    expect(l.sources.length).toBeLessThanOrEqual(12);
  });

  it('never places a source inside an agent lot (murmur is simulated occupancy at town amenities only)', () => {
    const agentLots = town.agentLots.map((lot) => {
      const [x, y, w, h] = lot.rect;
      return { x0: x - 0.5, z0: y - 0.5, x1: x + w - 0.5, z1: y + h - 0.5 };
    });
    for (const s of fixed) {
      const gx = s.x + (town.width - 1) / 2;
      const gy = s.z + (town.height - 1) / 2;
      for (const r of agentLots) expect(rectDist(gx, gy, r)).toBeGreaterThan(0);
    }
    // Standing in the Agent District, nothing murmurs from an agent's building.
    const l = listenAt(70, 10, 51);
    for (const s of l.sources) if (s.kind === 'murmur') expect(s.id.startsWith('bld_agent')).toBe(false);
  });

  it('reports zoom 0 at the whole town and the clock as given', () => {
    const l = listenAt(48, 36, 10);
    expect(l.zoom01).toBe(0);
    expect(l.minute).toBe(720);
    expect(l.paused).toBe(false);
  });
});
