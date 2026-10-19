import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SOURCES,
  COMMAND_EFFECTS,
  CommandEnvelopeSchema,
  CommandSourceSchema,
  NEED_MAX,
  RESIDENT_ACTIONS,
  WORLD_COMMAND_TYPES,
  WORLD_EVENT_PROV,
  WORLD_EVENT_TYPES,
  WorldCommandSchema,
  WorldEventSchema,
  WorldSnapshotSchema,
  clockOf,
  decodeRoute,
  effectProvenance,
  encodeRoute,
  formatClock,
  formatEntityRef,
  RUNTIME_COMMAND_ID_PREFIXES,
  SHORT_LIVED_WORLD_EVENT_TYPES,
  isAmbientWorldEvent,
  isRuntimeCommandId,
  isShortLivedWorldEvent,
  isSourceAllowed,
  needAt,
  parseEntityRef,
  parseWorldEvent,
  residentId,
  type CommandSource,
  type WorldCell,
  type WorldCommand,
  type WorldCommandType,
  type WorldEventType,
  type WorldSnapshot,
} from './world';
import {
  CreateAgentRequestSchema,
  DispatchPreviewRequestSchema,
  WorldClockFrameSchema,
  WorldCommandRequestSchema,
  WorldEventsFrameSchema,
  WorldEventsQuerySchema,
  parseWorldStreamId,
  worldApiPaths,
  worldStreamId,
} from './world-protocol';

const AGENT = 'agt_11111111-2222-4333-8444-555555555555';
const DISPATCH = 'dsp_11111111-2222-4333-8444-666666666666';
const RUN = '00000000-0000-4000-8000-000000000001';
const cause = { runId: RUN, seqFrom: 1, seqTo: 12 };

const commands: Record<WorldCommandType, WorldCommand> = {
  'clock.set': { type: 'clock.set', speed: 4 },
  'building.set_open': { type: 'building.set_open', buildingId: 'bld_corner_cafe', open: false },
  'agent.house': { type: 'agent.house', agentId: AGENT, lotId: 'lot_agent_1', displayName: 'Engineering House', hue: '#5aa9f5' },
  'agent.connection': { type: 'agent.connection', agentId: AGENT, health: 'live', attention: 'none' },
  'agent.session': { type: 'agent.session', agentId: AGENT, runId: RUN, phase: 'ended', outcome: 'stopped' },
  'agent.activity': {
    type: 'agent.activity',
    agentId: AGENT,
    runId: RUN,
    counts: { read: 3, edit: 1 },
    execState: 'working',
    helpers: 1,
    openIncidents: 0,
  },
  'agent.dispatch': { type: 'agent.dispatch', agentId: AGENT, dispatchId: DISPATCH, phase: 'running' },
};

const identity = (i: number) => ({
  id: residentId(i),
  name: `Resident ${i}`,
  role: 'engineer',
  homeId: 'bld_hearth_n1',
  workId: i % 2 ? null : 'bld_northwind_studio',
  traits: [40, 60, 20] as [number, number, number],
  outfit: { style: 'hoodie' as const, top: '#5b7fa6', bottom: '#3d4451', skin: '#c99a76', hair: '#2b2118' },
});

const track = (v0: number) => ({ v0, rate: 100, t0: 480 });

