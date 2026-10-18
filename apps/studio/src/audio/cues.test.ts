import { WORLD_EVENT_PROV, WORLD_EVENT_TYPES, type WorldEvent, type WorldProvenance } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { fixtureEvents } from '../world/test-utils';
import { CUE_LIMITS, CueLimiter, HOUSED_AGENT, classifyCue, cueAgentId, nextAgentState } from './cues';
import type { AgentAudioState, EventCue } from './types';

const AGENT = 'agt_00000000-0000-4000-8000-000000000001';
const OTHER = 'agt_00000000-0000-4000-8000-000000000002';
const RUN = '00000000-0000-4000-8000-0000000000aa';

let seq = 100;
function ev(type: string, p: Record<string, unknown>, prov: WorldProvenance = 'system'): WorldEvent {
  return { seq: ++seq, tick: 1000 + seq, type, prov, p, actor: AGENT } as unknown as WorldEvent;
}
const conn = (health: string, attention = 'none') => ev('agent.connection_changed', { agentId: AGENT, health, attention });
const state = (p: Partial<AgentAudioState> = {}): AgentAudioState => ({ ...HOUSED_AGENT, ...p });

/** A payload per event type that would cue if anything could (agent types) or a plain one. */
function samplePayload(type: string): Record<string, unknown> {
  switch (type) {
    case 'agent.connection_changed':
      return { agentId: AGENT, health: 'live', attention: 'permission_requested' };
    case 'agent.activity_observed':
      return { agentId: AGENT, runId: RUN, counts: {}, execState: 'working', helpers: 0, openIncidents: 3 };
    case 'agent.dispatch_changed':
      return { agentId: AGENT, dispatchId: 'dsp_1', phase: 'finished', outcome: 'failed' };
    case 'agent.session_changed':
      return { agentId: AGENT, runId: RUN, phase: 'ended', outcome: 'succeeded' };
    case 'agent.housed':
      return { agentId: AGENT, lotId: 'lot_1', buildingId: 'bld_1', displayName: 'Engineering House', hue: '#5aa9f5' };
    default:
      return { r: 1, a: 1, b: 2, buildingId: 'bld_corner_cafe', open: true, speed: 4, prevSpeed: 1 };
  }
}

describe('classifyCue: truth rule (S2)', () => {
  it('never cues a simulation event, for every event type', () => {
    for (const type of WORLD_EVENT_TYPES) {
      expect(classifyCue(ev(type, samplePayload(type), 'simulation'), state()), type).toBeNull();
    }
  });

  it('never cues a non-agent event, whatever its provenance', () => {
    const provs: WorldProvenance[] = ['simulation', 'user', 'external-agent', 'system', 'inferred'];
    for (const type of WORLD_EVENT_TYPES.filter((t) => !t.startsWith('agent.'))) {
      for (const prov of provs) expect(classifyCue(ev(type, samplePayload(type), prov), state()), `${type}/${prov}`).toBeNull();
    }
  });

  it('cues the agent types only with the provenances the schema allows them', () => {
    for (const type of WORLD_EVENT_TYPES.filter((t) => t.startsWith('agent.') && t !== 'agent.housed')) {
      for (const prov of WORLD_EVENT_PROV[type]) expect(classifyCue(ev(type, samplePayload(type), prov), state()), `${type}/${prov}`).not.toBeNull();
    }
    expect(classifyCue(ev('agent.housed', samplePayload('agent.housed'), 'user'), undefined)).toBeNull();
  });

  it('a recorded engine day (residents, interactions, the clock) makes no cue at all', () => {
    const events = fixtureEvents();
    expect(events.length).toBeGreaterThan(100);
    const states = new Map<string, AgentAudioState>();
    let simulated = 0;
    for (const e of events) {
      const id = cueAgentId(e);
      const cue = classifyCue(e, id ? states.get(id) : undefined);
      if (e.prov === 'simulation') {
        simulated++;
        expect(cue).toBeNull();
      }
      if (!e.type.startsWith('agent.')) expect(cue).toBeNull();
      if (id) {
        const next = nextAgentState(states.get(id), e);
        if (next) states.set(id, next);
      }
    }
    expect(simulated).toBeGreaterThan(100);
  });
});

