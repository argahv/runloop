import type { Visibility } from './envelope';

export const REDACTED = '[REDACTED]';

/**
 * Credential shapes masked in every recorded string. Each pattern's first
 * group is kept (a prefix such as `password=` or `Bearer `) and the rest of
 * the match is the secret, replaced by `$1[REDACTED]`. A replacement never
 * re-matches, so redaction is idempotent. Bounded quantifiers keep the cost
 * linear on long strings.
 */
const PATTERNS: RegExp[] = [
  // Well-known token formats (the whole match is the secret).
  /()\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys
  /()\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe keys
  /()\bgh[opsur]_[A-Za-z0-9]{20,}/g, // GitHub tokens (classic, OAuth, app, user, refresh)
  /()\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /()\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab tokens
  /()\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /()\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /(\bhooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g, // Slack webhook URLs
  /()\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /()\bnpm_[A-Za-z0-9]{30,}/g, // npm tokens
  /()\bdckr_pat_[A-Za-z0-9_-]{20,}/g, // Docker Hub tokens
  // Credentials by position: the value after a recognisable prefix.
  /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@'"]{0,200}:)(?!\[REDACTED\])[^\s/@'"]+(?=@)/gi, // URL passwords: scheme://user:<pw>@
  /(\b(?:Proxy-)?Authorization["']?\s*[:=]\s*["']?(?:[A-Za-z][\w-]{0,30}\s+)?)(?!\[REDACTED\])(?![A-Za-z][\w-]{0,30}\s+\[REDACTED\])[^\s"',;]+/gi, // Authorization: <scheme> <value>
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, // bearer credentials anywhere
  /(\bX-[A-Za-z0-9-]{0,40}(?:key|token|secret|auth)[A-Za-z0-9-]{0,40}["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]+/gi, // X-…-Key / X-…-Token headers
  // name=value / name: value where the name ends in key, token, secret, password, … (assignments, form data, query strings).
  /([\w.-]{0,40}(?:key|token|secret|passw(?:or)?d|pwd|passphrase|credentials?)(?:[_.-][\w.-]{0,40})?["']?\s*[=:]\s*)(?!["']?\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&,;]+)/gi,
  /((?:^|\s)(?:-u|--user)[\s=]{0,3}["']?[^\s:"']{1,100}:)(?!\[REDACTED\])[^\s"']+/g, // curl -u user:<pw>
  /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]{0,200}?\s-p)(?!\[REDACTED\])[^\s-]\S*/g, // mysql -p<pw>
];

/**
 * The patterns as regex sources and flags. Copies that cannot import this
 * package (the Claude Code plugin) are parity-tested against it.
 */
export const REDACTION_PATTERNS: readonly { source: string; flags: string }[] = PATTERNS.map((re) => ({ source: re.source, flags: re.flags }));
export const REDACTION_PATTERN_SOURCES: readonly string[] = PATTERNS.map((re) => re.source);

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
  for (const re of PATTERNS) out = out.replace(re, `$1${REDACTED}`);
  return out;
}

/**
 * The secret values (8+ characters) the patterns would mask in `text`. Used to
 * mask the same values where no pattern can see them, e.g. a password from a
 * command that the command's error output repeats.
 */
export function secretValuesIn(text: string): string[] {
  const out: string[] = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[0].slice((m[1] ?? '').length).replace(/^["']|["']$/g, '');
      if (value.length >= 8 && !value.includes(REDACTED)) out.push(value);
    }
  }
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