/** One valid event of every type, keyed by type. */
const events: Record<WorldEventType, Record<string, unknown>> = {
  'world.created': {
    seq: 1,
    tick: 480,
    type: 'world.created',
    prov: 'system',
    p: {
      worldId: 'w1',
      townId: 'runloop-commons',
      contentHash: '0123456789abcdef',
      seed: 42,
      simVersion: 1,
      startTick: 480,
      roster: [identity(0), identity(1)],
    },
  },
  'world.resumed_after_offline': { seq: 2, tick: 480, type: 'world.resumed_after_offline', prov: 'system', p: { offlineWallMs: 3_600_000 } },
  'world.sim_upgraded': { seq: 3, tick: 480, type: 'world.sim_upgraded', prov: 'system', p: { fromVersion: 1, toVersion: 2 } },
  'agent.connection_changed': {
    seq: 4,
    tick: 480,
    type: 'agent.connection_changed',
    prov: 'system',
    cmdId: 'conn:1',
    actor: AGENT,
    p: { agentId: AGENT, health: 'awaiting_first_event', attention: 'none' },
  },
  'world.clock_changed': { seq: 5, tick: 480, type: 'world.clock_changed', prov: 'user', cmdId: 'c1', p: { speed: 0, prevSpeed: 4 } },
  'building.open_changed': {
    seq: 6,
    tick: 481,
    type: 'building.open_changed',
    prov: 'user',
    cmdId: 'c2',
    actor: 'bld_corner_cafe',
    p: { buildingId: 'bld_corner_cafe', open: false },
  },
  'agent.housed': {
    seq: 7,
    tick: 481,
    type: 'agent.housed',
    prov: 'user',
    cmdId: `house:${AGENT}`,
    actor: AGENT,
    p: { agentId: AGENT, lotId: 'lot_agent_1', buildingId: 'bld_agent_hq_1', displayName: 'Engineering House', hue: '#5aa9f5' },
  },
  'agent.dispatch_changed': {
    seq: 8,
    tick: 481,
    type: 'agent.dispatch_changed',
    prov: 'system',
    cmdId: 'dsp:1',
    actor: AGENT,
    p: { agentId: AGENT, dispatchId: DISPATCH, phase: 'finished', outcome: 'completed' },
  },
  'agent.session_changed': {
    seq: 9,
    tick: 482,
    type: 'agent.session_changed',
    prov: 'external-agent',
    obs: 'observed',
    cmdId: 'ses:1',
    actor: AGENT,
    cause,
    p: { agentId: AGENT, runId: RUN, phase: 'started' },
  },
  'agent.activity_observed': {
    seq: 10,
    tick: 482,
    type: 'agent.activity_observed',
    prov: 'inferred',
    cmdId: `act:${RUN}:12`,
    actor: AGENT,
    cause,
    p: { agentId: AGENT, runId: RUN, counts: { read: 3 }, execState: 'idle', helpers: 0, openIncidents: 1 },
  },
  'resident.decided': {
    seq: 11,
    tick: 483,
    type: 'resident.decided',
    prov: 'simulation',
    actor: 'res_0001',
    p: {
      r: 0,
      a: 'eat',
      place: { kind: 'building', buildingId: 'bld_corner_cafe' },
      slotId: 'table_1#2@0',
      reason: 'need',
      block: 'lunch',
      needs: [72_000, 30_000, 41_000],
      rates: [110, 80, 40],
      until: 540,
      top: [
        ['eat', 'bld_corner_cafe', 412, 310, 120, 18],
        ['eat', 'bld_hearth_n1', 380, 310, 80, 10],
        ['work', 'bld_northwind_studio', 200, 0, 180, 6],
      ],
    },
  },
  'resident.departed': {
    seq: 12,
    tick: 483,
    type: 'resident.departed',
    prov: 'simulation',
    actor: 'res_0001',
    p: { r: 0, route: { from: [9, 14], rle: 'S1E4' }, startTick: 483, dest: { kind: 'building', buildingId: 'bld_corner_cafe' } },
  },
  'resident.arrived': {
    seq: 13,
    tick: 485,
    type: 'resident.arrived',
    prov: 'simulation',
    actor: 'res_0001',
    p: {
      r: 0,
      place: { kind: 'building', buildingId: 'bld_corner_cafe' },
      slotId: 'table_1#2@0',
      needs: [72_100, 30_200, 41_100],
      rates: [-2600, 40, -60],
    },
  },
  'interaction.happened': {
    seq: 14,
    tick: 490,
    type: 'interaction.happened',
    prov: 'simulation',
    actor: 'res_0001',
    p: { a: 0, b: 1, placeId: 'spot_fountain_rim', dAffinity: 3 },
  },
  'command.rejected': { seq: 15, tick: 490, type: 'command.rejected', prov: 'external-agent', obs: 'observed', cmdId: 'x1', p: { cmdId: 'x1', code: 'not_housed' } },
};

const withEvent = (type: WorldEventType, patch: Record<string, unknown>) => ({ ...events[type], ...patch });
const withPayload = (type: WorldEventType, patch: Record<string, unknown>) => ({
  ...events[type],
  p: { ...(events[type].p as Record<string, unknown>), ...patch },
});