describe('classifyCue: the four cues', () => {
  it('agentLive when health becomes live (from any other health)', () => {
    expect(classifyCue(conn('live'), state({ health: 'awaiting_first_event' }))).toBe('agentLive');
    expect(classifyCue(conn('live'), state({ health: 'idle' }))).toBe('agentLive');
    expect(classifyCue(conn('live'), undefined)).toBe('agentLive');
    expect(classifyCue(conn('live'), state({ health: 'live' }))).toBeNull();
    expect(classifyCue(conn('idle'), state({ health: 'live' }))).toBeNull();
    expect(classifyCue(conn('offline'), state({ health: 'live' }))).toBeNull();
  });

  it('needsApproval when attention becomes a permission or dispatch wait; it outranks agentLive', () => {
    expect(classifyCue(conn('live', 'permission_requested'), state({ health: 'live' }))).toBe('needsApproval');
    expect(classifyCue(conn('idle', 'dispatch_awaiting_approval'), state({ health: 'idle' }))).toBe('needsApproval');
    expect(classifyCue(conn('live', 'permission_requested'), state({ health: 'idle' }))).toBe('needsApproval');
    // Already waiting: no new cue.
    expect(classifyCue(conn('live', 'permission_requested'), state({ health: 'live', attention: 'permission_requested' }))).toBeNull();
    // Resolved: no cue.
    expect(classifyCue(conn('live', 'none'), state({ health: 'live', attention: 'permission_requested' }))).toBeNull();
  });

  it('incident when attention becomes incident or open incidents rise', () => {
    expect(classifyCue(conn('live', 'incident'), state({ health: 'live' }))).toBe('incident');
    const act = (n: number, prov: WorldProvenance = 'external-agent') =>
      ev('agent.activity_observed', { agentId: AGENT, runId: RUN, counts: {}, execState: 'working', helpers: 0, openIncidents: n }, prov);
    expect(classifyCue(act(1), state({ openIncidents: 0 }))).toBe('incident');
    expect(classifyCue(act(2, 'inferred'), state({ openIncidents: 1 }))).toBe('incident');
    expect(classifyCue(act(1), state({ openIncidents: 1 }))).toBeNull();
    expect(classifyCue(act(0), state({ openIncidents: 2 }))).toBeNull();
  });

  it('dispatch outcomes: completed → taskDone; failures → incident; cancelled and unfinished phases → none', () => {
    const d = (phase: string, outcome?: string) => ev('agent.dispatch_changed', { agentId: AGENT, dispatchId: 'dsp_1', phase, ...(outcome ? { outcome } : {}) }, 'user');
    const table: [string, string | undefined, EventCue | null][] = [
      ['finished', 'completed', 'taskDone'],
      ['finished', 'failed', 'incident'],
      ['finished', 'timed_out', 'incident'],
      ['finished', 'budget_exceeded', 'incident'],
      ['finished', 'lost', 'incident'],
      ['finished', 'cancelled', null],
      ['approved', undefined, null],
      ['running', undefined, null],
    ];
    for (const [phase, outcome, cue] of table) expect(classifyCue(d(phase, outcome), state()), `${phase}/${outcome}`).toBe(cue);
  });

  it('session ends: succeeded → taskDone; failed → incident; stopped, interrupted and starts → none', () => {
    const s = (phase: string, outcome?: string) => ev('agent.session_changed', { agentId: AGENT, runId: RUN, phase, ...(outcome ? { outcome } : {}) }, 'external-agent');
    expect(classifyCue(s('ended', 'succeeded'), state())).toBe('taskDone');
    expect(classifyCue(s('ended', 'failed'), state())).toBe('incident');
    expect(classifyCue(s('ended', 'stopped'), state())).toBeNull();
    expect(classifyCue(s('ended', 'interrupted'), state())).toBeNull();
    expect(classifyCue(s('started'), state())).toBeNull();
  });

  it('folds agent state the way applyEvent does', () => {
    let st = nextAgentState(undefined, ev('agent.housed', samplePayload('agent.housed'), 'user'));
    expect(st).toEqual(HOUSED_AGENT);
    st = nextAgentState(st, conn('live', 'incident'));
    expect(st).toMatchObject({ health: 'live', attention: 'incident' });
    st = nextAgentState(st, ev('agent.activity_observed', { agentId: AGENT, runId: RUN, counts: {}, execState: 'working', helpers: 0, openIncidents: 2 }, 'external-agent'));
    expect(st?.openIncidents).toBe(2);
    st = nextAgentState(st, ev('agent.session_changed', { agentId: AGENT, runId: RUN, phase: 'started' }, 'external-agent'));
    expect(st?.openIncidents).toBe(0);
    expect(nextAgentState(st, ev('resident.arrived', {}, 'simulation'))).toBe(st);
  });
});

