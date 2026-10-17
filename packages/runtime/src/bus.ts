import type { RunEvent } from '@runloop-world/events';

export type Listener = (event: RunEvent) => void;
export type Unsubscribe = () => void;

/**
 * In-process fan-out of recorded events. Delivery is synchronous and in
 * publish order, even when a listener publishes from inside its callback
 * (those events are queued until the current one reached every listener).
 * Listener exceptions are caught and reported, never propagated.
 */
export class EventBus {
  private readonly byRun = new Map<string, Set<Listener>>();
  private readonly any = new Set<Listener>();
  private readonly queue: RunEvent[] = [];
  private delivering = false;

  constructor(private readonly onListenerError: (err: unknown) => void = (err) => console.error('[bus] listener error', err)) {}

  subscribe(runId: string, fn: Listener): Unsubscribe {
    let set = this.byRun.get(runId);
    if (!set) this.byRun.set(runId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.byRun.get(runId) === set) this.byRun.delete(runId);
    };
  }

  /** Listen to every run (used by the CLI trace printer). */
  subscribeAll(fn: Listener): Unsubscribe {
    this.any.add(fn);
    return () => this.any.delete(fn);
  }

  publish(event: RunEvent): void {
    this.queue.push(event);
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let e = this.queue.shift(); e; e = this.queue.shift()) this.deliver(e);
    } finally {
      this.delivering = false;
    }
  }

  private deliver(e: RunEvent): void {
    const listeners = [...(this.byRun.get(e.runId) ?? []), ...this.any];
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }
}