describe('world commands', () => {
  it('has one example, one ALLOWED_SOURCES entry and one effect per command type', () => {
    expect(Object.keys(commands).sort()).toEqual([...WORLD_COMMAND_TYPES].sort());
    expect(Object.keys(ALLOWED_SOURCES).sort()).toEqual([...WORLD_COMMAND_TYPES].sort());
    expect(Object.keys(COMMAND_EFFECTS).sort()).toEqual([...WORLD_COMMAND_TYPES].sort());
    for (const effect of Object.values(COMMAND_EFFECTS)) expect(WORLD_EVENT_TYPES).toContain(effect);
  });

  it.each(WORLD_COMMAND_TYPES)('parses a valid %s', (type) => {
    expect(WorldCommandSchema.parse(commands[type])).toEqual(commands[type]);
  });

  it('matches the plan’s source table exactly', () => {
    expect(ALLOWED_SOURCES).toEqual({
      'clock.set': ['user'],
      'building.set_open': ['user'],
      'agent.house': ['user', 'system'],
      'agent.connection': ['system'],
      'agent.session': ['external-agent'],
      'agent.activity': ['external-agent'],
      'agent.dispatch': ['user', 'system'],
    });
    // P3: every forbidden pair, table-driven.
    const sources = CommandSourceSchema.options as readonly CommandSource[];
    for (const type of WORLD_COMMAND_TYPES) {
      for (const source of sources) {
        expect(isSourceAllowed(type, source), `${type} from ${source}`).toBe((ALLOWED_SOURCES[type] as readonly string[]).includes(source));
      }
    }
  });

  it.each([
    ['an unknown type', { type: 'resident.teleport', r: 1 }],
    ['an extra field', { ...commands['clock.set'], source: 'user' }],
    ['a speed outside 0|1|4|16', { type: 'clock.set', speed: 5 }],
    ['an ended session without an outcome', { ...commands['agent.session'], outcome: undefined }],
    ['a started session with an outcome', { ...commands['agent.session'], phase: 'started' }],
    ['a running dispatch with an outcome', { ...commands['agent.dispatch'], outcome: 'completed' }],
    ['a building id without its prefix', { type: 'building.set_open', buildingId: 'corner_cafe', open: true }],
    ['an agent id that is not agt_<uuid>', { ...commands['agent.house'], agentId: 'agt_1' }],
    ['a hue that is not #rrggbb', { ...commands['agent.house'], hue: 'lime' }],
    ['negative counts', { ...commands['agent.activity'], counts: { read: -1 } }],
    ['an unknown tool category', { ...commands['agent.activity'], counts: { teleport: 1 } }],
  ])('rejects %s', (_name, raw) => {
    expect(WorldCommandSchema.safeParse(raw).success).toBe(false);
  });
});

describe('command envelopes', () => {
  const env = (command: WorldCommand, extra: Record<string, unknown> = {}) => ({ id: 'cmd-1', source: 'user', command, ...extra });

  it('lets a forbidden source through, so the sim can log forbidden_source', () => {
    expect(CommandEnvelopeSchema.safeParse(env(commands['agent.connection'], { source: 'user' })).success).toBe(true);
  });

  it('requires a cause on run commands, matching their run', () => {
    const activity = commands['agent.activity'];
    expect(CommandEnvelopeSchema.safeParse(env(activity, { source: 'external-agent' })).success).toBe(false);
    expect(CommandEnvelopeSchema.safeParse(env(activity, { source: 'external-agent', cause })).success).toBe(true);
    const other = { ...cause, runId: '00000000-0000-4000-8000-000000000002' };
    expect(CommandEnvelopeSchema.safeParse(env(activity, { source: 'external-agent', cause: other })).success).toBe(false);
    expect(CommandEnvelopeSchema.safeParse(env(activity, { source: 'external-agent', cause: { ...cause, seqFrom: 13 } })).success).toBe(false);
  });

  it('allows a cause and inferred only on run commands', () => {
    expect(CommandEnvelopeSchema.safeParse(env(commands['clock.set'], { cause })).success).toBe(false);
    expect(CommandEnvelopeSchema.safeParse(env(commands['agent.connection'], { source: 'system', inferred: true })).success).toBe(false);
    expect(CommandEnvelopeSchema.safeParse(env(commands['agent.session'], { source: 'external-agent', cause, inferred: true })).success).toBe(true);
  });

  it('gives effects the envelope source, or inferred (P1)', () => {
    expect(effectProvenance({ source: 'user' })).toBe('user');
    expect(effectProvenance({ source: 'external-agent', inferred: true })).toBe('inferred');
  });

  it('accepts only {id, command} over HTTP (P2)', () => {
    const body = { id: 'c-1', command: commands['clock.set'] };
    expect(WorldCommandRequestSchema.safeParse(body).success).toBe(true);
    expect(WorldCommandRequestSchema.safeParse({ ...body, source: 'system' }).success).toBe(false);
    expect(WorldCommandRequestSchema.safeParse({ ...body, prov: 'simulation' }).success).toBe(false);
    expect(WorldCommandRequestSchema.safeParse({ ...body, id: 'bad id with spaces' }).success).toBe(false);
  });

  it('takes only the user’s own controls over HTTP: agent commands come from the runtime', () => {
    for (const type of WORLD_COMMAND_TYPES) {
      const ok = WorldCommandRequestSchema.safeParse({ id: `c-${type}`, command: commands[type] }).success;
      expect([type, ok]).toEqual([type, type === 'clock.set' || type === 'building.set_open']);
    }
  });

  it('refuses a client id that is one of the runtime’s own (it would pre-empt that command)', () => {
    expect([...RUNTIME_COMMAND_ID_PREFIXES]).toEqual(['sess:', 'act:', 'conn:', 'house:', 'dsp:']);
    for (const id of ['sess:r:end', 'act:r:12', 'conn:a:live:none:1', 'house:agt_x', 'dsp:d:finished']) {
      expect(isRuntimeCommandId(id)).toBe(true);
      expect(WorldCommandRequestSchema.safeParse({ id, command: commands['clock.set'] }).success).toBe(false);
    }
    for (const id of ['ui:k3:1:abc', 'speed:4', 'user-sess:1']) expect(WorldCommandRequestSchema.safeParse({ id, command: commands['clock.set'] }).success).toBe(true);
  });
});

