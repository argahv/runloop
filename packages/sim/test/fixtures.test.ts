/**
 * The fixture day (test/fixtures/README.md) is engine output and obeys the
 * contracts: it equals what generate.ts produces now, every event parses, the
 * snapshot is the fold of the events up to its seq (by applyEvent and by an
 * independent reference fold), positions are in the town, and the truth rules
 * hold.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorldSnapshotSchema,
  decodeRoute,
  parseWorldEvent,
  placeId,
  type WorldCell,
  type WorldEvent,
  type WorldSnapshot,
} from '@runloop-world/events';
import { parseInteriorDefinition, parseTownDefinition, townContentHash, type InteriorDefinition, type Rect } from '@runloop-world/town';
import { readCommons } from '../../town/test/load-commons';
import { foldEvents } from '../src/index';
import { formatEvents, formatSnapshot, generateFixtures } from './fixtures/generate';
import { commons as compiledCommons } from './helpers';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
const read = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8')) as unknown;

const rawEvents = read('commons-day1.events.json') as unknown[];
const snapshot = WorldSnapshotSchema.parse(read('commons-day1.snapshot.json'));
const events: WorldEvent[] = rawEvents.map((raw, i) => {
  const r = parseWorldEvent(raw);
  if (!r.ok) throw new Error(`event #${i + 1}: ${r.error}`);
  return r.event;
});

const commons = readCommons();
const town = parseTownDefinition(commons.town);
const interiors: Record<string, InteriorDefinition> = Object.fromEntries(
  Object.entries(commons.interiors).map(([id, d]) => [id, parseInteriorDefinition(d)]),
);
const buildings = new Map(town.buildings.map((b) => [b.id, b]));
const spots = new Map(town.spots.map((s) => [s.id, s]));
const inRect = ([x, y]: WorldCell, [rx, ry, rw, rh]: Rect) => x >= rx && y >= ry && x < rx + rw && y < ry + rh;
const agentLots = town.lots.filter((l) => l.use === 'agent');

/** The fold documented in packages/events/src/world.ts, written out independently of the sim. */
function referenceFold(list: readonly WorldEvent[]): WorldSnapshot {
  let s: WorldSnapshot | null = null;
  for (const e of list) {
    if (e.type === 'world.created') {
      s = {
        worldId: e.p.worldId,
        simVersion: e.p.simVersion,
        contentHash: e.p.contentHash,
        seq: e.seq,
        tick: e.tick,
        speed: 1,
        prevSpeed: 1,
        residents: e.p.roster.map((r, idx) => ({
          ...r,
          idx,
          place: { kind: 'building', buildingId: r.homeId },
          slotId: null,
          action: 'rest',
          motion: null,
          needs: [0, 1, 2].map(() => ({ v0: 0, rate: 0, t0: e.p.startTick })) as WorldSnapshot['residents'][number]['needs'],
          until: e.p.startTick,
          lastDecisionSeq: 0,
        })),
        buildings: town.buildings.map((b) => ({ id: b.id, open: true, occupancy: 0 })),
        agents: [],
        affinity: {},
      };
    }
    if (!s) throw new Error('events before world.created');
    s.seq = e.seq;
    s.tick = e.tick;
    const tracks = (needs: readonly number[], rates: readonly number[]) =>
      needs.map((v0, i) => ({ v0, rate: rates[i]!, t0: e.tick })) as WorldSnapshot['residents'][number]['needs'];
    const agent = (id: string) => s!.agents.find((a) => a.agentId === id)!;
    switch (e.type) {
      case 'resident.decided':
        Object.assign(s.residents[e.p.r]!, { action: e.p.a, slotId: e.p.slotId, until: e.p.until, lastDecisionSeq: e.seq, needs: tracks(e.p.needs, e.p.rates) });
        break;
      case 'resident.departed':
        Object.assign(s.residents[e.p.r]!, { place: { kind: 'outdoor', spotId: null }, motion: { path: decodeRoute(e.p.route), startTick: e.p.startTick } });
        break;
      case 'resident.arrived':
        Object.assign(s.residents[e.p.r]!, { place: e.p.place, slotId: e.p.slotId, motion: null, needs: tracks(e.p.needs, e.p.rates) });
        break;
      case 'interaction.happened': {
        const k = `${e.p.a}:${e.p.b}`;
        s.affinity[k] = (s.affinity[k] ?? 0) + e.p.dAffinity;
        break;
      }
      case 'world.clock_changed':
        s.speed = e.p.speed;
        s.prevSpeed = e.p.prevSpeed;
        break;
      case 'building.open_changed':
        s.buildings.find((b) => b.id === e.p.buildingId)!.open = e.p.open;
        break;
      case 'agent.housed':
        s.agents.push({
          ...e.p,
          health: 'not_connected',
          attention: 'none',
          activeRunId: null,
          counts: {},
          execState: 'idle',
          helpers: 0,
          openIncidents: 0,
          lastCause: null,
          dispatch: null,
        });
        break;
      case 'agent.connection_changed':
        Object.assign(agent(e.p.agentId), { health: e.p.health, attention: e.p.attention });
        break;
      case 'agent.session_changed':
        Object.assign(
          agent(e.p.agentId),
          e.p.phase === 'started'
            ? { activeRunId: e.p.runId, counts: {}, execState: 'working', helpers: 0, openIncidents: 0 }
            : { activeRunId: null, execState: 'idle' },
          { lastCause: e.cause ?? null },
        );
        break;
      case 'agent.activity_observed':
        Object.assign(agent(e.p.agentId), {
          counts: e.p.counts,
          execState: e.p.execState,
          helpers: e.p.helpers,
          openIncidents: e.p.openIncidents,
          lastCause: e.cause ?? null,
        });
        break;
      case 'agent.dispatch_changed':
        agent(e.p.agentId).dispatch = { dispatchId: e.p.dispatchId, phase: e.p.phase, ...(e.p.outcome ? { outcome: e.p.outcome } : {}) };
        break;
      default:
        break;
    }
    const occupancy = new Map<string, number>();
    for (const r of s.residents) if (r.place.kind === 'building') occupancy.set(r.place.buildingId, (occupancy.get(r.place.buildingId) ?? 0) + 1);
    for (const b of s.buildings) b.occupancy = occupancy.get(b.id) ?? 0;
  }
  if (!s) throw new Error('no world.created');
  return s;
}

