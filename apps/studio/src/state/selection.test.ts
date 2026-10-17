import { foldExecution } from '@runloop-world/core';
import { describe, expect, it } from 'vitest';
import { agentOfEvent, artifactIdsOf, latestEventOf, parentChain } from './selection';
import { openFixture, wire } from './test-utils';

/** Fixture landmarks (codingMissionFixture): see the sequence comments below. */
const SEQ = {
  runStarted: 1,
  taskT1Created: 6, // actor: coordinator
  t1Completed: 19, // no actor; owner researcher
  call5Started: 26, // builder write_file
  art1: 27, // artifact of call-5
  call5Completed: 28,
  testsFailed: 36, // tester run_command, status error
  runCompleted: 58,
};

function loaded() {
  const { store, events } = openFixture();
  store.getState().ingest(events.map(wire), 'backlog');
  return { store, events, exec: foldExecution(events) };
}

describe('agentOfEvent', () => {
  const { events, exec } = loaded();
  const at = (seq: number) => events[seq - 1]!;

  it('attributes call results, artifacts and task results to the agent behind them', () => {
    expect(agentOfEvent(at(SEQ.call5Completed), exec)).toBe('builder');
    expect(agentOfEvent(at(SEQ.art1), exec)).toBe('builder');
    expect(agentOfEvent(at(SEQ.testsFailed), exec)).toBe('tester');
    expect(agentOfEvent(at(SEQ.t1Completed), exec)).toBe('researcher');
  });

  it('keeps the creator as the agent of task.created, and null for system events', () => {
    expect(agentOfEvent(at(SEQ.taskT1Created), exec)).toBe('coordinator');
    expect(agentOfEvent(at(SEQ.runStarted), exec)).toBeNull();
    expect(agentOfEvent(at(SEQ.runCompleted), exec)).toBeNull();
  });

  it('finds the latest event of an agent up to a sequence', () => {
    expect(latestEventOf(events, exec, 'builder', SEQ.call5Completed)).toBe(SEQ.call5Completed);
    expect(latestEventOf(events, exec, 'tester', 30)).toBe(5); // only its registration so far
    expect(latestEventOf(events, exec, 'nobody', 58)).toBeNull();
  });

  it('follows parent links and lists artifacts', () => {
    const byId = new Map(events.map((e) => [e.eventId, e]));
    expect(parentChain(at(SEQ.call5Completed), byId).map((e) => e.sequence)).toEqual([SEQ.call5Started]);
    expect(artifactIdsOf(at(SEQ.call5Completed))).toEqual(['art-1']);
  });
});

describe('synchronised selection (store)', () => {
  it('selecting a timeline event focuses its agent and station and opens the event', () => {
    const { store } = loaded();
    store.getState().selectEvent(SEQ.testsFailed, { seek: true });
    const s = store.getState();
    expect(s.selectedSeq).toBe(SEQ.testsFailed);
    expect(s.selectedAgentId).toBe('tester');
    expect(s.inspectorTab).toBe('event');
    // The station is the tester's station in the world state right after that event.
    expect(s.selectedStationId).toBe(s.stateAt(SEQ.testsFailed).world.characters.tester?.stationId ?? null);
    expect(s.selectedStationId).not.toBeNull();
    // seek: the playhead is at that event (replay, paused).
    expect(s.cursor).toMatchObject({ mode: 'replay', playing: false });
    expect(s.timeOfSeq(s.playheadSeq)).toBe(s.timeOfSeq(SEQ.testsFailed));
  });

  it('selecting without seek leaves the playhead alone', () => {
    const { store } = loaded();
    store.getState().selectEvent(SEQ.call5Completed);
    expect(store.getState().cursor).toEqual({ mode: 'live' });
    expect(store.getState().selectedAgentId).toBe('builder');
  });

  it('a system event clears the agent and station', () => {
    const { store } = loaded();
    store.getState().selectEvent(SEQ.testsFailed);
    store.getState().selectEvent(SEQ.runStarted);
    const s = store.getState();
    expect(s).toMatchObject({ selectedSeq: SEQ.runStarted, selectedAgentId: null, selectedStationId: null, inspectorTab: 'event' });
  });

  it('selecting a character opens its card and highlights its latest event at the playhead', () => {
    const { store } = loaded();
    store.getState().seekToSeq(30);
    store.getState().selectAgent('builder');
    const s = store.getState();
    expect(s.selectedAgentId).toBe('builder');
    expect(s.inspectorTab).toBe('agent');
    expect(s.selectedSeq).toBe(30); // agent.state_changed builder at #30
    expect(s.selectedStationId).toBe(s.stateAt(s.playheadSeq).world.characters.builder?.stationId ?? null);
  });

  it('deselecting the character keeps the selected event', () => {
    const { store } = loaded();
    store.getState().selectEvent(SEQ.call5Completed);
    store.getState().selectAgent(null);
    expect(store.getState()).toMatchObject({ selectedSeq: SEQ.call5Completed, selectedAgentId: null, inspectorTab: 'event' });
  });

  it('cycling characters selects each one and its latest event', () => {
    const { store, events, exec } = loaded();
    store.getState().cycleAgent(1);
    expect(store.getState().selectedAgentId).toBe('researcher');
    expect(store.getState().selectedSeq).toBe(latestEventOf(events, exec, 'researcher', events.length));
    store.getState().cycleAgent(1);
    expect(store.getState().selectedAgentId).toBe('builder');
  });

  it('ignores events that do not exist and clears everything on demand', () => {
    const { store } = loaded();
    store.getState().selectEvent(999);
    expect(store.getState().selectedSeq).toBeNull();
    store.getState().selectEvent(SEQ.testsFailed);
    store.getState().clearSelection();
    expect(store.getState()).toMatchObject({ selectedSeq: null, selectedAgentId: null, selectedStationId: null, inspectorTab: 'run' });
  });

  it('opening another run resets the selection', () => {
    const { store } = loaded();
    store.getState().selectEvent(SEQ.testsFailed);
    store.getState().openRun('00000000-0000-4000-8000-000000000000');
    expect(store.getState()).toMatchObject({ selectedSeq: null, selectedAgentId: null, inspectorTab: 'run', pendingFocus: null });
  });
});

