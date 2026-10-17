import { EnvelopeSchema, SCHEMA_VERSION } from './envelope';
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
