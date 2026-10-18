import { SIMULATED_DECISION_LABEL, WORLD_EVENT_PROV, type AgentSummary, type Explanation } from '@runloop-world/events';
import { explain } from '@runloop-world/sim';
import { describe, expect, it } from 'vitest';
import {
  agentView,
  buildingView,
  capabilityViews,
  entityChip,
  eventText,
  explanationView,
  healthView,
  lastEventText,
  provenanceChip,
  residentView,
} from './selectors';
import { commonsTown, ENGINEERING_HOUSE, fixtureEvents, fixtureSnapshot } from './test-utils';

const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId: ENGINEERING_HOUSE,
  kind: 'claude-code',
  displayName: 'Engineering House',
  hue: '#5aa9f5',
  orgId: 'org_home',
  lotId: 'lot_agent_1',
  buildingId: 'bld_agent_hq_1',
  housed: true,
  health: 'live',
  attention: 'none',
  lastEventAt: '2026-10-18T10:00:00.000Z',
  capabilities: {
    observe: { state: 'available', reason: null },
    inspect: { state: 'available', reason: null },
    submit_task: { state: 'needs_setup', reason: 'Task dispatch arrives in S4' },
    cancel: { state: 'unsupported', reason: 'No dispatch is running' },
    message: { state: 'unsupported', reason: 'Claude Code has no message adapter yet' },
    control: { state: 'unsupported', reason: 'Claude Code has no control adapter yet' },
  },
  workspace: { workspaceId: 'wsp_x', label: 'runloop', pathHint: '…/code/runloop' },
  sessions: [],
  ...over,
});

