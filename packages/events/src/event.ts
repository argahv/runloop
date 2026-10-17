import type { Envelope, Provenance } from './envelope';
import type { EventType, PayloadOf } from './payloads';

type EnvelopeFields = Omit<Envelope, 'type' | 'payload'>;

/** A validated event of a specific known type. */
export type EventOf<T extends EventType> = EnvelopeFields & {
  type: T;
  payload: PayloadOf<T>;
};

/** Discriminated union of every known event (narrow with `switch (e.type)`). */
export type RunEvent = { [T in EventType]: EventOf<T> }[EventType];

/**
 * An event this version cannot interpret: an unknown type, an unsupported
 * schemaVersion or an invalid payload, or (from invalidEnvelopeEvent) an
 * invalid envelope that still names its sequence. Reducers skip it
 * (recording an anomaly) but the text trace still shows it.
 */
export type UnknownEvent = EnvelopeFields & {
  type: string;
  payload: unknown;
  unknown: true;
  reason: 'unknown_type' | 'unsupported_version' | 'invalid_payload' | 'invalid_envelope';
  error?: string;
};

export type AnyEvent = RunEvent | UnknownEvent;

export function isUnknownEvent(e: AnyEvent): e is UnknownEvent {
  return (e as { unknown?: unknown }).unknown === true;
}

/**
 * What an emitter supplies; the recorder fills in ids, sequence, timestamp and version.
 * `provenance` and `timestamp` are for traced runs only (the recorder rejects
 * them on executed runs): the time the source observed the event, and whether
 * it was reported or inferred.
 */
export type EventDraft<T extends EventType = EventType> = {
  [K in T]: {
    type: K;
    payload: PayloadOf<K>;
    actorId?: string;
    taskId?: string;
    parentEventId?: string;
    visibility?: Envelope['visibility'];
    provenance?: Provenance;
    timestamp?: string;
  };
}[T];

/**
 * Index fields implied by a payload. Emitters may override them (e.g. the
 * coordinator as actor of task.created).
 */
export function deriveRefs(draft: EventDraft): { actorId?: string; taskId?: string } {
  switch (draft.type) {
    case 'agent.registered':
    case 'agent.state_changed':
      return { actorId: draft.payload.agentId };
    case 'agent.message_sent':
      return { actorId: draft.payload.fromAgentId };
    case 'task.assigned':
    case 'task.started':
      return { actorId: draft.payload.agentId, taskId: draft.payload.taskId };
    case 'task.created':
    case 'task.blocked':
    case 'task.completed':
    case 'task.failed':
      return { taskId: draft.payload.taskId };
    case 'tool.call_started':
      return { actorId: draft.payload.agentId, taskId: draft.payload.taskId };
    case 'tool.permission_requested':
    case 'agent.usage_reported':
      return { actorId: draft.payload.agentId };
    case 'run.marker':
      return draft.payload.agentId ? { actorId: draft.payload.agentId } : {};
    default:
      return {};
  }
}
