import { applyEvent, type SimState } from '@runloop-world/sim';
import { describe, expect, it } from 'vitest';
import { positionAt } from '@runloop-world/world-engine';
import { TownPlaces, laneOffset } from './place';
import { ANIM } from './rig/residentRig';
import { commons, fixtureEvents, fixtureSnapshot } from './test-helpers';

describe('resident placement (reads ResidentState only)', () => {
  const town = commons();
  const places = new TownPlaces(town);
  const snap = fixtureSnapshot();

  it('places every resident of the fixture snapshot', () => {
    for (const r of snap.residents) {
      const p = places.pose(r, snap.tick);
      expect(p, r.id).not.toBeNull();
      if (!p) continue;
      expect(p.gx).toBeGreaterThanOrEqual(-0.5);
      expect(p.gy).toBeGreaterThanOrEqual(-0.5);
      expect(p.gx).toBeLessThan(town.width);
      expect(p.gy).toBeLessThan(town.height);
      if (r.place.kind === 'building' && !r.motion) expect(p.inside).toBe(r.place.buildingId);
      else expect(p.inside).toBeNull();
    }
    expect(snap.residents.filter((r) => places.pose(r, snap.tick)?.walking).length).toBeGreaterThan(10);
  });

  it('keeps walkers on walkable ground (within their lane offset)', () => {
    for (const r of snap.residents) {
      if (!r.motion) continue;
      for (let dt = 0; dt < 20; dt += 0.25) {
        const p = places.pose(r, snap.tick + dt)!;
        const cx = Math.round(p.gx);
        const cy = Math.round(p.gy);
        let ok = false;
        for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) ok = town.walkable[(cy + dy) * town.width + cx + dx] === 1;
        expect(ok, `${r.id} at ${p.gx},${p.gy}`).toBe(true);
      }
    }
  });

  it('walks exactly world-engine positionAt (plus the right-hand lane)', () => {
    for (const r of snap.residents) {
      if (!r.motion) continue;
      for (let dt = 0; dt < 12; dt += 0.37) {
        const p = places.pose(r, snap.tick + dt)!;
        const m = positionAt(r.motion, snap.tick + dt, 1 / town.def.walkCellsPerMinute);
        const lane = p.walking ? laneOffset(r.idx) : 0;
        expect(p.gx + p.dy * lane).toBeCloseTo(m.x, 6);
        expect(p.gy - p.dx * lane).toBeCloseTo(m.y, 6);
      }
    }
  });

  it('moves continuously while walking (no jumps between frames)', () => {
    for (const r of snap.residents) {
      if (!r.motion) continue;
      let prev = places.pose(r, snap.tick)!;
      for (let dt = 0.05; dt < 15; dt += 0.05) {
        const p = places.pose(r, snap.tick + dt)!;
        // 3 cells per tick → at most 0.15 cells per 0.05 tick, plus a lane swing at corners.
        expect(Math.hypot(p.gx - prev.gx, p.gy - prev.gy)).toBeLessThan(0.15 + 0.6);
        prev = p;
      }
    }
  });

  it('puts residents inside on furniture slots within their building footprint', () => {
    // Fold a little further so people are at work and at spots.
    let s: SimState = structuredClone(snap);
    for (const e of fixtureEvents()) if (e.seq > s.seq) s = applyEvent(s, e, town);
    let inside = 0;
    let atSpots = 0;
    for (const r of s.residents) {
      const p = places.pose(r, s.tick);
      if (!p) continue;
      if (p.inside && r.slotId) {
        inside++;
        const [x, y, w, h] = town.buildingById.get(p.inside)!.def.footprint;
        expect(p.gx >= x && p.gx < x + w && p.gy >= y && p.gy < y + h, `${r.id} ${r.slotId}`).toBe(true);
        expect(Math.hypot(p.dx, p.dy)).toBeCloseTo(1, 6);
      }
      if (!p.inside && !p.walking) {
        atSpots++;
        expect(Math.hypot(p.dx, p.dy)).toBeCloseTo(1, 6);
      }
      if (r.action === 'sleep' && p.inside && r.slotId) expect(p.anim).toBe(ANIM.sleep);
    }
    expect(inside).toBeGreaterThan(10);
    expect(atSpots + inside).toBeGreaterThan(0);
  });
});