describe('world events', () => {
  it('has one example and one provenance rule per event type', () => {
    expect(Object.keys(events).sort()).toEqual([...WORLD_EVENT_TYPES].sort());
    expect(Object.keys(WORLD_EVENT_PROV).sort()).toEqual([...WORLD_EVENT_TYPES].sort());
  });

  it.each(WORLD_EVENT_TYPES)('parses a valid %s (after a JSON round trip)', (type) => {
    const raw = JSON.parse(JSON.stringify(events[type]));
    const r = parseWorldEvent(raw);
    expect(r.ok ? r.event : r.error).toEqual(raw);
  });

  it('lets the simulation emit only resident and interaction events (P1)', () => {
    const simulated = WORLD_EVENT_TYPES.filter((t) => (WORLD_EVENT_PROV[t] as readonly string[]).includes('simulation'));
    expect(simulated.sort()).toEqual(['interaction.happened', 'resident.arrived', 'resident.decided', 'resident.departed']);
    for (const t of simulated) expect(WORLD_EVENT_PROV[t]).toEqual(['simulation']);
  });

  it.each([
    ['a resident event that is not simulation', withEvent('resident.decided', { prov: 'user' })],
    ['a user event claimed by the simulation', withEvent('building.open_changed', { prov: 'simulation' })],
    ['a session change from the system', withEvent('agent.session_changed', { prov: 'system', obs: undefined })],
    ['external-agent without obs', withEvent('agent.session_changed', { obs: undefined })],
    ['obs on a simulation event', withEvent('resident.arrived', { obs: 'observed' })],
    ['an agent session without a cause', withEvent('agent.session_changed', { cause: undefined })],
    ['a cause on a simulation event', withEvent('resident.departed', { cause })],
    ['a command effect without cmdId', withEvent('world.clock_changed', { cmdId: undefined })],
    ['a cmdId on a simulation event', withEvent('resident.decided', { cmdId: 'c9' })],
    ['a rejection without cmdId', withEvent('command.rejected', { cmdId: undefined })],
    ['a resident event naming the wrong actor', withEvent('resident.decided', { actor: 'res_0002' })],
    ['an agent event without its actor', withEvent('agent.housed', { actor: undefined })],
    ['a world.created off its startTick', withEvent('world.created', { tick: 481 })],
    ['an unknown type', withEvent('world.created', { type: 'world.weather_changed' })],
    ['seq 0', withEvent('world.sim_upgraded', { seq: 0 })],
    ['a fractional tick', withEvent('world.sim_upgraded', { tick: 1.5 })],
    ['an unknown provenance', withEvent('world.sim_upgraded', { prov: 'llm' })],
  ])('rejects %s', (_name, raw) => {
    const r = parseWorldEvent(raw);
    expect(r.ok).toBe(false);
    expect(WorldEventSchema.safeParse(raw).success).toBe(false);
  });

  it.each([
    ['a roster out of id order', { roster: [identity(1), identity(0)] }],
    ['a decision whose top[0] is not the choice', { a: 'work' }],
    ['a decision whose top is not sorted', { top: [['eat', 'bld_corner_cafe', 10, 0, 0, 0], ['work', null, 20, 0, 0, 0]] }],
    ['an empty top', { top: [] }],
    ['needs above 100 points', { needs: [NEED_MAX + 1, 0, 0] }],
    ['a slot id in the wrong form', { slotId: 'table 1' }],
    ['a block id with spaces', { block: 'lunch time' }],
  ])('rejects a payload with %s', (_name, patch) => {
    const type = 'roster' in patch ? 'world.created' : 'resident.decided';
    expect(parseWorldEvent(withPayload(type, patch)).ok).toBe(false);
  });

  it('keeps interactions ordered by resident index', () => {
    expect(parseWorldEvent(withPayload('interaction.happened', { a: 1, b: 0, actor: 'res_0002' })).ok).toBe(false);
  });

  it('marks movement and decisions as ambient, interactions and agent events not', () => {
    expect(isAmbientWorldEvent('resident.departed')).toBe(true);
    expect(isAmbientWorldEvent('interaction.happened')).toBe(false);
    expect(isAmbientWorldEvent('agent.activity_observed')).toBe(false);
  });

  it('retention drops simulation events only: the ambient ones and interactions (folded into affinity)', () => {
    expect([...SHORT_LIVED_WORLD_EVENT_TYPES].sort()).toEqual(['interaction.happened', 'resident.arrived', 'resident.decided', 'resident.departed']);
    for (const type of WORLD_EVENT_TYPES) {
      expect([type, isShortLivedWorldEvent(type)]).toEqual([type, WORLD_EVENT_PROV[type].every((p) => p === 'simulation')]);
    }
  });

  it('names stream ids by world and seq, and reads bare seqs too', () => {
    expect(worldStreamId('runloop-commons-0a1b2c3d', 412)).toBe('runloop-commons-0a1b2c3d:412');
    expect(parseWorldStreamId('runloop-commons-0a1b2c3d:412')).toEqual({ worldId: 'runloop-commons-0a1b2c3d', seq: 412 });
    expect(parseWorldStreamId('412')).toEqual({ worldId: null, seq: 412 });
    for (const bad of ['', 'x:', ':4', 'a b:4', '4.5', 'w:-1']) expect(parseWorldStreamId(bad)).toBeNull();
  });

  it('validates event batches as SSE frames', () => {
    expect(WorldEventsFrameSchema.safeParse({ events: [events['resident.decided'], events['resident.departed']] }).success).toBe(true);
    expect(WorldEventsFrameSchema.safeParse({ events: [] }).success).toBe(false);
    expect(WorldClockFrameSchema.safeParse({ tick: 900, speed: 16, wallMs: 1_760_000_000_000, lagging: false }).success).toBe(true);
  });
});

