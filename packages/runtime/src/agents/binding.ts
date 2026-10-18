/**
 * Which agent a Claude Code session belongs to (plan §0 Binding, §4.3).
 *
 * In order: a binding already made for the session id (fixed for its life;
 * continuation segments inherit it), a dispatch Runloop launched with that
 * session id, then the registered root that is the longest prefix of
 * realpath(hook.cwd). Anything else is an Arrival: traced exactly as today and
 * listed until someone claims it.
 */
import type { BindingMethod } from '@runloop-world/events';

export type BindingDecision =
  | { kind: 'bound'; agentId: string; method: BindingMethod; isNew: boolean }
  | { kind: 'arrival' };

export interface BindingLookups {
  existing(sessionId: string): { agentId: string; method: BindingMethod } | null;
  /** The agent a running dispatch launched this session id for. */
  dispatchAgent(sessionId: string): string | null;
  /** The agent whose workspace root holds `cwd`. */
  pathAgent(cwd: string): string | null;
}

export function resolveBinding(session: { sessionId: string; cwd: string | null }, lookups: BindingLookups): BindingDecision {
  const existing = lookups.existing(session.sessionId);
  if (existing) return { kind: 'bound', ...existing, isNew: false };
  const dispatched = lookups.dispatchAgent(session.sessionId);
  if (dispatched) return { kind: 'bound', agentId: dispatched, method: 'dispatch', isNew: true };
  const byPath = session.cwd ? lookups.pathAgent(session.cwd) : null;
  if (byPath) return { kind: 'bound', agentId: byPath, method: 'path', isNew: true };
  return { kind: 'arrival' };
}

/** An unbound session seen by this process. Its cwd lives only here, in memory. */
export interface ArrivalSeen {
  sessionId: string;
  cwd: string | null;
  runIds: string[];
  firstSeenAt: string;
  lastEventAt: string;
}

/** Arrivals seen since boot (bounded; the oldest are forgotten first). */
export class Arrivals {
  private readonly seen = new Map<string, ArrivalSeen>();

  constructor(private readonly max = 200) {}

  note(sessionId: string, runId: string | null, cwd: string | null, at: string): void {
    let a = this.seen.get(sessionId);
    if (!a) {
      a = { sessionId, cwd, runIds: [], firstSeenAt: at, lastEventAt: at };
      this.seen.set(sessionId, a);
      if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    }
    if (cwd) a.cwd = cwd;
    if (runId && !a.runIds.includes(runId)) a.runIds.push(runId);
    a.lastEventAt = at;
  }

  get(sessionId: string): ArrivalSeen | undefined {
    return this.seen.get(sessionId);
  }

  remove(sessionId: string): void {
    this.seen.delete(sessionId);
  }

  all(): ArrivalSeen[] {
    return [...this.seen.values()];
  }
}