describe('deep-link focus', () => {
  it('waits for the event to arrive, then selects it and moves the playhead there', () => {
    const { store, events } = openFixture();
    store.getState().focusDeepLink({ seq: SEQ.testsFailed, agentId: null });
    expect(store.getState().selectedSeq).toBeNull();
    store.getState().ingest(events.slice(0, 20).map(wire), 'live');
    expect(store.getState().pendingFocus).not.toBeNull();
    store.getState().ingest(events.slice(20).map(wire), 'live');
    const s = store.getState();
    expect(s.pendingFocus).toBeNull();
    expect(s).toMatchObject({ selectedSeq: SEQ.testsFailed, selectedAgentId: 'tester', inspectorTab: 'event' });
    expect(s.cursor.mode).toBe('replay');
  });

  it('an event is shown with its own agent, whatever agent the link names', () => {
    const { store } = loaded();
    store.getState().focusDeepLink({ seq: SEQ.testsFailed, agentId: 'builder' });
    expect(store.getState()).toMatchObject({ selectedSeq: SEQ.testsFailed, selectedAgentId: 'tester', inspectorTab: 'event' });
  });

  it('an agent alone selects it like a click on its character, without moving the playhead', () => {
    const { store } = loaded();
    store.getState().focusDeepLink({ seq: null, agentId: 'tester' });
    expect(store.getState()).toMatchObject({ selectedAgentId: 'tester', inspectorTab: 'agent', cursor: { mode: 'live' } });
  });

  it('restores a paused playhead and the agent card together (a reload after selecting an agent)', () => {
    const { store, events } = loaded();
    store.getState().seekToSeq(30);
    store.getState().selectAgent('builder');
    const before = store.getState();
    const { store: again } = openFixture();
    again.getState().focusDeepLink({ seq: null, agentId: 'builder', at: 30 });
    again.getState().ingest(events.map(wire), 'backlog');
    expect(again.getState()).toMatchObject({
      playheadSeq: 30,
      selectedAgentId: 'builder',
      selectedSeq: before.selectedSeq,
      inspectorTab: 'agent',
      cursor: { mode: 'replay', playing: false },
    });
  });

  it('keeps a live run live when the link names no playhead', () => {
    const { store, events } = openFixture();
    store.getState().ingest(events.slice(0, 40).map(wire), 'live');
    store.getState().focusDeepLink({ seq: null, agentId: 'builder', at: null });
    expect(store.getState()).toMatchObject({ selectedAgentId: 'builder', cursor: { mode: 'live' } });
  });

  it('is dropped once the run has ended without that event', () => {
    const { store } = loaded();
    store.getState().focusDeepLink({ seq: 500, agentId: null });
    expect(store.getState().pendingFocus).toBeNull();
    expect(store.getState().selectedSeq).toBeNull();
  });
});