describe('panels (P10 on the UI side)', () => {
  it('"Real" appears only on external-agent entities and events', () => {
    expect(entityChip('agent').real).toBe(true);
    expect(entityChip('agent').label).toBe('Real · Claude Code · observed');
    for (const kind of ['resident', 'building', 'district', 'lot', 'spot'] as const) {
      expect(entityChip(kind).real).toBe(false);
      expect(entityChip(kind).label).not.toMatch(/real/i);
    }
    for (const prov of ['simulation', 'user', 'system', 'inferred'] as const) {
      expect(provenanceChip(prov).real).toBe(false);
      expect(provenanceChip(prov).label).not.toMatch(/real/i);
    }
    expect(provenanceChip('external-agent', 'observed').real).toBe(true);
    // Every fixture event: Real exactly when its provenance is external-agent.
    for (const e of fixtureEvents()) expect(provenanceChip(e.prov, e.obs).real).toBe(e.prov === 'external-agent');
    expect(Object.keys(WORLD_EVENT_PROV)).toHaveLength(15);
  });

  it('an agent panel has no Why', () => {
    const snap = fixtureSnapshot();
    const view = agentView(snap.agents[0]!, summary(), Date.parse('2026-10-18T10:00:12.000Z'))!;
    expect(view).not.toHaveProperty('why');
    expect(view).not.toHaveProperty('explanation');
    expect(view.chip.real).toBe(true);
    expect(view.lastEvent).toBe('last event 12 s ago');
    expect(view.counts[0]).toEqual({ category: 'read', n: 4 });
    expect(view.workspace).toEqual({ label: 'runloop', pathHint: '…/code/runloop' });
  });

  it('every capability shows, and each unavailable one says why', () => {
    const caps = capabilityViews(summary().capabilities);
    expect(caps.map((c) => c.id)).toEqual(['observe', 'inspect', 'submit_task', 'cancel', 'message', 'control']);
    for (const c of caps) expect(c.available || (c.reason !== null && c.reason.length > 0)).toBe(true);
    expect(capabilityViews(null).every((c) => !c.available && c.reason === 'Not reported by this runtime')).toBe(true);
  });

  it('health is text and icon; an agent without events is never shown as live', () => {
    expect(healthView('awaiting_first_event')).toMatchObject({ text: 'Waiting for first event', icon: 'hourglass' });
    expect(healthView('offline').text).toBe('Offline');
    expect(lastEventText(null, 0)).toBe('no event yet');
    const docs = fixtureSnapshot().agents[1]!;
    expect(agentView(docs, null, 0)!.health.text).toBe('Waiting for first event');
    expect(agentView(docs, null, 0)!.apiMissing).toBe(true);
  });

  it('Real only with an agent registered in this runtime: a phantom presence is an unregistered building (P10)', () => {
    const docs = fixtureSnapshot().agents[1]!;
    const phantom = agentView(docs, null, 0, 'ok')!;
    expect(phantom.chip.real).toBe(false);
    expect(phantom.chip.label).toBe('Unregistered building');
    expect(phantom.unregistered).toBe(true);
    // The agents API has not answered: not confirmed, never Real.
    const unconfirmed = agentView(docs, null, 0, 'offline')!;
    expect(unconfirmed.chip.real).toBe(false);
    expect(unconfirmed.unregistered).toBe(false);
    expect(unconfirmed.apiMissing).toBe(true);
  });

  it('a dispatched task without hook events yet is said, apart from the health', () => {
    const agent = { ...fixtureSnapshot().agents[0]!, health: 'idle' as const, dispatch: { dispatchId: 'dsp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', phase: 'running' as const } };
    expect(agentView(agent, summary(), 0, 'ok')!.taskNote).toBe('Task running · no events yet');
    expect(agentView({ ...agent, health: 'live' }, summary(), 0, 'ok')!.taskNote).toBeNull();
    expect(agentView({ ...agent, dispatch: null }, summary(), 0, 'ok')!.taskNote).toBeNull();
  });

  it('no Why factor is unsourced: the engine explanation keeps all, a broken one loses them', () => {
    const decided = fixtureEvents().filter((e) => e.type === 'resident.decided');
    for (const d of decided.slice(0, 40)) {
      if (d.type !== 'resident.decided') continue;
      const x = explain(d, commonsTown());
      const v = explanationView(x);
      expect(v.dropped).toBe(0);
      for (const f of [...v.chosen.factors, ...v.alternatives.flatMap((a) => a.factors)]) expect(f.source.seq).toBe(d.seq);
      // The chosen action is the argmax of top (P10).
      expect(v.chosen.total).toBe(Math.max(...d.p.top.map((t) => t[2])));
    }
    const broken = {
      subject: { kind: 'resident', id: 'res_0001' },
      atSeq: 5,
      label: SIMULATED_DECISION_LABEL,
      chosen: { action: 'eat', placeId: null, label: 'Eat', total: 3, factors: [{ text: 'Hunger', source: { seq: 5, field: 'needs[0]' } }, { text: 'vibes' }] },
      alternatives: [],
    } as unknown as Explanation;
    const v = explanationView(broken);
    expect(v.dropped).toBe(1);
    expect(v.chosen.factors.map((f) => f.text)).toEqual(['Hunger']);
  });

  it('a resident view is labelled Simulated and read from the snapshot and the town', () => {
    const town = commonsTown();
    const snap = fixtureSnapshot();
    const r = snap.residents.find((x) => x.motion)!;
    const v = residentView(snap, town, 42, r, snap.tick);
    expect(v.chip.label).toBe('Simulated');
    expect(v.chip.real).toBe(false);
    expect(v.walking).toBe(true);
    expect(v.needs.map((n) => n.label)).toEqual(['Hunger', 'Tiredness', 'Loneliness']);
    for (const n of v.needs) expect(n.points).toBeGreaterThanOrEqual(0);
    expect(v.schedule.blocks.filter((b) => b.current)).toHaveLength(1);
  });

  it('a building view counts occupancy against its slots', () => {
    const town = commonsTown();
    const snap = fixtureSnapshot();
    const v = buildingView(snap, town, 'bld_corner_cafe', snap.tick)!;
    expect(v.capacity).toBe(town.buildingById.get('bld_corner_cafe')!.slots.length);
    expect(v.occupancy).toBe(snap.buildings.find((b) => b.id === 'bld_corner_cafe')!.occupancy);
    expect(v.purpose).toBe('Café');
    expect(buildingView(snap, town, 'bld_nope', 0)).toBeNull();
  });

  it('describes every fixture event from its payload', () => {
    const snap = fixtureSnapshot();
    const name = (_k: string, id: string) => id;
    const residentName = (i: number) => snap.residents[i]?.name ?? `#${i}`;
    for (const e of fixtureEvents()) expect(eventText(e, name, residentName).length).toBeGreaterThan(5);
  });
});
