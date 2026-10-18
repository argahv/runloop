import type { AgentPresence, WorldEvent } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { arrivalItems, attentionTitle, classify, foldAttention, nextTickerItem, TICKER_GAP_MS, type AttentionItem } from './attention';
import { ENGINEERING_HOUSE, fixtureEvents } from './test-utils';

const AGENT = ENGINEERING_HOUSE;
const RUN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const cause = { runId: RUN, seqFrom: 1, seqTo: 9 };

const conn = (seq: number, tick: number, health: AgentPresence['health'], attention: AgentPresence['attention'] = 'none'): WorldEvent => ({
  seq,
  tick,
  type: 'agent.connection_changed',
  prov: 'system',
  cmdId: `conn:${seq}`,
  actor: AGENT,
  p: { agentId: AGENT, health, attention },
});
const talk = (seq: number, tick: number, placeId = 'spot_plaza_steps'): WorldEvent => ({
  seq,
  tick,
  type: 'interaction.happened',
  prov: 'simulation',
  actor: 'res_0001',
  p: { a: 0, b: 1, placeId, dAffinity: 2 },
});
const ended = (seq: number, outcome: 'failed' | 'stopped'): WorldEvent => ({
  seq,
  tick: 600,
  type: 'agent.session_changed',
  prov: 'external-agent',
  obs: 'observed',
  cmdId: `ses:${seq}`,
  actor: AGENT,
  cause,
  p: { agentId: AGENT, runId: RUN, phase: 'ended', outcome },
});
const presence = (over: Partial<AgentPresence> = {}): AgentPresence => ({
  agentId: AGENT,
  buildingId: 'bld_agent_hq_1',
  lotId: 'lot_agent_1',
  displayName: 'Engineering House',
  hue: '#5aa9f5',
  health: 'live',
  attention: 'none',
  activeRunId: null,
  counts: {},
  execState: 'idle',
  helpers: 0,
  openIncidents: 0,
  lastCause: null,
  dispatch: null,
  ...over,
});

const fold = (events: WorldEvent[], prev?: AgentPresence) => events.reduce<AttentionItem[]>((items, e) => foldAttention(items, e, prev), []);
const name = () => 'Engineering House';

describe('attention severity', () => {
  it('critical: a failed session, a permission wait, a connection lost mid-task', () => {
    expect(classify(ended(1, 'failed')).severity).toBe('critical');
    expect(classify(conn(1, 1, 'live', 'permission_requested')).severity).toBe('critical');
    expect(classify(conn(1, 1, 'offline'), presence({ activeRunId: RUN })).kind).toBe('lost_mid_task');
    expect(classify(conn(1, 1, 'offline'), presence({ activeRunId: RUN })).severity).toBe('critical');
  });

  it('attention: offline without a session, an incident, a rejected command, an unclaimed session', () => {
    expect(classify(conn(1, 1, 'offline'), presence()).severity).toBe('attention');
    expect(classify(conn(1, 1, 'live', 'incident'), presence()).severity).toBe('attention');
    expect(classify({ seq: 1, tick: 1, type: 'command.rejected', prov: 'user', cmdId: 'c1', p: { cmdId: 'c1', code: 'invalid' } }).severity).toBe('attention');
    expect(arrivalItems([{ sessionId: 's1', projectLabel: 'demo' }])[0]).toMatchObject({ severity: 'attention', prov: 'external-agent', events: null });
  });

  it('notable: sessions ending, buildings, conversations; ambient: movement and needs', () => {
    expect(classify(ended(1, 'stopped')).severity).toBe('notable');
    expect(classify(talk(1, 1)).severity).toBe('notable');
    const moves = fixtureEvents().filter((e) => e.type.startsWith('resident.'));
    expect(moves.length).toBeGreaterThan(100);
    expect(moves.every((e) => classify(e).severity === 'ambient')).toBe(true);
    expect(fold(moves)).toEqual([]);
  });
});