describe('helpers', () => {
  it('round-trips routes and refuses diagonal steps', () => {
    const path: WorldCell[] = [
      [9, 14],
      [9, 15],
      [10, 15],
      [11, 15],
      [12, 15],
      [12, 14],
    ];
    const route = encodeRoute(path);
    expect(route).toEqual({ from: [9, 14], rle: 'S1E3N1' });
    expect(decodeRoute(route)).toEqual(path);
    expect(encodeRoute([[3, 3]])).toEqual({ from: [3, 3], rle: '' });
    expect(() =>
      encodeRoute([
        [0, 0],
        [1, 1],
      ]),
    ).toThrow(/neighbouring/);
  });

  it('computes needs in closed form, clamped, in integers', () => {
    expect(needAt({ v0: 50_000, rate: 110, t0: 100 }, 160)).toBe(56_600);
    expect(needAt({ v0: 50_000, rate: -2600, t0: 100 }, 200)).toBe(0);
    expect(needAt({ v0: 99_000, rate: 500, t0: 0 }, 10)).toBe(NEED_MAX);
    expect(needAt({ v0: 10_000, rate: 100, t0: 50 }, 40)).toBe(10_000);
  });

  it('formats the clock as Day n · hh:mm', () => {
    expect(clockOf(0)).toEqual({ day: 1, minute: 0 });
    expect(formatClock(480)).toBe('Day 1 · 08:00');
    expect(formatClock(2 * 1440 + 14 * 60 + 20)).toBe('Day 3 · 14:20');
  });

  it('numbers residents from res_0001 and round-trips entity refs', () => {
    expect(residentId(0)).toBe('res_0001');
    expect(residentId(119)).toBe('res_0120');
    expect(parseEntityRef('resident:res_0012')).toEqual({ kind: 'resident', id: 'res_0012' });
    expect(formatEntityRef({ kind: 'agent', id: AGENT })).toBe(`agent:${AGENT}`);
    expect(parseEntityRef('wizard:res_0012')).toBeNull();
    expect(parseEntityRef('res_0012')).toBeNull();
  });

  it('orders actions as the plan’s tie-break ordinal', () => {
    expect(RESIDENT_ACTIONS).toEqual(['sleep', 'rest', 'eat', 'work', 'socialize', 'stroll']);
  });
});

