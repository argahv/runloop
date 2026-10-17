import { SequenceGapError } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import { msToTick, type CompiledWorld } from '@runloop-world/world-engine';
import { initialRunState, reduceRun } from './reduce-run';
import type { RunState } from './types';

const SNAPSHOT_EVERY = 50;
const MEMO_SIZE = 64;

/**
 * Random access over one run's ordered events: the state at any sequence and
 * the mapping between sequences and (monotonic) time since run start. Replay
 * never re-executes anything; it is a plain fold with snapshots and a memo.
 */
export class ReplayIndex {
  private readonly world: CompiledWorld;
  private readonly list: AnyEvent[] = [];
  /** times[i] = ms since run start of event i+1, clamped to be non-decreasing. */
  private readonly times: number[] = [];
  private readonly snapshots = new Map<number, RunState>();
  private readonly memo = new Map<number, RunState>();
  private head: RunState = initialRunState();
  private startMs: number | null = null;

  constructor(world: CompiledWorld, events: readonly AnyEvent[] = []) {
    this.world = world;
    this.snapshots.set(0, this.head);
    this.append(events);
  }

  /**
   * Add events in sequence order. Already-known sequences are ignored; a gap
   * throws SequenceGapError (order and dedupe upstream with SequenceBuffer).
   */
  append(events: readonly AnyEvent[]): void {
    for (const e of events) {
      const last = this.list.length;
      if (e.sequence <= last) continue;
      if (e.sequence !== last + 1) throw new SequenceGapError(last + 1, e.sequence);
      const ms = Date.parse(e.timestamp);
      this.startMs ??= ms;
      const prev = this.times[last - 1] ?? 0;
      this.list.push(e);
      this.times.push(Math.max(prev, ms - this.startMs));
      this.head = reduceRun(this.head, e, this.world);
      if (e.sequence % SNAPSHOT_EVERY === 0) this.snapshots.set(e.sequence, this.head);
    }
  }

  get events(): readonly AnyEvent[] {
    return this.list;
  }

  get lastSequence(): number {
    return this.list.length;
  }

  get runStartMs(): number | null {
    return this.startMs;
  }

  /** Time of the last event since run start (monotonic clamp). */
  get durationMs(): number {
    return this.times[this.times.length - 1] ?? 0;
  }

  /** State after folding events 1..seq (seq clamped to [0, lastSequence]). Memoized. */
  stateAt(seq: number): RunState {
    const n = Math.max(0, Math.min(this.lastSequence, Math.floor(seq)));
    if (n === this.lastSequence) return this.head;
    const snap = this.snapshots.get(n);
    if (snap) return snap;
    const hit = this.memo.get(n);
    if (hit) return hit;

    // Fold forward from the nearest snapshot (or a memoized state closer to n).
    let from = Math.floor(n / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
    for (const k of this.memo.keys()) if (k < n && k > from) from = k;
    let s = this.snapshots.get(from) ?? this.memo.get(from)!;
    for (let i = from; i < n; i++) s = reduceRun(s, this.list[i]!, this.world);

    this.memo.set(n, s);
    if (this.memo.size > MEMO_SIZE) this.memo.delete(this.memo.keys().next().value!);
    return s;
  }

  latest(): RunState {
    return this.head;
  }

  /** Ms since run start of event `seq` (0 for seq ≤ 0; clamped to the last event). */
  timeOfSeq(seq: number): number {
    if (seq <= 0 || this.list.length === 0) return 0;
    return this.times[Math.min(this.list.length, Math.floor(seq)) - 1]!;
  }

  /** Largest sequence whose time is ≤ ms (0 if none). */
  seqAtTime(ms: number): number {
    let lo = 0;
    let hi = this.times.length; // answer in [0, length]
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid - 1]! <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Fractional world tick for a time since run start. */
  tickAtMs(ms: number): number {
    return msToTick(ms, this.world.def.tickHz);
  }
}