describe('attention grouping and order', () => {
  it('merges the same group within 10 sim-minutes and splits after', () => {
    const items = fold([talk(1, 100), talk(2, 105), talk(3, 115), talk(4, 130)]);
    expect(items.map((i) => i.events)).toEqual([
      { first: 4, last: 4, count: 1 },
      { first: 1, last: 3, count: 3 },
    ]);
    expect(attentionTitle(items[1]!, () => 'Plaza steps')).toBe('3 conversations at Plaza steps');
  });

  it('a merged item takes the provenance of its latest event (a user-approved dispatch finished by the system)', () => {
    const dsp = (seq: number, prov: 'user' | 'system', phase: 'approved' | 'running' | 'finished'): WorldEvent => ({
      seq,
      tick: 700 + seq,
      type: 'agent.dispatch_changed',
      prov,
      cmdId: `dsp:${seq}`,
      actor: AGENT,
      p: { agentId: AGENT, dispatchId: 'dsp_1', phase, ...(phase === 'finished' ? { outcome: 'completed' as const } : {}) },
    });
    const [item] = fold([dsp(1, 'user', 'approved'), dsp(2, 'system', 'running'), dsp(3, 'system', 'finished')]);
    expect(item).toMatchObject({ kind: 'dispatch', prov: 'system', detail: 'completed', events: { first: 1, last: 3, count: 3 } });
  });

  it('orders by severity, then real agents before the simulation, then recency', () => {
    const items = fold([talk(1, 100), ended(2, 'stopped'), conn(3, 600, 'live', 'permission_requested')]);
    expect(items.map((i) => i.kind)).toEqual(['permission', 'session_ended', 'conversations']);
  });

  it('marks a condition resolved when a later event clears it', () => {
    const items = fold([conn(1, 10, 'live', 'permission_requested'), conn(2, 11, 'live', 'none')]);
    expect(items.find((i) => i.kind === 'permission')!.resolved).toBe(true);
    expect(nextTickerItem(items, 0, -Infinity)).toBeNull();
  });
});

describe('ticker', () => {
  const items = fold([talk(1, 100), ended(2, 'stopped')]);

  it('shows at most one item every 4 s and never the same count twice', () => {
    const first = nextTickerItem(items, 10_000, 0)!;
    expect(first.kind).toBe('session_ended');
    expect(nextTickerItem(items, 10_000 + TICKER_GAP_MS - 1, 10_000, new Map([[first.key, 1]]))).toBeNull();
    const second = nextTickerItem(items, 10_000 + TICKER_GAP_MS, 10_000, new Map([[first.key, 1]]))!;
    expect(second.kind).toBe('conversations');
    expect(nextTickerItem(items, 30_000, 20_000, new Map(items.map((i) => [i.key, i.events!.count])))).toBeNull();
  });

  it('lets a critical item through without waiting', () => {
    const withCritical = foldAttention(items, conn(3, 600, 'live', 'permission_requested'));
    expect(nextTickerItem(withCritical, 10_001, 10_000)!.kind).toBe('permission');
  });

  it('skips notable history (folded when the page opened) but still shows conditions that need the viewer', () => {
    const history = fold([talk(1, 100), conn(2, 101, 'live', 'permission_requested')]).map((i) => ({ ...i, history: true }));
    expect(nextTickerItem(history, 1e9, 0)!.kind).toBe('permission');
    const shown = new Map([[history.find((i) => i.kind === 'permission')!.key, 1]]);
    expect(nextTickerItem(history, 1e9, 0, shown)).toBeNull();
    // News merged into a history group makes it news again.
    const merged = foldAttention(history, talk(3, 105));
    expect(nextTickerItem(merged, 1e9, 0, shown)!.kind).toBe('conversations');
  });

  it('never shows ambient items', () => {
    const ambient = fold(fixtureEvents().filter((e) => e.type === 'resident.decided'));
    expect(nextTickerItem(ambient, 1e9, 0)).toBeNull();
  });

  it('titles say only what the events say', () => {
    const [failed] = fold([ended(1, 'failed')]);
    expect(attentionTitle(failed!, name)).toBe('Engineering House: a session failed');
    const [rejected] = fold([{ seq: 1, tick: 1, type: 'command.rejected', prov: 'user', cmdId: 'c1', p: { cmdId: 'c1', code: 'lot_unavailable' } }]);
    expect(attentionTitle(rejected!, name)).toBe('Your command was rejected: that lot is taken or not an agent lot');
  });
});
