/**
 * The engine's contracts: world creation, inputs and their provenance (P1,
 * P3), per-tick invariants (positions, occupancy, needs, P6) and
 * explanations built only from recorded decisions (P10).
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SOURCES,
  CommandSourceSchema,
  NEED_MAX,
  SIMULATED_DECISION_LABEL,
  WORLD_COMMAND_TYPES,
  decodeRoute,
  isSourceAllowed,
  placeId,
  residentId,
  type CommandEnvelope,
  type CommandSource,
  type WorldCommand,
  type WorldCommandType,
  type WorldEvent,
} from '@runloop-world/events';
import { inRect, outdoorGrid } from '@runloop-world/town';
import { assignmentsOf, buildRoster, cellNow, createWorld, explain, simIndex, validateCommand } from '../src/index';
import { AGENT, AGENT_B, RUN, between, commons, newWorld, runUntil, scriptedCommands } from './helpers';

const town = commons();

describe('createWorld', () => {
  const drafts = createWorld(town, { worldId: 'w', seed: 42, population: 80 });

  it('starts with world.created at 08:00 on Day 1, then one first decision per resident', () => {
    const created = drafts[0]!;
    expect(created.type).toBe('world.created');
    expect(created.tick).toBe(8 * 60);
    if (created.type !== 'world.created') return;
    expect(created.p).toMatchObject({ worldId: 'w', townId: town.def.id, contentHash: town.contentHash, seed: 42, simVersion: 1, startTick: 480 });
    expect(created.p.roster).toHaveLength(80);
    const decided = drafts.filter((d) => d.type === 'resident.decided');
    expect(decided).toHaveLength(80);
    for (const d of decided) if (d.type === 'resident.decided') expect(d.p.reason).toBe('start');
    expect(drafts.every((d) => d.tick === 480)).toBe(true);
  });

  it('builds a roster from the town: role shares, homes with a bed each, workplaces of the role, unique names', () => {
    const roster = buildRoster(town, 42, 120);
    expect(roster.map((r) => r.id)).toEqual(Array.from({ length: 120 }, (_, i) => residentId(i)));
    expect(new Set(roster.map((r) => r.name)).size).toBe(120);
    const roles = new Map(town.def.roles.map((r) => [r.id, r]));
    const perHome = new Map<string, number>();
    for (const r of roster) {
      const home = town.buildingById.get(r.homeId)!;
      expect(home.isHome).toBe(true);
      perHome.set(r.homeId, (perHome.get(r.homeId) ?? 0) + 1);
      const role = roles.get(r.role)!;
      if (role.work) expect(role.work.buildings).toContain(r.workId);
      else expect(r.workId).toBeNull();
      expect(r.outfit.style).toBe(role.outfit);
    }
    for (const [id, n] of perHome) expect(n).toBeLessThanOrEqual(town.buildingById.get(id)!.slots.filter((s) => s.tags.includes('sleep')).length);
    // Every resident gets their own bed and (with a workplace) their own work slot.
    const a = assignmentsOf(simIndex(town), roster.map((r, idx) => ({ ...r, idx }) as never));
    expect(a.list.every((x) => x.bed)).toBe(true);
    roster.forEach((r, i) => expect(a.list[i]!.work !== null).toBe(r.workId !== null));
    const shares = town.def.roles.reduce((n, r) => n + r.share, 0);
    for (const role of town.def.roles) {
      const n = roster.filter((r) => r.role === role.id).length;
      expect(Math.abs(n - (120 * role.share) / shares)).toBeLessThan(1);
    }
  });

  it('is a pure function of town, seed and population', () => {
    expect(createWorld(town, { worldId: 'w', seed: 42, population: 80 })).toEqual(drafts);
    expect(createWorld(town, { worldId: 'w', seed: 43, population: 80 })).not.toEqual(drafts);
    expect(() => createWorld(town, { worldId: 'w', seed: 1, population: town.def.population.max + 1 })).toThrow(/exceeds/);
  });
});

describe('inputs and provenance', () => {
  it('rejects every forbidden source with forbidden_source, logged with the sender as provenance (P3)', () => {
    const run = newWorld({ strict: true });
    between(run, run.tick, [{ id: `house:${AGENT}`, source: 'user', command: { type: 'agent.house', agentId: AGENT, lotId: 'lot_agent_1', displayName: 'A', hue: '#5aa9f5' } }]);
    const commands: Record<WorldCommandType, WorldCommand> = {
      'clock.set': { type: 'clock.set', speed: 4 },
      'building.set_open': { type: 'building.set_open', buildingId: 'bld_corner_cafe', open: false },
      'agent.house': { type: 'agent.house', agentId: AGENT_B, lotId: 'lot_agent_2', displayName: 'B', hue: '#e0946a' },
      'agent.connection': { type: 'agent.connection', agentId: AGENT, health: 'live', attention: 'none' },
      'agent.session': { type: 'agent.session', agentId: AGENT, runId: RUN, phase: 'started' },
      'agent.activity': { type: 'agent.activity', agentId: AGENT, runId: RUN, counts: {}, execState: 'working', helpers: 0, openIncidents: 0 },
      'agent.dispatch': { type: 'agent.dispatch', agentId: AGENT, dispatchId: 'dsp_0c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5', phase: 'approved' },
    };
    let n = 0;
    for (const type of WORLD_COMMAND_TYPES) {
      for (const source of CommandSourceSchema.options as readonly CommandSource[]) {
        if (isSourceAllowed(type, source)) continue;
        const id = `forbidden:${n++}`;
        const env: CommandEnvelope = {
          id,
          source,
          command: commands[type],
          ...(type === 'agent.session' || type === 'agent.activity' ? { cause: { runId: RUN, seqFrom: 1, seqTo: 1 } } : {}),
        };
        expect(validateCommand(run.state, town, env)).toEqual({ ok: false, code: 'forbidden_source' });
        const [e] = between(run, run.tick, [env]);
        expect(e).toMatchObject({ type: 'command.rejected', prov: source, cmdId: id, p: { cmdId: id, code: 'forbidden_source' } });
      }
    }
    // Every (type, source) pair outside ALLOWED_SOURCES was tried.
    const forbidden = WORLD_COMMAND_TYPES.reduce((k, t) => k + 3 - (ALLOWED_SOURCES[t] as readonly string[]).length, 0);
    expect(n).toBe(forbidden);
  });

  it('applies the entity rules: unknown_entity, lot_unavailable, not_housed, invalid', () => {
    const run = newWorld();
    const house = (id: string, agentId: string, lotId: string): CommandEnvelope => ({ id, source: 'user', command: { type: 'agent.house', agentId, lotId, displayName: 'A', hue: '#5aa9f5' } });
    const code = (env: CommandEnvelope) => {
      const [e] = between(run, run.tick, [env]);
      return e!.type === 'command.rejected' ? e!.p.code : 'ok';
    };
    expect(code({ id: 'c1', source: 'user', command: { type: 'agent.connection', agentId: AGENT, health: 'live', attention: 'none' } })).toBe('forbidden_source');
    expect(code({ id: 'c2', source: 'system', command: { type: 'agent.connection', agentId: AGENT, health: 'live', attention: 'none' } })).toBe('not_housed');
    expect(code({ id: 'c3', source: 'external-agent', cause: { runId: RUN, seqFrom: 1, seqTo: 2 }, command: { type: 'agent.session', agentId: AGENT, runId: RUN, phase: 'started' } })).toBe('not_housed');
    expect(code(house('h1', AGENT, 'lot_nowhere'))).toBe('unknown_entity');
    expect(code(house('h2', AGENT, 'lot_corner_cafe'))).toBe('lot_unavailable');
    expect(code(house('h3', AGENT, 'lot_agent_3'))).toBe('ok');
    expect(code(house('h4', AGENT_B, 'lot_agent_3'))).toBe('lot_unavailable');
    expect(code(house('h5', AGENT, 'lot_agent_4'))).toBe('invalid');
    expect(code({ id: 'b1', source: 'user', command: { type: 'building.set_open', buildingId: 'bld_agent_hq_3', open: false } })).toBe('unknown_entity');
    expect(code({ id: 'c4', source: 'system', command: { type: 'agent.connection', agentId: AGENT, health: 'live', attention: 'none' } })).toBe('ok');
    expect(run.state.agents).toHaveLength(1);
    expect(run.state.agents[0]).toMatchObject({ agentId: AGENT, lotId: 'lot_agent_3', buildingId: 'bld_agent_hq_3', health: 'live' });
  });

  it('gives effects their source’s provenance (or inferred), and only residents simulation provenance (P1)', () => {
    const run = newWorld({ strict: true });
    const start = run.tick;
    runUntil(run, start + 480, { inputs: scriptedCommands(start) });
    const byCmd = new Map<string, WorldEvent>();
    for (const e of run.events) if (e.cmdId) byCmd.set(e.cmdId, e);
    expect(byCmd.get(`house:${AGENT}`)).toMatchObject({ type: 'agent.housed', prov: 'user' });
    expect(byCmd.get(`conn:${AGENT}:1`)).toMatchObject({ type: 'agent.connection_changed', prov: 'system' });
    expect(byCmd.get(`sess:${RUN}:start:1`)).toMatchObject({ type: 'agent.session_changed', prov: 'external-agent', obs: 'observed', cause: { runId: RUN } });
    expect(byCmd.get(`act:${RUN}:14`)).toMatchObject({ type: 'agent.activity_observed', prov: 'external-agent', obs: 'observed' });
    expect(byCmd.get(`house:${AGENT_B}`)).toMatchObject({ type: 'command.rejected', prov: 'system', p: { code: 'lot_unavailable' } });
    expect(byCmd.get('clock:forbidden')).toMatchObject({ type: 'command.rejected', prov: 'system', p: { code: 'forbidden_source' } });
    expect(byCmd.get(`sess:${RUN}:end`)).toMatchObject({ type: 'agent.session_changed', prov: 'inferred', p: { phase: 'ended', outcome: 'interrupted' } });
    expect(byCmd.get(`sess:${RUN}:end`)!.obs).toBeUndefined();
    for (const e of run.events) {
      if (e.cmdId) continue;
      // Everything not caused by a command is the engine's (residents) or the world's own record.
      expect(e.prov === 'simulation' || (e.prov === 'system' && e.type === 'world.created'), `${e.seq} ${e.type}`).toBe(true);
      if (e.prov === 'simulation') expect(e.type).toMatch(/^(resident\.|interaction\.)/);
    }
    expect(run.state.speed).toBe(4);
    expect(run.state.prevSpeed).toBe(4);
  });

  it('pausing keeps only the input phase: agents update, residents hold', () => {
    const run = newWorld();
    between(run, run.tick, [{ id: 'p', source: 'user', command: { type: 'clock.set', speed: 0 } }]);
    expect(run.state.prevSpeed).toBe(1);
    const before = run.events.length;
    runUntil(run, run.tick + 30, {
      inputs: new Map([[run.tick + 5, [{ id: `house:${AGENT}`, source: 'user', command: { type: 'agent.house', agentId: AGENT, lotId: 'lot_agent_2', displayName: 'A', hue: '#5aa9f5' } }]]]),
    });
    expect(run.events.slice(before).map((e) => e.type)).toEqual(['agent.housed']);
  });
});

describe('a day in the Commons holds its invariants every tick', () => {
  const run = newWorld({ strict: true });
  const ix = simIndex(town);
  const grid = outdoorGrid(town);
  const agentLots = town.agentLots;
  const problems: string[] = [];
  runUntil(run, run.tick + 1440, {
    each: (t) => {
      const held = new Set<string>();
      const occupancy = new Map<string, number>();
      for (const r of run.state.residents) {
        const cell = cellNow(ix, r, t);
        const [x, y] = [cell % town.width, Math.floor(cell / town.width)];
        if (!grid.isWalkable(x, y)) problems.push(`${t} ${r.id} stands on ${x},${y}`);
        for (const n of r.needs) if (n.v0 < 0 || n.v0 > NEED_MAX) problems.push(`${t} ${r.id} need ${n.v0}`);
        const where = r.motion ? null : placeId(r.place);
        if (r.place.kind === 'building') occupancy.set(r.place.buildingId, (occupancy.get(r.place.buildingId) ?? 0) + 1);
        if (where && r.slotId) {
          const k = `${where}/${r.slotId}`;
          if (held.has(k)) problems.push(`${t} two residents hold ${k}`);
          held.add(k);
        }
        if (where && agentLots.some((l) => l.buildingId === where)) problems.push(`${t} ${r.id} is in an agent building`);
      }
      for (const b of run.state.buildings) {
        const def = town.buildingById.get(b.id)!;
        if (b.occupancy !== (occupancy.get(b.id) ?? 0)) problems.push(`${t} ${b.id} occupancy ${b.occupancy}`);
        if (b.occupancy > def.slots.length) problems.push(`${t} ${b.id} over capacity`);
      }
    },
  });

  it('keeps everyone on walkable cells, one per slot, within capacity and with needs in [0, 100]', () => {
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('walks 4-connected routes on walkable cells that never enter an agent lot and end at the chosen door or spot (P6)', () => {
    const decided = new Map<number, Extract<WorldEvent, { type: 'resident.decided' }>>();
    let routes = 0;
    for (const e of run.events) {
      if (e.type === 'resident.decided') decided.set(e.p.r, e);
      if (e.type !== 'resident.departed') continue;
      routes++;
      const path = decodeRoute(e.p.route);
      expect(e.p.dest).toEqual(decided.get(e.p.r)!.p.place);
      for (const c of path) {
        expect(grid.isWalkable(c[0], c[1])).toBe(true);
        for (const l of agentLots) expect(inRect(c, l.rect), `route through ${l.id}`).toBe(false);
      }
      const end = path.at(-1)!;
      if (e.p.dest.kind === 'building') expect(end).toEqual(town.buildingById.get(e.p.dest.buildingId)!.def.door);
      else expect(town.spotById.get(e.p.dest.spotId!)!.def.cells).toContainEqual(end);
    }
    expect(routes).toBeGreaterThan(200);
  });

  it('explains every decision only from its recorded fields, and the choice is the argmax of top (P10)', () => {
    const seqs = new Set(run.events.map((e) => e.seq));
    let n = 0;
    for (const e of run.events) {
      if (e.type !== 'resident.decided') continue;
      const top = e.p.top;
      expect(top[0]![2]).toBe(Math.max(...top.map((o) => o[2])));
      expect([top[0]![0], top[0]![1]]).toEqual([e.p.a, placeId(e.p.place)]);
      const x = explain(e, town, run.state.residents[e.p.r]!.role);
      expect(x.label).toBe(SIMULATED_DECISION_LABEL);
      expect(x.subject).toEqual({ kind: 'resident', id: residentId(e.p.r) });
      expect(x.atSeq).toBe(e.seq);
      expect([x.chosen.action, x.chosen.placeId, x.chosen.total]).toEqual([top[0]![0], top[0]![1], top[0]![2]]);
      expect(x.alternatives.map((a) => a.total)).toEqual(top.slice(1).map((o) => o[2]));
      for (const f of [...x.chosen.factors, ...x.alternatives.flatMap((a) => a.factors)]) {
        expect(seqs.has(f.source.seq)).toBe(true);
        expect(f.source.seq).toBe(e.seq);
        expect(f.source.field).toMatch(/^(reason|needs\[[0-2]\]|top\[[0-2]\]\[[2-5]\])$/);
        expect(f.text.length).toBeGreaterThan(0);
      }
      expect(x.chosen.factors[0]!.source.field).toBe('reason');
      n++;
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('cites the need values exactly as recorded (e.g. "Hunger 72/100 ← needs[0]")', () => {
    const e = run.events.find((x) => x.type === 'resident.decided' && x.p.a === 'eat' && x.p.top[0]![3] > 0)!;
    if (e.type !== 'resident.decided') return;
    const x = explain(e, town);
    const hunger = x.chosen.factors.find((f) => f.source.field === 'needs[0]')!;
    expect(hunger.text).toBe(`Hunger ${Math.floor(e.p.needs[0] / 1000)}/100`);
  });
});
