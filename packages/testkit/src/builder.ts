import {
  SCHEMA_VERSION,
  deriveRefs,
  type EventDraft,
  type EventOf,
  type EventType,
  type PayloadOf,
  type RunEvent,
} from '@runloop-world/events';
import { FakeClock } from './clock';
import { idGen, uuidFor } from './ids';

export interface RunBuilderOptions {
  runId?: string;
  startIso?: string;
  /** Namespace for generated event ids (keeps fixtures from colliding). */
  namespace?: number;
}

export interface EventMeta {
  actorId?: string;
  taskId?: string;
  parentEventId?: string;
  visibility?: RunEvent['visibility'];
}

/**
 * Fluent builder for hand-written event streams. Sequences start at 1 and
 * are contiguous; timestamps come from a FakeClock you advance explicitly.
 */
export class RunBuilder {
  readonly runId: string;
  readonly clock: FakeClock;
  readonly events: RunEvent[] = [];
  private readonly nextId: () => string;

  constructor(opts: RunBuilderOptions = {}) {
    const ns = opts.namespace ?? 0xf1;
    this.runId = opts.runId ?? uuidFor(ns, 0xffff);
    this.clock = new FakeClock(opts.startIso);
    this.nextId = idGen(ns);
  }

  /** Advance the clock by `ms` before the next event. */
  wait(ms: number): this {
    this.clock.advance(ms);
    return this;
  }

  add<T extends EventType>(type: T, payload: PayloadOf<T>, meta: EventMeta = {}): EventOf<T> {
    const refs = deriveRefs({ type, payload } as EventDraft);
    const event = {
      eventId: this.nextId(),
      runId: this.runId,
      sequence: this.events.length + 1,
      timestamp: this.clock.iso(),
      type,
      schemaVersion: SCHEMA_VERSION,
      ...refs,
      ...(meta.actorId !== undefined ? { actorId: meta.actorId } : {}),
      ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
      ...(meta.parentEventId !== undefined ? { parentEventId: meta.parentEventId } : {}),
      visibility: meta.visibility ?? 'public',
      payload,
    } as EventOf<T>;
    this.events.push(event as RunEvent);
    return event;
  }

  get last(): RunEvent | undefined {
    return this.events[this.events.length - 1];
  }
}

export function runBuilder(opts: RunBuilderOptions = {}): RunBuilder {
  return new RunBuilder(opts);
}
