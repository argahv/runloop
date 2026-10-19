/**
 * Replay (plan §10): the latest checkpoint at or before a seq, plus a fold of
 * the recorded events. Nothing is simulated, so replay survives sim upgrades.
 */
import type { WorldEvent, WorldEventOf } from '@runloop-world/events';
import { canonicalJson, fnv1a64 } from '@runloop-world/town';
import { applyEvent, type SimState, type TownBuildingList } from './apply';

/** Hash of the canonical state, for checkpoints and stream-vs-server checks. */
export function hashState(s: SimState): string {
  return fnv1a64(canonicalJson(s));
}

export interface WorldCheckpoint {
  seq: number;
  state: SimState;
}

export class WorldReplay {
  readonly events: readonly WorldEvent[];
  readonly checkpoints: readonly WorldCheckpoint[];
  private readonly town: TownBuildingList | undefined;

  /** `events` in seq order without gaps; checkpoints in any order. `town` is needed to fold from world.created. */
  constructor(events: readonly WorldEvent[], checkpoints: readonly WorldCheckpoint[] = [], town?: TownBuildingList) {
    events.forEach((e, i) => {
      if (i && e.seq !== events[i - 1]!.seq + 1) throw new Error(`WorldReplay: gap before seq ${e.seq}`);
    });
    this.events = events;
    this.checkpoints = [...checkpoints].sort((a, b) => a.seq - b.seq);
    this.town = town;
  }

  /** The state after event `seq`. */
  stateAt(seq: number): SimState {
    let cp: WorldCheckpoint | undefined;
    for (const c of this.checkpoints) if (c.seq <= seq) cp = c;
    let s: SimState | null = cp ? structuredClone(cp.state) : null;
    const first = this.events[0]?.seq ?? 1;
    const from = cp ? cp.seq + 1 : first;
    if (from < first) throw new Error(`WorldReplay: events before seq ${first} are not available`);
    const last = this.events.at(-1)?.seq ?? 0;
    if (seq > last && seq > (cp?.seq ?? 0)) throw new Error(`WorldReplay: no event ${seq} (last is ${last})`);
    for (let q = from; q <= seq; q++) s = applyEvent(s, this.events[q - first]!, this.town);
    if (!s) throw new Error('WorldReplay: no state before world.created');
    return s;
  }

  /** The resident's latest decision at or before `seq` (null = none recorded). */
  decisionAt(r: number, seq: number): WorldEventOf<'resident.decided'> | null {
    const first = this.events[0]?.seq ?? 1;
    for (let i = Math.min(seq - first, this.events.length - 1); i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === 'resident.decided' && e.p.r === r) return e;
    }
    return null;
  }
}
