/** Minimal shape the buffer needs; works for parsed and unknown events alike. */
export interface Sequenced {
  sequence: number;
  eventId: string;
}

export interface SequenceConflict {
  sequence: number;
  keptEventId: string;
  droppedEventId: string;
}

/**
 * Reorders one run's events by `sequence`. Accepts out-of-order and duplicate
 * deliveries and only releases contiguous runs, so consumers never see a gap.
 * It has no timers: callers poll `missing()` and backfill.
 */
export class SequenceBuffer<E extends Sequenced> {
  private next: number;
  private readonly pending = new Map<number, E>();
  private readonly releasedIds = new Map<number, string>();
  readonly conflicts: SequenceConflict[] = [];

  /** @param after the last sequence already consumed (0 = nothing yet). */
  constructor(opts: { after?: number } = {}) {
    this.next = (opts.after ?? 0) + 1;
  }

  /** Next sequence the buffer is waiting for. */
  get nextExpected(): number {
    return this.next;
  }

  /** Last sequence released to the consumer. */
  get lastReleased(): number {
    return this.next - 1;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Add one event; returns the events that became releasable, in order. */
  push(event: E): E[] {
    const seq = event.sequence;
    if (seq < this.next) {
      const kept = this.releasedIds.get(seq);
      if (kept !== undefined && kept !== event.eventId) {
        this.conflicts.push({ sequence: seq, keptEventId: kept, droppedEventId: event.eventId });
      }
      return [];
    }
    const held = this.pending.get(seq);
    if (held) {
      if (held.eventId !== event.eventId) {
        this.conflicts.push({ sequence: seq, keptEventId: held.eventId, droppedEventId: event.eventId });
      }
      return [];
    }
    this.pending.set(seq, event);
    return this.drain();
  }

  pushMany(events: Iterable<E>): E[] {
    const out: E[] = [];
    for (const e of events) out.push(...this.push(e));
    return out;
  }

  /** The gap blocking release, if any: sequences [from, to] are missing. */
  missing(): { from: number; to: number } | null {
    if (this.pending.size === 0) return null;
    let min = Infinity;
    for (const seq of this.pending.keys()) if (seq < min) min = seq;
    return { from: this.next, to: min - 1 };
  }

  private drain(): E[] {
    const out: E[] = [];
    for (let e = this.pending.get(this.next); e; e = this.pending.get(this.next)) {
      this.pending.delete(this.next);
      this.releasedIds.set(this.next, e.eventId);
      out.push(e);
      this.next += 1;
    }
    return out;
  }
}