describe('snapshot and API bodies', () => {
  const snapshot: WorldSnapshot = {
    worldId: 'w1',
    simVersion: 1,
    contentHash: '0123456789abcdef',
    seq: 14,
    tick: 490,
    speed: 1,
    prevSpeed: 1,
    residents: [
      {
        ...identity(0),
        idx: 0,
        place: { kind: 'outdoor', spotId: null },
        slotId: 'table_1#2@0',
        action: 'eat',
        motion: { path: decodeRoute({ from: [9, 14], rle: 'S1E4' }), startTick: 483 },
        needs: [track(72_000), track(30_000), track(41_000)],
        until: 540,
        lastDecisionSeq: 11,
      },
    ],
    buildings: [{ id: 'bld_corner_cafe', open: true, occupancy: 3 }],
    agents: [
      {
        agentId: AGENT,
        buildingId: 'bld_agent_hq_1',
        lotId: 'lot_agent_1',
        displayName: 'Engineering House',
        hue: '#5aa9f5',
        health: 'live',
        attention: 'none',
        activeRunId: RUN,
        counts: { read: 3 },
        execState: 'working',
        helpers: 0,
        openIncidents: 0,
        lastCause: cause,
        dispatch: null,
      },
    ],
    affinity: { '0:1': 3 },
  };

  it('parses a snapshot and rejects a bad affinity key or a paused prevSpeed', () => {
    expect(WorldSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(WorldSnapshotSchema.safeParse({ ...snapshot, affinity: { 'a:b': 1 } }).success).toBe(false);
    expect(WorldSnapshotSchema.safeParse({ ...snapshot, prevSpeed: 0 }).success).toBe(false);
  });

  it('never carries a path in an agent presence', () => {
    const agent = { ...snapshot.agents[0]!, workspacePath: '/home/someone/code/repo' };
    const parsed = WorldSnapshotSchema.parse({ ...snapshot, agents: [agent] });
    expect(JSON.stringify(parsed)).not.toContain('/home/someone');
  });

  it('coerces event query strings and caps the page size', () => {
    expect(WorldEventsQuerySchema.parse({ after: '12', limit: '50', prov: 'user' })).toEqual({ after: 12, limit: 50, prov: 'user' });
    expect(WorldEventsQuerySchema.parse({})).toEqual({ after: 0, limit: 200 });
    expect(WorldEventsQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('validates Add to World and dispatch preview bodies strictly', () => {
    expect(CreateAgentRequestSchema.safeParse({ displayName: 'Eng', lotId: 'lot_agent_1', workspace: { path: '/tmp/repo' } }).success).toBe(true);
    expect(CreateAgentRequestSchema.safeParse({ displayName: 'Eng', lotId: 'lot_agent_1', workspace: { fromSessionId: 's-1' } }).success).toBe(true);
    expect(CreateAgentRequestSchema.safeParse({ displayName: 'Eng', lotId: 'lot_agent_1', workspace: { path: '/a', fromSessionId: 's' } }).success).toBe(false);
    expect(DispatchPreviewRequestSchema.safeParse({ task: 'Create hello.txt', preset: 'read_only' }).success).toBe(true);
    expect(DispatchPreviewRequestSchema.safeParse({ task: 'x', preset: 'read_only', maxBudgetUsd: 2 }).success).toBe(false);
    expect(DispatchPreviewRequestSchema.safeParse({ task: 'x', preset: 'yolo' }).success).toBe(false);
    expect(DispatchPreviewRequestSchema.safeParse({ task: 'x', preset: 'read_only', permissionMode: 'bypassPermissions' }).success).toBe(false);
  });

  it('builds encoded paths', () => {
    expect(worldApiPaths.agent(AGENT)).toBe(`/api/agents/${AGENT}`);
    expect(worldApiPaths.dispatchCancel('a/b')).toBe('/api/dispatches/a%2Fb/cancel');
  });
});