/** Slot ids that exist at a place. */
function slotExists(place: string, slot: string): boolean {
  const spot = spots.get(place);
  if (spot) {
    const m = /^(.+)#(\d+)$/.exec(slot);
    return !!m && m[1] === place && Number(m[2]) < spot.cells.length;
  }
  const b = buildings.get(place);
  const m = /^([a-z0-9_]+)#(\d+)@(\d+)$/.exec(slot);
  const inner = b && interiors[b.interior];
  if (!m || !inner || inner.kind !== 'grid') return false;
  const f = inner.furniture.find((x) => x.id === m[1]);
  return !!f && Number(m[2]) < f.uses.length && Number(m[3]) < b.floors;
}

describe('fixture day: Runloop Commons, Day 1 from 08:00', () => {
  it('is exactly what the engine generates now (regenerate with `pnpm --filter @runloop-world/sim fixtures`)', () => {
    const fresh = generateFixtures();
    expect(formatEvents(fresh.events)).toBe(readFileSync(path.join(FIXTURES, 'commons-day1.events.json'), 'utf8'));
    expect(formatSnapshot(fresh.snapshot)).toBe(readFileSync(path.join(FIXTURES, 'commons-day1.snapshot.json'), 'utf8'));
  });

  it('are a valid, gap-free event log in tick order', () => {
    expect(events[0]!.type).toBe('world.created');
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      if (i) expect(e.tick).toBeGreaterThanOrEqual(events[i - 1]!.tick);
    });
  });

  it('were made for the committed town (regenerate them when the town changes; see README)', () => {
    const created = events[0]!;
    if (created.type !== 'world.created') throw new Error('first event');
    expect(created.p.contentHash).toBe(townContentHash(commons.town, commons.interiors));
    expect(snapshot.contentHash).toBe(created.p.contentHash);
    expect(created.p.townId).toBe(town.id);
    expect(created.p.roster).toHaveLength(town.population.default);
  });

  it('have a snapshot that is the fold of the events up to its seq (applyEvent and the reference fold), with events after it', () => {
    expect(snapshot.seq).toBeLessThan(events.length);
    expect(foldEvents(events.slice(0, snapshot.seq), compiledCommons())).toEqual(snapshot);
    expect(referenceFold(events.slice(0, snapshot.seq))).toEqual(snapshot);
    // A client holding the snapshot folds the tail to the end of the day.
    expect(foldEvents(events.slice(snapshot.seq), compiledCommons(), structuredClone(snapshot))).toEqual(foldEvents(events, compiledCommons()));
  });

  it('keep residents in the town: real homes, workplaces of their role, slots that exist', () => {
    const roles = new Map(town.roles.map((r) => [r.id, r]));
    for (const r of snapshot.residents) {
      expect(buildings.get(r.homeId)?.access).toBe('residents');
      const role = roles.get(r.role)!;
      expect(role).toBeDefined();
      if (r.workId) expect(role.work?.buildings).toContain(r.workId);
      else expect(role.work).toBeNull();
      if (r.place.kind === 'building') expect(buildings.has(r.place.buildingId)).toBe(true);
      else if (r.place.spotId) expect(spots.has(r.place.spotId)).toBe(true);
    }
    for (const e of events) {
      if (e.type !== 'resident.decided' && e.type !== 'resident.arrived') continue;
      if (e.p.slotId) expect(slotExists(placeId(e.p.place)!, e.p.slotId), `${e.seq} ${e.p.slotId}`).toBe(true);
    }
  });

  it('never put two residents in one slot or a building over capacity', () => {
    const held = new Set<string>();
    for (const r of snapshot.residents) {
      if (r.place.kind === 'outdoor' && r.place.spotId === null) continue;
      const k = `${placeId(r.place)}/${r.slotId}`;
      expect(held.has(k), k).toBe(false);
      held.add(k);
    }
    for (const b of snapshot.buildings) {
      const def = buildings.get(b.id)!;
      const inner = interiors[def.interior]!;
      const uses = inner.kind === 'grid' ? inner.furniture.reduce((n, f) => n + f.uses.length, 0) : 0;
      expect(b.occupancy).toBeLessThanOrEqual(uses * def.floors);
    }
  });

  it('walk 4-connected routes from where the resident was to where it decided to go', () => {
    const decidedAt = new Map<number, Extract<WorldEvent, { type: 'resident.decided' }>>();
    for (const e of events) {
      if (e.type === 'resident.decided') decidedAt.set(e.p.r, e);
      if (e.type !== 'resident.departed') continue;
      const path = decodeRoute(e.p.route);
      const dest = e.p.dest;
      expect(dest).toEqual(decidedAt.get(e.p.r)!.p.place);
      const end = path.at(-1)!;
      if (dest.kind === 'building') expect(end).toEqual(buildings.get(dest.buildingId)!.door);
      else expect(spots.get(dest.spotId!)!.cells).toContainEqual(end);
      for (const c of path) for (const l of agentLots) expect(inRect(c, l.rect), `route through ${l.id}`).toBe(false); // P6
    }
  });

  it('hold the truth rules: simulation only moves residents, agents sit on agent lots', () => {
    for (const e of events) {
      if (e.prov === 'simulation') expect(e.type).toMatch(/^(resident\.|interaction\.)/); // P1
      if (e.type === 'agent.housed') {
        const lot = town.lots.find((l) => l.id === e.p.lotId)!;
        expect(lot.use).toBe('agent');
        expect(e.p.buildingId).toBe(lot.buildingId);
      }
    }
    for (const r of snapshot.residents) {
      if (r.place.kind !== 'building') continue;
      expect(agentLots.some((l) => l.buildingId === (r.place as { buildingId: string }).buildingId)).toBe(false); // P6
    }
  });

  it('show a lively town: at least a quarter of residents outdoors and many walking at 08:15', () => {
    const outdoor = snapshot.residents.filter((r) => r.place.kind === 'outdoor').length;
    expect(outdoor / snapshot.residents.length).toBeGreaterThanOrEqual(0.25);
    expect(snapshot.residents.filter((r) => r.motion).length).toBeGreaterThan(10);
    expect(snapshot.agents.map((a) => a.health).sort()).toEqual(['awaiting_first_event', 'live']);
  });
});
