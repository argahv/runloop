import type { Visibility } from './envelope';

export const REDACTED = '[REDACTED]';

/** Well-known credential shapes. Replacements never re-match, so redaction is idempotent. */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, // HTTP bearer credentials
];

export interface RedactOptions {
  /** Literal secret values (e.g. from the environment). Values shorter than 8 chars are ignored. */
  secrets?: readonly string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact a single string. Returns the input unchanged (same value) when nothing matched. */
export function redactText(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const secret of opts.secrets ?? []) {
    if (secret.length < 8) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }
  for (const re of PATTERNS) out = out.replace(re, (m) => (m.startsWith('Bearer') ? `Bearer ${REDACTED}` : REDACTED));
  return out;
}

/** Walk any JSON-like value and redact every string. Returns the same reference when unchanged. */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === 'string') return redactText(value, opts) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = redactValue(v, opts);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? next : value) as T;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(v, opts);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/**
 * Redact an event-like object's payload. When anything was replaced, a
 * "public" event becomes "redacted". Idempotent.
 */
export function redactEvent<E extends { payload: unknown; visibility?: Visibility }>(
  event: E,
  opts: RedactOptions = {},
): { event: E; changed: boolean } {
  const payload = redactValue(event.payload, opts);
  if (payload === event.payload) return { event, changed: false };
  const visibility: Visibility = event.visibility === 'sensitive' ? 'sensitive' : 'redacted';
  return { event: { ...event, payload, visibility }, changed: true };
}
