import type { WorldEvent } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { createWorldStore } from '../world/store';
import { DOCS_DESK, ENGINEERING_HOUSE, commonsTown, fixtureEvents, fixtureSnapshot } from '../world/test-utils';
import { AudioEngine } from './engine';
import { fakeEnv } from './testing';
import type { EventCue } from './types';
import { RESYNC_QUIET_MS, attachWorldAudio, type WorldCueSink } from './world';

const NOW = 1_700_000_000_000;

function recordingSink() {
  const calls = { cues: [] as { cue: EventCue; agentId: string | undefined }[], suppress: 0, reduced: [] as boolean[], excluded: [] as string[][] };
  const sink: WorldCueSink = {
    cue: (cue, opts) => {
      calls.cues.push({ cue, agentId: opts?.agentId });
      return true;
    },
    setReducedMotion: (v) => void calls.reduced.push(v),
    suppressCues: () => void calls.suppress++,
    setExcluded: (ids) => void calls.excluded.push([...ids]),
  };
  return { sink, calls };
}

function liveStore() {
  const store = createWorldStore();
  store.getState().setTown(commonsTown());
  store.getState().applySnapshot(fixtureSnapshot(), NOW);
  store.getState().setStatus('live');
  return store;
}

const tail = () => {
  const snap = fixtureSnapshot();
  return fixtureEvents().filter((e) => e.seq > snap.seq);
};

let extraSeq = 0;
function connection(store: ReturnType<typeof createWorldStore>, agentId: string, health: string, attention = 'none'): WorldEvent {
  const s = store.getState().snapshot!;
  return {
    seq: s.seq + 1,
    tick: s.tick + 1,
    type: 'agent.connection_changed',
    prov: 'system',
    cmdId: `conn:${agentId}:x${++extraSeq}`,
    actor: agentId,
    p: { agentId, health, attention },
  } as WorldEvent;
}

describe('attachWorldAudio', () => {
  it('a recorded day: ~100 simulated events make no sound; the one real permission request cues needsApproval once', () => {
    const store = liveStore();
    const { sink, calls } = recordingSink();
    const off = attachWorldAudio(store, sink);
    const events = tail();
    expect(events.filter((e) => e.prov === 'simulation').length).toBeGreaterThan(90);
    store.getState().applyEvents(events, NOW + 50);
    expect(calls.cues).toEqual([{ cue: 'needsApproval', agentId: ENGINEERING_HOUSE }]);
    off();
  });

  it('never cues what was already in the snapshot or log when it attached', () => {
    const store = liveStore();
    store.getState().applyEvents(tail(), NOW + 50);
    const { sink, calls } = recordingSink();
    attachWorldAudio(store, sink);
    expect(calls.cues).toEqual([]);
    expect(calls.suppress).toBe(1);
  });

  it('knows each agent from the snapshot: an already-live agent does not "go live" again; a waiting one does', () => {
    const store = liveStore();
    const { sink, calls } = recordingSink();
    attachWorldAudio(store, sink);
    store.getState().applyEvents([connection(store, ENGINEERING_HOUSE, 'live')], NOW);
    expect(calls.cues).toEqual([]);
    store.getState().applyEvents([connection(store, DOCS_DESK, 'live')], NOW);
    expect(calls.cues).toEqual([{ cue: 'agentLive', agentId: DOCS_DESK }]);
  });

  it('only while the world is live: a reconnect backfill is silent, and returning to live suppresses for a moment', () => {
    const store = liveStore();
    const { sink, calls } = recordingSink();
    attachWorldAudio(store, sink);
    expect(calls.suppress).toBe(1);
    store.getState().setStatus('reconnecting');
    store.getState().applyEvents([connection(store, DOCS_DESK, 'live')], NOW);
    expect(calls.cues).toEqual([]);
    store.getState().setStatus('live');
    expect(calls.suppress).toBe(2);
    store.getState().setStatus('disabled');
    store.getState().applyEvents([connection(store, DOCS_DESK, 'live', 'permission_requested')], NOW);
    expect(calls.cues).toEqual([]);
  });

  it('a resync snapshot re-seeds the agents and suppresses', () => {
    const store = liveStore();
    const { sink, calls } = recordingSink();
    attachWorldAudio(store, sink);
    const fresh = fixtureSnapshot();
    fresh.agents[1]!.health = 'live';
    store.getState().applySnapshot(fresh, NOW + 10);
    expect(calls.suppress).toBe(2);
    store.getState().applyEvents([connection(store, DOCS_DESK, 'live')], NOW);
    expect(calls.cues).toEqual([]); // already live in the new snapshot
  });

  it('passes reduced motion and the agent places (never a murmur source) to the engine', () => {
    const store = liveStore();
    const { sink, calls } = recordingSink();
    attachWorldAudio(store, sink);
    expect(calls.excluded.at(-1)).toEqual(expect.arrayContaining(['bld_agent_hq_1', 'lot_agent_1', 'bld_agent_hq_4', 'lot_agent_4']));
    store.getState().setReducedMotion(true);
    expect(calls.reduced).toEqual([false, true]);
  });

  it('with the real engine: suppressed for 3 s after attaching, then played and paced', () => {
    const env = fakeEnv();
    const audio = new AudioEngine(env);
    audio.unlock();
    const store = liveStore();
    attachWorldAudio(store, audio);
    store.getState().applyEvents([connection(store, DOCS_DESK, 'live')], NOW);
    expect(audio.debug().lastCues.at(-1)).toMatchObject({ cue: 'agentLive', result: 'suppressed' });
    env.advance(RESYNC_QUIET_MS + 10);
    store.getState().applyEvents([connection(store, DOCS_DESK, 'live', 'permission_requested')], NOW);
    expect(audio.debug().lastCues.at(-1)).toMatchObject({ cue: 'needsApproval', agentId: DOCS_DESK, result: 'play' });
  });
});