describe('CueLimiter (S3)', () => {
  const setup = () => {
    let t = 0;
    const clock = { now: () => t, at: (ms: number) => (t = ms), add: (ms: number) => (t += ms) };
    return { clock, lim: new CueLimiter(clock.now) };
  };

  it('spaces cues 1.2 s apart through a short queue', () => {
    const { clock, lim } = setup();
    expect(lim.offer('agentLive', AGENT)).toBe('play');
    expect(lim.offer('taskDone', OTHER)).toBe('queued');
    clock.at(1000);
    expect(lim.due()).toEqual([]);
    clock.at(1200);
    expect(lim.due().map((c) => c.cue)).toEqual(['taskDone']);
    expect(lim.due()).toEqual([]);
    clock.at(2500);
    expect(lim.offer('incident', OTHER)).toBe('play');
  });

  it('keeps at most 2 waiting, strongest first; a weaker cue cannot push out a stronger one', () => {
    const { clock, lim } = setup();
    expect(lim.offer('agentLive', AGENT)).toBe('play');
    expect(lim.offer('taskDone', AGENT)).toBe('queued');
    expect(lim.offer('agentLive', OTHER)).toBe('queued');
    expect(lim.offer('agentLive', 'agt_x')).toBe('queue_full');
    expect(lim.offer('needsApproval', OTHER)).toBe('queued'); // pushes out the waiting agentLive
    expect(lim.waiting).toBe(2);
    clock.at(1200);
    expect(lim.due()[0]?.cue).toBe('needsApproval');
    clock.at(2400);
    expect(lim.due()[0]?.cue).toBe('taskDone');
    // The pushed-out cue gave its cooldown back.
    clock.at(3600);
    expect(lim.offer('agentLive', OTHER)).toBe('play');
  });

  it('drops a waiting cue whose moment has passed', () => {
    let t = 0;
    const lim = new CueLimiter(() => t, { ...CUE_LIMITS, spacingMs: 10_000 });
    lim.offer('agentLive', AGENT);
    expect(lim.offer('taskDone', AGENT)).toBe('queued');
    t = 4500;
    expect(lim.due()).toEqual([]);
    expect(lim.waiting).toBe(0);
  });

  it('caps cues at 6 per minute', () => {
    const { clock, lim } = setup();
    for (let i = 0; i < 6; i++) {
      clock.at(i * 1300);
      expect(lim.offer('taskDone', `agt_${i}`)).toBe('play');
    }
    clock.at(6 * 1300);
    expect(lim.offer('needsApproval', 'agt_9')).toBe('rate');
    clock.at(60_001);
    expect(lim.offer('needsApproval', 'agt_9')).toBe('play');
  });

  it('holds each agent+cue for its cooldown (agentLive 60 s, needsApproval 30 s, taskDone 20 s, incident 15 s)', () => {
    const cases: [EventCue, number][] = [
      ['agentLive', 60_000],
      ['needsApproval', 30_000],
      ['taskDone', 20_000],
      ['incident', 15_000],
    ];
    for (const [cue, ms] of cases) {
      const { clock, lim } = setup();
      expect(lim.offer(cue, AGENT)).toBe('play');
      clock.at(ms - 1);
      expect(lim.offer(cue, AGENT), cue).toBe('cooldown');
      expect(lim.offer(cue, OTHER), cue).toBe('play');
      clock.at(ms + 5000);
      expect(lim.offer(cue, AGENT), cue).toBe('play');
    }
  });

  it('suppresses cues after a resync, and drops what was waiting', () => {
    const { clock, lim } = setup();
    lim.offer('agentLive', AGENT);
    lim.offer('taskDone', AGENT);
    lim.suppressFor(3000);
    expect(lim.waiting).toBe(0);
    clock.at(2999);
    expect(lim.offer('incident', AGENT)).toBe('suppressed');
    expect(lim.due()).toEqual([]);
    clock.at(3000);
    expect(lim.offer('incident', AGENT)).toBe('play');
    // The dropped taskDone did not keep its cooldown.
    clock.at(4300);
    expect(lim.offer('taskDone', AGENT)).toBe('play');
  });

  it('plays nothing while hidden and keeps nothing for later (no burst on return)', () => {
    const { clock, lim } = setup();
    lim.offer('agentLive', AGENT);
    lim.offer('taskDone', AGENT);
    lim.setHidden(true);
    expect(lim.waiting).toBe(0);
    expect(lim.offer('needsApproval', AGENT)).toBe('hidden');
    clock.at(30_000);
    lim.setHidden(false);
    expect(lim.due()).toEqual([]);
    expect(lim.offer('needsApproval', AGENT)).toBe('play');
  });
});
