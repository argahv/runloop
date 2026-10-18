/**
 * Event cues (contract §4b): which real agent events make a sound, and how
 * often. Pure: `classifyCue` looks at one world event and the agent's state
 * before it; `CueLimiter` paces what may play, with an injected clock.
 *
 * Truth rule: only `agent.*` events can cue, never a `simulation` event (the
 * sim cannot emit `agent.*` at all, P1; the guard is here anyway). Residents,
 * interactions, buildings, the clock and commands never make an event sound.
 * A cue never stands alone: the same fact is always a notification with icon
 * and text.
 */
import type { WorldEvent } from '@runloop-world/events';
import type { AgentAudioState, EventCue } from './types';

/** A just-housed agent (`agent.housed` folds to this; also the state of an agent the tracker has not seen). */
export const HOUSED_AGENT: Readonly<AgentAudioState> = Object.freeze({ health: 'not_connected', attention: 'none', openIncidents: 0 });

/** Within one event the strongest cue wins. */
export const CUE_PRIORITY: Readonly<Record<EventCue, number>> = { needsApproval: 4, incident: 3, taskDone: 2, agentLive: 1 };

const strongest = (cues: EventCue[]): EventCue | null => cues.reduce<EventCue | null>((a, c) => (a && CUE_PRIORITY[a] >= CUE_PRIORITY[c] ? a : c), null);

/** The agent an `agent.*` event is about (null for any other event). */
export function cueAgentId(e: WorldEvent): string | null {
  if (!e.type.startsWith('agent.')) return null;
  const p = e.p as { agentId?: unknown };
  return typeof p.agentId === 'string' ? p.agentId : null;
}

/** The cue a live world event earns, given the agent's state before it; null for most events. */
export function classifyCue(e: WorldEvent, prev: AgentAudioState | undefined): EventCue | null {
  if (e.prov === 'simulation' || !e.type.startsWith('agent.')) return null;
  const before = prev ?? HOUSED_AGENT;
  switch (e.type) {
    case 'agent.connection_changed': {
      const cues: EventCue[] = [];
      const { health, attention } = e.p;
      if (attention !== before.attention) {
        if (attention === 'permission_requested' || attention === 'dispatch_awaiting_approval') cues.push('needsApproval');
        else if (attention === 'incident') cues.push('incident');
      }
      if (health === 'live' && before.health !== 'live') cues.push('agentLive');
      return strongest(cues);
    }
    case 'agent.activity_observed':
      return e.p.openIncidents > before.openIncidents ? 'incident' : null;
    case 'agent.dispatch_changed':
      if (e.p.phase !== 'finished') return null;
      switch (e.p.outcome) {
        case 'completed':
          return 'taskDone';
        case 'failed':
        case 'timed_out':
        case 'budget_exceeded':
        case 'lost':
          return 'incident';
        default:
          return null; // cancelled: the viewer did it
      }
    case 'agent.session_changed':
      if (e.p.phase !== 'ended') return null;
      return e.p.outcome === 'succeeded' ? 'taskDone' : e.p.outcome === 'failed' ? 'incident' : null;
    default:
      return null;
  }
}

/** Fold one event into the tracker's agent state (the same fields `applyEvent` sets). */
export function nextAgentState(prev: AgentAudioState | undefined, e: WorldEvent): AgentAudioState | undefined {
  switch (e.type) {
    case 'agent.housed':
      return { ...HOUSED_AGENT };
    case 'agent.connection_changed':
      return { ...(prev ?? HOUSED_AGENT), health: e.p.health, attention: e.p.attention };
    case 'agent.session_changed':
      return e.p.phase === 'started' ? { ...(prev ?? HOUSED_AGENT), openIncidents: 0 } : prev;
    case 'agent.activity_observed':
      return { ...(prev ?? HOUSED_AGENT), openIncidents: e.p.openIncidents };
    default:
      return prev;
  }
}

// ── Pacing ───────────────────────────────────────────────────────────

export interface CueLimits {
  /** Minimum time between two cues; later ones wait in a short queue. */
  spacingMs: number;
  queueMax: number;
  /** A queued cue older than this is dropped (the moment has passed). */
  queueMaxAgeMs: number;
  /** At most this many cues in any 60 s. */
  perMinute: number;
  /** The same cue for the same agent waits this long. */
  cooldownMs: Readonly<Record<EventCue, number>>;
}

