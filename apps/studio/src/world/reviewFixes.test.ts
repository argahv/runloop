import type { AgentSummary, WorldEvent } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { lotRefusal } from './lots';
import { addedAgentView, awaitsFirstEvent } from './selectors';
import { createWorldStore, MODE_PLACES } from './store';
import { commonsTown, fixtureSnapshot } from './test-utils';

describe('modes leave the building the viewer is in (no interior with the camera elsewhere)', () => {
  it('Intelligence, Lab and Agents from inside: leave, then frame the place', () => {
    for (const mode of ['intelligence', 'lab', 'agents'] as const) {
      const s = createWorldStore();
      s.getState().enter('bld_agent_hq_1');
      s.getState().setMode(mode);
      expect(s.getState().entered).toBeNull();
      // The place's focus supersedes the exit's restore.
      expect(s.getState().camera).toMatchObject({ kind: 'focus', ref: MODE_PLACES[mode] });
    }
  });

  it('Explore from inside leaves and restores the view from before the fly-in', () => {
    const s = createWorldStore();
    s.getState().enter('bld_corner_cafe');
    s.getState().setMode('explore');
    expect(s.getState().entered).toBeNull();
    expect(s.getState().camera).toMatchObject({ kind: 'exit' });
  });

  it('a link (camera: false) changes the mode without moving the camera or leaving', () => {
    const s = createWorldStore();
    s.getState().enter('bld_corner_cafe');
    const cam = s.getState().camera;
    s.getState().setMode('intelligence', { camera: false });
    expect(s.getState().entered).toBe('bld_corner_cafe');
    expect(s.getState().camera).toBe(cam);
  });

  it('the World Log or compare opened from inside (⌘K, a menu, an event link) leaves too; other sheets stay inside', () => {
    const s = createWorldStore();
    s.getState().enter('bld_agent_hq_1');
    s.getState().setOverlay('trace');
    expect(s.getState().entered).toBe('bld_agent_hq_1');
    s.getState().setOverlay('compare');
    expect(s.getState()).toMatchObject({ entered: null, mode: 'lab', overlay: 'compare' });
    s.getState().enter('bld_agent_hq_1');
    s.getState().showInLog({ seq: 3 });
    expect(s.getState()).toMatchObject({ entered: null, mode: 'intelligence', overlay: 'log' });
  });
});

describe('Add to World lots (a link can name anything)', () => {
  const town = commonsTown();
  const free = town.agentLots[1]!.id;

  it('refuses what is not an agent lot of this town, and a taken lot, with the reason', () => {
    expect(lotRefusal(town, [], 'lot_bogus')).toMatch(/^Lot not available: “lot_bogus” is not an agent lot/);
    expect(lotRefusal(town, [{ lotId: free, displayName: 'Docs Desk' }], free)).toMatch(/is Docs Desk's/);
    expect(lotRefusal(town, [], free)).toBeNull();
    // Nothing to check against yet: the runtime still refuses a bad lot on submit.
    expect(lotRefusal(null, null, 'lot_bogus')).toBeNull();
  });

  it('the store stays in lot picking with the reason instead of opening a card for a lot that does not exist', () => {
    const s = createWorldStore();
    s.getState().setTown(town);
    s.getState().applySnapshot(fixtureSnapshot(), 0);
    s.getState().setStage('3d');
    s.getState().openAddToWorld();
    s.getState().pickLot('lot_bogus');
    expect(s.getState().lotPick).toMatchObject({ selected: null });
    expect(s.getState().lotPick?.reason).toMatch(/not an agent lot/);
    const taken = s.getState().snapshot!.agents[0]!.lotId;
    s.getState().pickLot(taken);
    expect(s.getState().lotPick).toMatchObject({ selected: null });
    const open = town.agentLots.find((l) => !s.getState().snapshot!.agents.some((a) => a.lotId === l.id))!.id;
    s.getState().pickLot(open);
    expect(s.getState().lotPick).toMatchObject({ selected: open, reason: null });
    // The runtime refused the lot after all: back to picking with its reason.
    s.getState().pickLot(null, 'That lot was just taken.');
    expect(s.getState().lotPick).toMatchObject({ selected: null, reason: 'That lot was just taken.' });
  });
});

describe("Add to World's last step follows the live agent, never the create answer", () => {
  const created: AgentSummary = {
    agentId: 'agt_new',
    kind: 'claude-code',
    displayName: 'Review House',
    hue: '#5aa9f5',
    orgId: 'org_home',
    lotId: 'lot_agent_3',
    buildingId: 'bld_agent_hq_3',
    housed: true,
    health: 'awaiting_first_event',
    attention: 'none',
    lastEventAt: null,
    capabilities: {} as AgentSummary['capabilities'],
    workspace: { workspaceId: 'ws_1', label: 'review', pathHint: '~/review' },
    sessions: [],
  };
  const presence = (health: AgentSummary['health'], attention: AgentSummary['attention'] = 'none') => ({
    ...fixtureSnapshot().agents[0]!,
    agentId: 'agt_new',
    displayName: 'Review House',
    health,
    attention,
  });
  const live: WorldEvent = { seq: 40, tick: 304, type: 'agent.connection_changed', prov: 'system', cmdId: 'c', actor: 'agt_new', p: { agentId: 'agt_new', health: 'live', attention: 'none' } };

  it('waits (unpainted building, how to connect) only before the first real event', () => {
    expect(addedAgentView(created, null, null, [], 0).waiting).toBe(true);
    expect(addedAgentView(created, presence('awaiting_first_event'), null, [], 0).waiting).toBe(true);
    for (const h of ['live', 'idle', 'offline', 'unknown'] as const) expect(addedAgentView(created, presence(h), null, [live], 0).waiting).toBe(false);
    expect(awaitsFirstEvent('not_connected')).toBe(true);
  });

  it('then says the honest health, the attention line and when the first event came', () => {
    const v = addedAgentView(created, presence('live', 'incident'), null, [live], 0);
    expect(v).toMatchObject({ waiting: false, firstEventTick: 304, attention: 'A tool failed in the open session' });
    expect(v.health.text).toBe('Live');
    expect(addedAgentView(created, presence('offline'), null, [live], 0).health.text).toBe('Offline');
  });
});
