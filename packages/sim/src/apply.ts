/**
 * applyEvent: the only mutator of the world state, shared by the host, replay
 * and Studio. It follows the fold documented in @runloop-world/events
 * (world.ts) exactly; the S0 fixtures' reference fold checks it.
 *
 * For speed it updates `s` in place and returns it (a new state for
 * world.created). Callers that keep old states clone first (WorldReplay does).
 */
import { decodeRoute, type NeedRates, type NeedValues, type ResidentState, type WorldEvent, type WorldSnapshot } from '@runloop-world/events';

/** The whole sim state. It is the snapshot (no hidden fields), so Studio folds the stream with the same applyEvent. */
export type SimState = WorldSnapshot;

/** What world.created needs from the town: its building ids, in file order. */
export interface TownBuildingList {
  def: { buildings: readonly { id: string }[] };
}

function tracks(needs: NeedValues, rates: NeedRates, tick: number): ResidentState['needs'] {
  return [
    { v0: needs[0], rate: rates[0], t0: tick },
    { v0: needs[1], rate: rates[1], t0: tick },
    { v0: needs[2], rate: rates[2], t0: tick },
  ];
}

function resident(s: SimState, r: number): ResidentState {
  const res = s.residents[r];
  if (!res) throw new Error(`applyEvent: no resident ${r}`);
  return res;
}

function agent(s: SimState, agentId: string): SimState['agents'][number] {
  const a = s.agents.find((x) => x.agentId === agentId);
  if (!a) throw new Error(`applyEvent: agent ${agentId} is not housed`);
  return a;
}

function occupancyDelta(s: SimState, place: ResidentState['place'], delta: number): void {
  if (place.kind !== 'building') return;
  const b = s.buildings.find((x) => x.id === place.buildingId);
  if (b) b.occupancy += delta;
}

/** The only mutator. `s` is null only before world.created, which also needs `town` (its building list). */
export function applyEvent(s: SimState | null, e: WorldEvent, town?: TownBuildingList): SimState {
  if (e.type === 'world.created') {
    if (!town) throw new Error('applyEvent: world.created needs the town (its buildings)');
    const p = e.p;
    const state: SimState = {
      worldId: p.worldId,
      simVersion: p.simVersion,
      contentHash: p.contentHash,
      seq: e.seq,
      tick: e.tick,
      speed: 1,
      prevSpeed: 1,
      residents: p.roster.map((r, idx) => ({
        ...r,
        idx,
        place: { kind: 'building', buildingId: r.homeId },
        slotId: null,
        action: 'rest',
        motion: null,
        needs: tracks([0, 0, 0], [0, 0, 0], p.startTick),
        until: p.startTick,
        lastDecisionSeq: 0,
      })),
      buildings: town.def.buildings.map((b) => ({ id: b.id, open: true, occupancy: 0 })),
      agents: [],
      affinity: {},
    };
    for (const r of state.residents) occupancyDelta(state, r.place, 1);
    return state;
  }
  if (!s) throw new Error(`applyEvent: ${e.type} before world.created`);
  s.seq = e.seq;
  s.tick = e.tick;
  switch (e.type) {
    case 'resident.decided': {
      const r = resident(s, e.p.r);
      r.action = e.p.a;
      r.slotId = e.p.slotId;
      r.until = e.p.until;
      r.lastDecisionSeq = e.seq;
      r.needs = tracks(e.p.needs, e.p.rates, e.tick);
      break;
    }
    case 'resident.departed': {
      const r = resident(s, e.p.r);
      occupancyDelta(s, r.place, -1);
      r.place = { kind: 'outdoor', spotId: null };
      r.motion = { path: decodeRoute(e.p.route), startTick: e.p.startTick };
      break;
    }
    case 'resident.arrived': {
      const r = resident(s, e.p.r);
      occupancyDelta(s, r.place, -1);
      r.place = e.p.place.kind === 'building' ? { kind: 'building', buildingId: e.p.place.buildingId } : { kind: 'outdoor', spotId: e.p.place.spotId };
      occupancyDelta(s, r.place, 1);
      r.slotId = e.p.slotId;
      r.motion = null;
      r.needs = tracks(e.p.needs, e.p.rates, e.tick);
      break;
    }
    case 'interaction.happened': {
      const k = `${e.p.a}:${e.p.b}`;
      s.affinity[k] = (s.affinity[k] ?? 0) + e.p.dAffinity;
      break;
    }
    case 'world.clock_changed':
      s.speed = e.p.speed;
      s.prevSpeed = e.p.prevSpeed;
      break;
    case 'building.open_changed': {
      const b = s.buildings.find((x) => x.id === e.p.buildingId);
      if (!b) throw new Error(`applyEvent: unknown building ${e.p.buildingId}`);
      b.open = e.p.open;
      break;
    }
    case 'agent.housed':
      s.agents.push({
        agentId: e.p.agentId,
        buildingId: e.p.buildingId,
        lotId: e.p.lotId,
        displayName: e.p.displayName,
        hue: e.p.hue,
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
    case 'agent.connection_changed': {
      const a = agent(s, e.p.agentId);
      a.health = e.p.health;
      a.attention = e.p.attention;
      break;
    }
    case 'agent.session_changed': {
      const a = agent(s, e.p.agentId);
      if (e.p.phase === 'started') {
        a.activeRunId = e.p.runId;
        a.counts = {};
        a.execState = 'working';
        a.helpers = 0;
        a.openIncidents = 0;
      } else {
        a.activeRunId = null;
        a.execState = 'idle';
      }
      a.lastCause = e.cause ?? null;
      break;
    }
    case 'agent.activity_observed': {
      const a = agent(s, e.p.agentId);
      a.counts = { ...e.p.counts };
      a.execState = e.p.execState;
      a.helpers = e.p.helpers;
      a.openIncidents = e.p.openIncidents;
      a.lastCause = e.cause ?? null;
      break;
    }
    case 'agent.dispatch_changed':
      agent(s, e.p.agentId).dispatch = {
        dispatchId: e.p.dispatchId,
        phase: e.p.phase,
        ...(e.p.outcome !== undefined ? { outcome: e.p.outcome } : {}),
      };
      break;
    case 'world.resumed_after_offline':
    case 'world.sim_upgraded':
    case 'command.rejected':
      break;
  }
  return s;
}

/** Fold a list of events (from world.created, or onto a copy of `from`). */
export function foldEvents(events: readonly WorldEvent[], town?: TownBuildingList, from: SimState | null = null): SimState {
  let s = from;
  for (const e of events) s = applyEvent(s, e, town);
  if (!s) throw new Error('foldEvents: no world.created');
  return s;
}