export const CUE_LIMITS: Readonly<CueLimits> = {
  spacingMs: 1200,
  queueMax: 2,
  queueMaxAgeMs: 4000,
  perMinute: 6,
  cooldownMs: { agentLive: 60_000, needsApproval: 30_000, taskDone: 20_000, incident: 15_000 },
};

export type CueDecision = 'play' | 'queued' | 'cooldown' | 'rate' | 'queue_full' | 'suppressed' | 'hidden';

export interface PacedCue {
  cue: EventCue;
  agentId: string | null;
  pan: number;
  /** When it was offered (ms, the limiter's clock). */
  at: number;
}

interface Queued extends PacedCue {
  key: string;
  /** The key's cooldown start before this cue took it (restored if it is dropped). */
  prevKeyAt: number | undefined;
}

export class CueLimiter {
  private lastPlay = -Infinity;
  /** Times of cues played or queued within the last minute. */
  private recent: number[] = [];
  private lastByKey = new Map<string, number>();
  private queue: Queued[] = [];
  private suppressUntil = -Infinity;
  private hidden = false;

  constructor(
    private readonly now: () => number,
    private readonly limits: Readonly<CueLimits> = CUE_LIMITS,
  ) {}

  /** Ask to play a cue now. `play`: play it now; `queued`: `due()` will hand it out; anything else: dropped. */
  offer(cue: EventCue, agentId: string | null = null, pan = 0): CueDecision {
    const t = this.now();
    if (this.hidden) return 'hidden';
    if (t < this.suppressUntil) return 'suppressed';
    const key = `${agentId ?? '*'}|${cue}`;
    const last = this.lastByKey.get(key);
    if (last !== undefined && t - last < this.limits.cooldownMs[cue]) return 'cooldown';
    this.recent = this.recent.filter((x) => t - x < 60_000);
    if (this.recent.length >= this.limits.perMinute) return 'rate';
    if (this.queue.length === 0 && t - this.lastPlay >= this.limits.spacingMs) {
      this.lastByKey.set(key, t);
      this.recent.push(t);
      this.lastPlay = t;
      return 'play';
    }
    if (this.queue.length >= this.limits.queueMax) {
      // Make room by dropping the weakest waiting cue, unless the new one is weaker still.
      let weakest = 0;
      for (let i = 1; i < this.queue.length; i++) if (CUE_PRIORITY[this.queue[i]!.cue] <= CUE_PRIORITY[this.queue[weakest]!.cue]) weakest = i;
      const w = this.queue[weakest]!;
      if (CUE_PRIORITY[cue] <= CUE_PRIORITY[w.cue]) return 'queue_full';
      this.drop(weakest);
    }
    this.queue.push({ cue, agentId, pan, at: t, key, prevKeyAt: last });
    this.queue.sort((a, b) => CUE_PRIORITY[b.cue] - CUE_PRIORITY[a.cue] || a.at - b.at);
    this.lastByKey.set(key, t);
    this.recent.push(t);
    return 'queued';
  }

  /** Waiting cues whose turn has come (at most one per spacing). Call it from a timer. */
  due(): PacedCue[] {
    const t = this.now();
    if (this.hidden) {
      this.clear();
      return [];
    }
    for (let i = this.queue.length - 1; i >= 0; i--) if (t - this.queue[i]!.at > this.limits.queueMaxAgeMs) this.drop(i);
    if (this.queue.length === 0 || t - this.lastPlay < this.limits.spacingMs) return [];
    const q = this.queue.shift()!;
    this.lastPlay = t;
    return [{ cue: q.cue, agentId: q.agentId, pan: q.pan, at: q.at }];
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** No cues for `ms` (after a resync or reconnect: those events are not news). Clears the queue. */
  suppressFor(ms: number): void {
    this.suppressUntil = Math.max(this.suppressUntil, this.now() + ms);
    this.clear();
  }

  /** A hidden tab plays nothing and keeps nothing for later (no burst on return). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.clear();
  }

  private clear(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) this.drop(i);
  }

  private drop(i: number): void {
    const [q] = this.queue.splice(i, 1);
    if (!q) return;
    if (q.prevKeyAt === undefined) this.lastByKey.delete(q.key);
    else this.lastByKey.set(q.key, q.prevKeyAt);
    const r = this.recent.lastIndexOf(q.at);
    if (r >= 0) this.recent.splice(r, 1);
  }
}
