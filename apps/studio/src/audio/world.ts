/**
 * The world's event cues (contract §4b): follows the world store's log and
 * plays a cue for a live, real agent event (`classifyCue`).
 *
 * - It keeps its own agent state (health, attention, open incidents), seeded
 *   from the snapshot and folded from each event in seq order, so it knows
 *   what each event changed.
 * - Nothing from before it attached, from a snapshot (connect or resync), or
 *   from a reconnect's backfill makes a sound: cues need the world `live` and
 *   are suppressed for 3 s after each snapshot and each return to `live`.
 * - A disabled world (RUNLOOP_WORLD=off) never cues.
 * - It also passes the store's reduced-motion flag (no whoosh) and the agent
 *   buildings and lots (never a murmur source) to the engine.
 */
import type { WorldSnapshot } from '@runloop-world/events';
import type { WorldStore, WorldUiState } from '../world/store';
import { classifyCue, cueAgentId, nextAgentState } from './cues';
import { getAudio, getAudioEngine } from './engine';
import type { AgentAudioState, RunloopAudio } from './types';

/** After a snapshot or a reconnect, events are catching up, not news. */
export const RESYNC_QUIET_MS = 3000;

/** What the world needs from the engine (the engine, or a fake in tests). */
export interface WorldCueSink {
  cue: RunloopAudio['cue'];
  setReducedMotion: RunloopAudio['setReducedMotion'];
  suppressCues?(ms: number): void;
  setExcluded?(ids: Iterable<string>): void;
}

export function attachWorldAudio(store: WorldStore, sink: WorldCueSink = getAudioEngine() ?? getAudio()): () => void {
  const agents = new Map<string, AgentAudioState>();
  let snap: WorldSnapshot | null = null;
  let lastSeq = 0;
  let status: WorldUiState['status'] | null = null;
  let reduced: boolean | null = null;

  const excludePlaces = (s: WorldSnapshot) => {
    const ids: string[] = [];
    for (const a of s.agents) ids.push(a.buildingId, a.lotId);
    sink.setExcluded?.(ids);
  };

  const seed = (s: WorldSnapshot) => {
    agents.clear();
    for (const a of s.agents) agents.set(a.agentId, { health: a.health, attention: a.attention, openIncidents: a.openIncidents });
    lastSeq = s.seq;
    sink.suppressCues?.(RESYNC_QUIET_MS);
    excludePlaces(s);
  };

  const onState = (s: WorldUiState) => {
    if (s.reducedMotion !== reduced) {
      reduced = s.reducedMotion;
      sink.setReducedMotion(reduced);
    }
    if (s.status !== status) {
      if (s.status === 'live' && status !== null) sink.suppressCues?.(RESYNC_QUIET_MS);
      status = s.status;
    }
    if (s.snapshot !== snap) {
      snap = s.snapshot;
      if (snap) seed(snap);
      return;
    }
    if (!snap) return;
    const log = s.log;
    let i = log.length;
    while (i > 0 && log[i - 1]!.seq > lastSeq) i--;
    let housed = false;
    for (; i < log.length; i++) {
      const e = log[i]!;
      lastSeq = e.seq;
      const id = cueAgentId(e);
      if (!id) continue;
      const before = agents.get(id);
      const cue = classifyCue(e, before);
      const after = nextAgentState(before, e);
      if (after) agents.set(id, after);
      if (e.type === 'agent.housed') housed = true;
      if (cue && s.status === 'live') sink.cue(cue, { agentId: id });
    }
    if (housed) excludePlaces(snap);
  };

  onState(store.getState());
  return store.subscribe(onState);
}
