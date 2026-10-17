import { EnvelopeSchema, SCHEMA_VERSION, VisibilitySchema } from './envelope';
import type { AnyEvent, RunEvent, UnknownEvent } from './event';
import { isEventType, payloadSchemas } from './payloads';

export type ParseResult<E> = { ok: true; event: E } | { ok: false; error: string };

function describe(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Lenient parse for readers (studio, replay). Never throws.
 * - invalid envelope            -> { ok: false }
 * - unknown type / version / bad payload -> { ok: true, event: UnknownEvent }
 * - otherwise                   -> { ok: true, event: RunEvent }
 */
export function parseEvent(raw: unknown): ParseResult<AnyEvent> {
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, error: describe(env.error.issues) };
  const e = env.data;
  const unknownEvent = (reason: UnknownEvent['reason'], error?: string): ParseResult<AnyEvent> => ({
    ok: true,
    event: { ...e, unknown: true, reason, ...(error ? { error } : {}) },
  });
  if (!isEventType(e.type)) return unknownEvent('unknown_type');
  if (e.schemaVersion !== SCHEMA_VERSION) return unknownEvent('unsupported_version');
  const payload = payloadSchemas[e.type].safeParse(e.payload);
  if (!payload.success) return unknownEvent('invalid_payload', describe(payload.error.issues));
  return { ok: true, event: { ...e, payload: payload.data } as RunEvent };
}

/** Strict parse for writers (the recorder): only valid, known, current-version events pass. */
export function parseKnownEvent(raw: unknown): ParseResult<RunEvent> {
  const r = parseEvent(raw);
  if (!r.ok) return r;
  if ('unknown' in r.event) {
    const u = r.event as UnknownEvent;
    return { ok: false, error: `${u.reason}${u.error ? `: ${u.error}` : ''} (type ${u.type})` };
  }
  return { ok: true, event: r.event };
}

/**
 * Stand-in for an item whose envelope failed to parse but that still names
 * its sequence (e.g. a field value from a newer runtime). Readers fold it as
 * an UnknownEvent so the sequence advances and the stream never stalls on a
 * permanent gap. Returns null when there is no integer sequence ≥ 1.
 * Missing or invalid fields are filled from `fallback` (runId, timestamp) or
 * made up deterministically (eventId), so redeliveries dedupe.
 */
export function invalidEnvelopeEvent(
  raw: unknown,
  error: string,
  fallback: { runId: string; timestamp: string },
): UnknownEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sequence = r.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const runId = str(r.runId) ?? fallback.runId;
  const ts = str(r.timestamp);
  const visibility = VisibilitySchema.safeParse(r.visibility);
  const schemaVersion = r.schemaVersion;
  const actorId = str(r.actorId);
  const taskId = str(r.taskId);
  const parentEventId = str(r.parentEventId);
  return {
    eventId: str(r.eventId) ?? `invalid:${runId}:${sequence}`,
    runId,
    sequence,
    timestamp: ts && Number.isFinite(Date.parse(ts)) ? ts : fallback.timestamp,
    type: str(r.type) ?? 'invalid',
    schemaVersion: typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) ? schemaVersion : SCHEMA_VERSION,
    ...(actorId ? { actorId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(parentEventId ? { parentEventId } : {}),
    // An unrecognised visibility is treated as the most restrictive one.
    visibility: visibility.success ? visibility.data : 'sensitive',
    payload: r.payload,
    unknown: true,
    reason: 'invalid_envelope',
    error,
  };
}
