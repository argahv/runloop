#!/usr/bin/env node
// @ts-check
/**
 * Runloop tracer hook for Claude Code (one script for every hook event).
 *
 * stdin (the hook's JSON) → redact → slim → envelope → spool file → POST the
 * spool to the local Runloop runtime, oldest first → on 2xx delete what was sent.
 *
 * Rules: Node built-ins only; ALWAYS exit 0; NEVER write to stdout (Claude
 * Code would add it to the conversation for some hooks); loopback only.
 * Errors go to `$CLAUDE_PLUGIN_DATA/last-error.json` (and to stderr only with
 * RUNLOOP_TRACE_DEBUG=1). `--sync` (Stop, StopFailure, SessionEnd) uses a
 * shorter time budget, counted from process start. `--doctor` prints a setup
 * check (to stdout) and flushes the spool.
 *
 * The slimming and redaction below mirror packages/runtime (hook-input.ts,
 * summarize.ts) and packages/events (redact.ts); parity tests keep them equal.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN = { name: 'runloop-tracer', version: '0.1.0' };
export const DEFAULT_URL = 'http://127.0.0.1:4380';
export const INGEST_PATH = '/api/ingest/claude-code';
const MAX_STDIN = 64 * 1024 * 1024;
/**
 * Time budgets, counted from process start (Node's own start-up included).
 * Async hooks have a 5 s timeout in hooks.json, synchronous ones 2 s; Claude
 * Code waits for the synchronous ones, so they get less. When too little is
 * left, the event is only spooled: a later hook (or --doctor) sends it.
 */
const BUDGET_MS = 1500;
const SYNC_BUDGET_MS = 1000;
const POST_TIMEOUT_MS = 1000;
const SYNC_POST_TIMEOUT_MS = 500;
/** Do not start a request with less time than this left. */
const MIN_POST_MS = 150;
/** Per request: at most this many envelopes (the runtime's limit) and bytes (it accepts 1 MiB). */
const MAX_BATCH = 100;
const MAX_BATCH_BYTES = 512 * 1024;
const SPOOL_MAX_BYTES = 50 * 1024 * 1024;
const SPOOL_TTL_MS = 7 * 24 * 3600 * 1000;

// ── redaction (copy of packages/events/src/redact.ts) ──────────────────

export const REDACTED = '[REDACTED]';
/**
 * Same sources, flags and order as REDACTION_PATTERNS in @runloop-world/events.
 * Group 1 is kept, the rest of the match is the secret (replaced by `$1[REDACTED]`).
 */
export const REDACTION_PATTERNS = [
  { source: '()\\bsk-[A-Za-z0-9_-]{16,}', flags: 'g' },
  { source: '()\\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}', flags: 'g' },
  { source: '()\\bgh[opsur]_[A-Za-z0-9]{20,}', flags: 'g' },
  { source: '()\\bgithub_pat_[A-Za-z0-9_]{20,}', flags: 'g' },
  { source: '()\\bglpat-[A-Za-z0-9_-]{20,}', flags: 'g' },
  { source: '()\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', flags: 'g' },
  { source: '()\\bxox[abprs]-[A-Za-z0-9-]{10,}', flags: 'g' },
  { source: '(\\bhooks\\.slack\\.com\\/services\\/)[A-Za-z0-9/_-]+', flags: 'g' },
  { source: '()\\bAIza[0-9A-Za-z_-]{30,}', flags: 'g' },
  { source: '()\\bnpm_[A-Za-z0-9]{30,}', flags: 'g' },
  { source: '()\\bdckr_pat_[A-Za-z0-9_-]{20,}', flags: 'g' },
  { source: '(\\b[a-z][a-z0-9+.-]{0,20}:\\/\\/[^\\s/:@\'"]{0,200}:)(?!\\[REDACTED\\])[^\\s/@\'"]+(?=@)', flags: 'gi' },
  {
    source: '(\\b(?:Proxy-)?Authorization["\']?\\s*[:=]\\s*["\']?(?:[A-Za-z][\\w-]{0,30}\\s+)?)(?!\\[REDACTED\\])(?![A-Za-z][\\w-]{0,30}\\s+\\[REDACTED\\])[^\\s"\',;]+',
    flags: 'gi',
  },
  { source: '(\\bBearer\\s+)[A-Za-z0-9._~+/=-]{8,}', flags: 'g' },
  { source: '(\\bX-[A-Za-z0-9-]{0,40}(?:key|token|secret|auth)[A-Za-z0-9-]{0,40}["\']?\\s*[:=]\\s*["\']?)(?!\\[REDACTED\\])[^\\s"\',;]+', flags: 'gi' },
  {
    source: '([\\w.-]{0,40}(?:key|token|secret|passw(?:or)?d|pwd|passphrase|credentials?)(?:[_.-][\\w.-]{0,40})?["\']?\\s*[=:]\\s*)(?!["\']?\\[REDACTED\\])(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s"\'&,;]+)',
    flags: 'gi',
  },
  { source: '((?:^|\\s)(?:-u|--user)[\\s=]{0,3}["\']?[^\\s:"\']{1,100}:)(?!\\[REDACTED\\])[^\\s"\']+', flags: 'g' },
  { source: '(\\b(?:mysql|mysqldump|mysqladmin|mariadb)\\b[^|;&\\n]{0,200}?\\s-p)(?!\\[REDACTED\\])[^\\s-]\\S*', flags: 'g' },
];
export const REDACTION_PATTERN_SOURCES = REDACTION_PATTERNS.map((p) => p.source);
const PATTERNS = REDACTION_PATTERNS.map((p) => new RegExp(p.source, p.flags));

/** Shell-only secrets (copy of SHELL_SECRET_PATTERNS in packages/runtime summarize.ts). */
export const SHELL_SECRET_PATTERNS = [
  { re: /(\b\w{0,60}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD)\w{0,60}=)(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/gi, replace: '$1[REDACTED]' },
  { re: /(--(?:password|passwd|token|secret|api-key|access-key|secret-key)(?:=|\s+))(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/gi, replace: '$1[REDACTED]' },
  { re: /(\b(?:login|sshpass)\b[^|;&\n]{0,200}?\s-p\s+)(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/g, replace: '$1[REDACTED]' },
  { re: /(\b[\w-]{0,60}(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key)[\w-]{0,60}\s+)(?![-[])[A-Za-z0-9/+=_.:-]{16,}/gi, replace: '$1[REDACTED]' },
];

const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL/i;

/**
 * Values (≥ 8 chars) of env vars whose name looks like a credential, longest first.
 * @param {NodeJS.ProcessEnv} env
 */
export function collectEnvSecrets(env) {
  const out = new Set();
  for (const [key, value] of Object.entries(env)) if (value && value.length >= 8 && SECRET_KEY_RE.test(key)) out.add(value);
  return [...out].sort((a, b) => b.length - a.length);
}

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} text
 * @param {readonly string[]} secrets
 */
export function redactText(text, secrets) {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  for (const re of PATTERNS) out = out.replace(re, `$1${REDACTED}`);
  return out;
}

/**
 * The secret values (8+ characters) that `patterns` would mask in `text`.
 * @param {string} text
 * @param {readonly RegExp[]} patterns
 */
function valuesIn(text, patterns) {
  /** @type {string[]} */
  const out = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const value = m[0].slice((m[1] ?? '').length).replace(/^["']|["']$/g, '');
      if (value.length >= 8 && !value.includes(REDACTED)) out.push(value);
    }
  }
  return out;
}

/** @param {string} text */
export const secretValuesIn = (text) => valuesIn(text, PATTERNS);
/** @param {string} command */
export const shellSecretValues = (command) => valuesIn(command, SHELL_SECRET_PATTERNS.map((p) => p.re));

/** @param {string} command */
export function redactShell(command) {
  let out = command;
  for (const { re, replace } of SHELL_SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

// ── slimming (copy of packages/runtime/src/tracers/claude-code/hook-input.ts) ──

export const MAX_STRING = 4096;
const HEAD = 1000;
const TAIL = 3000;
const OUTPUT_TAIL = 2000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 200;
const MARGIN = 4096;
const DROP_KEYS = new Set(['transcript_path', 'agent_transcript_path', 'scratchpad_dir', 'tool_response']);
const SHORT_STRING_FIELDS = new Set(['status', 'agentId', 'agentType', 'resolvedModel', 'type', 'mode']);
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** @typedef {(s: string) => string} Redact */
/** @type {Redact} */
const keep = (s) => s;

/**
 * Keep the head and tail of a long string; `redact` sees each kept part (plus a margin) before it is cut.
 * @param {string} s
 * @param {Redact} [redact]
 */
export function capString(s, redact = keep) {
  if (s.length <= MAX_STRING) return redact(s);
  const head = redact(s.slice(0, HEAD + MARGIN)).slice(0, HEAD);
  const tail = redact(s.slice(-(TAIL + MARGIN))).slice(-TAIL);
  return `${head}\n…[${s.length - HEAD - TAIL} characters omitted]…\n${tail}`;
}

/**
 * @param {unknown} v
 * @param {number} depth
 * @param {Redact} redact
 * @returns {unknown}
 */
function capValue(v, depth, redact) {
  if (typeof v === 'string') return capString(v, redact);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => capValue(x, depth + 1, redact));
  if (typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, MAX_ITEMS)) if (x !== undefined) out[k] = capValue(x, depth + 1, redact);
    return out;
  }
  return null;
}

/** @param {string} s */
export function countLines(s) {
  if (s === '') return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

/**
 * @param {string} s
 * @param {number} n
 * @param {Redact} redact
 */
const tail = (s, n, redact) => (s.length <= n ? redact(s) : redact(s.slice(-(n + MARGIN))).slice(-n));
/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Reduce a tool_response to sizes, counts and the end of command output.
 * @param {unknown} resp
 * @param {Redact} [redact]
 */
export function summarizeToolResponse(resp, redact = keep) {
  const text = typeof resp === 'string' ? resp : (JSON.stringify(resp) ?? '');
  /** @type {Record<string, any>} */
  const out = { bytes: Buffer.byteLength(text, 'utf8') };
  if (typeof resp === 'string') {
    out.lines = countLines(resp);
    return out;
  }
  if (!isRecord(resp)) return out;
  /** @type {Record<string, number | boolean | string>} */
  const fields = {};
  for (const [k, v] of Object.entries(resp)) {
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') fields[k] = v;
    else if (typeof v === 'string' && SHORT_STRING_FIELDS.has(k) && v.length <= 200) fields[k] = v;
  }
  if (Object.keys(fields).length > 0) out.fields = fields;
  if (isRecord(resp.usage)) {
    /** @type {Record<string, number>} */
    const usage = {};
    for (const k of USAGE_FIELDS) {
      const v = resp.usage[k];
      if (typeof v === 'number' && Number.isFinite(v)) usage[k] = v;
    }
    out.usage = usage;
  }
  if (typeof resp.stdout === 'string') {
    out.stdoutTail = tail(resp.stdout, OUTPUT_TAIL, redact);
    out.stdoutLines = countLines(resp.stdout);
  }
  if (typeof resp.stderr === 'string') {
    out.stderrTail = tail(resp.stderr, OUTPUT_TAIL, redact);
    out.stderrLines = countLines(resp.stderr);
  }
  if (isRecord(resp.file)) {
    /** @type {Record<string, number>} */
    const file = {};
    for (const k of ['numLines', 'startLine', 'totalLines']) {
      const v = resp.file[k];
      if (typeof v === 'number' && Number.isFinite(v)) file[k] = v;
    }
    out.file = file;
  }
  if (Array.isArray(resp.structuredPatch)) {
    let added = 0;
    let removed = 0;
    for (const hunk of resp.structuredPatch) {
      const lines = isRecord(hunk) && Array.isArray(hunk.lines) ? hunk.lines : [];
      for (const line of lines) {
        if (typeof line !== 'string') continue;
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
    out.linesAdded = added;
    out.linesRemoved = removed;
  }
  return out;
}

/**
 * PostToolBatch: only which calls the batch held.
 * @param {unknown[]} calls
 */
function slimToolCalls(calls) {
  return calls.slice(0, MAX_ITEMS).flatMap((c) => {
    if (!isRecord(c)) return [];
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of ['tool_name', 'tool_use_id']) if (typeof c[k] === 'string') out[k] = c[k].slice(0, 200);
    return [out];
  });
}

/**
 * Drop Claude Code's own file paths, replace tool_response by a summary, cap strings
 * (after `redact` has seen them whole). Idempotent.
 * @param {Record<string, unknown>} hook
 * @param {Redact} [redact]
 * @returns {Record<string, unknown>}
 */
export function slimHook(hook, redact = keep) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(hook)) {
    if (DROP_KEYS.has(k) || v === undefined) continue;
    out[k] = k === 'tool_calls' && Array.isArray(v) ? capValue(slimToolCalls(v), 0, redact) : capValue(v, 0, redact);
  }
  if ('tool_response' in hook) out.tool_result = capValue(summarizeToolResponse(hook.tool_response, redact), 0, redact);
  return out;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

/** @param {Record<string, unknown>} hook */
function shellCommand(hook) {
  const input = hook.tool_input;
  return SHELL_TOOLS.has(String(hook.tool_name)) && isRecord(input) && typeof input.command === 'string' ? input.command : undefined;
}

/**
 * The parts of a string kept after capping (with the margin): the only parts worth scanning.
 * @param {string} s
 */
const scanParts = (s) => (s.length <= MAX_STRING + 2 * MARGIN ? [s] : [s.slice(0, HEAD + MARGIN), s.slice(-(TAIL + MARGIN))]);

/**
 * Literal secrets for one hook: `given` plus every value a pattern finds in the hook
 * (so a password from a command is also masked where its output repeats it). Longest first.
 * @param {Record<string, unknown>} hook
 * @param {readonly string[]} [given]
 */
export function hookSecrets(hook, given = []) {
  const found = new Set(given.filter((s) => s.length >= 8));
  /**
   * @param {unknown} v
   * @param {number} depth
   */
  const visit = (v, depth) => {
    if (typeof v === 'string') {
      for (const part of scanParts(v)) for (const x of secretValuesIn(part)) found.add(x);
    } else if (depth < MAX_DEPTH && Array.isArray(v)) {
      for (const x of v.slice(0, MAX_ITEMS)) visit(x, depth + 1);
    } else if (depth < MAX_DEPTH && isRecord(v)) {
      for (const x of Object.values(v).slice(0, MAX_ITEMS)) visit(x, depth + 1);
    }
  };
  visit(hook, 0);
  const command = shellCommand(hook);
  if (command !== undefined) for (const part of scanParts(command)) for (const x of shellSecretValues(part)) found.add(x);
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * Redact, then slim (same as redactHook in the runtime's hook-input.ts). Idempotent.
 * @param {Record<string, unknown>} hook
 * @param {readonly string[]} [secrets]
 */
export function redactHook(hook, secrets = []) {
  const literal = hookSecrets(hook, secrets);
  const command = shellCommand(hook);
  const input = command === undefined ? hook : { ...hook, tool_input: { .../** @type {Record<string, unknown>} */ (hook.tool_input), command: redactShell(command) } };
  return slimHook(input, (s) => redactText(s, literal));
}

// ── configuration ──────────────────────────────────────────────────────

/** @param {string | undefined} v */
const isOff = (v) => v !== undefined && /^(0|off|false|no)$/i.test(v.trim());

/** @param {NodeJS.ProcessEnv} env */
export function tracingEnabled(env) {
  return !isOff(env.RUNLOOP_TRACE) && !isOff(env.CLAUDE_PLUGIN_OPTION_ENABLED);
}

/** @param {NodeJS.ProcessEnv} env */
export function promptsEnabled(env) {
  return !isOff(env.RUNLOOP_TRACE_PROMPTS) && !isOff(env.CLAUDE_PLUGIN_OPTION_TRACE_PROMPTS);
}

/**
 * Same path as the runtime (packages/runtime/src/ingest-token.ts), falling back to this user's home.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveTokenFile(env, platform = process.platform) {
  const explicit = env.RUNLOOP_INGEST_TOKEN_FILE?.trim();
  if (explicit) return path.resolve(explicit);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'runloop', 'ingest-token');
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'runloop', 'ingest-token');
  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.config', 'runloop', 'ingest-token');
}

/**
 * The runtime URL (env, then plugin option, then default) and whether it is loopback.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ url: string, from: string, loopback: boolean }}
 */
export function resolveRuntimeUrl(env) {
  const fromEnv = env.RUNLOOP_URL?.trim();
  const fromOption = env.CLAUDE_PLUGIN_OPTION_RUNTIME_URL?.trim();
  const [raw, from] = fromEnv ? [fromEnv, 'RUNLOOP_URL'] : fromOption ? [fromOption, 'plugin option runtime_url'] : [DEFAULT_URL, 'default'];
  const url = raw.replace(/\/+$/, '');
  let loopback = false;
  try {
    const u = new URL(url);
    loopback = (u.protocol === 'http:' || u.protocol === 'https:') && /^(localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/.test(u.hostname);
  } catch {
    loopback = false;
  }
  return { url, from, loopback };
}

/** @param {NodeJS.ProcessEnv} env */
export function dataDir(env) {
  return env.CLAUDE_PLUGIN_DATA?.trim() || path.join(os.homedir(), '.claude', 'plugins', 'data', 'runloop-tracer');
}

/**
 * Data dirs `--doctor` checks. Claude Code sets CLAUDE_PLUGIN_DATA for hooks only;
 * from a shell, look for every dir it created for this plugin: `runloop-tracer-inline`
 * for `--plugin-dir` (observed), and any other `runloop-tracer-*` dir (an installed copy).
 * @param {NodeJS.ProcessEnv} env
 */
export function doctorDataDirs(env) {
  if (env.CLAUDE_PLUGIN_DATA?.trim()) return [env.CLAUDE_PLUGIN_DATA.trim()];
  const root = path.join(env.HOME?.trim() || os.homedir(), '.claude', 'plugins', 'data');
  /** @type {string[]} */
  let found = [];
  try {
    found = readdirSync(root)
      .filter((name) => name === 'runloop-tracer' || name.startsWith('runloop-tracer-'))
      .sort()
      .map((name) => path.join(root, name));
  } catch {
    // No data dir yet.
  }
  return found.length > 0 ? found : [dataDir(env)];
}

// ── envelope ───────────────────────────────────────────────────────────

/**
 * The envelope for one hook invocation: redacted, slimmed, stamped.
 * @param {Record<string, unknown>} input
 * @param {{ env: NodeJS.ProcessEnv, ppid: number, now?: Date, deliveryId?: string }} opts
 */
export function buildEnvelope(input, opts) {
  const raw = !promptsEnabled(opts.env) && typeof input.prompt === 'string' ? { ...input, prompt: '[prompt not recorded]' } : input;
  return {
    v: /** @type {const} */ (1),
    deliveryId: opts.deliveryId ?? randomUUID(),
    observedAt: (opts.now ?? new Date()).toISOString(),
    ppid: opts.ppid,
    plugin: PLUGIN,
    hook: redactHook(raw, collectEnvSecrets(opts.env)),
  };
}

// ── spool ──────────────────────────────────────────────────────────────

/** @param {NodeJS.ProcessEnv} env */
export const spoolRoot = (env) => path.join(dataDir(env), 'spool');

/** @param {unknown} sessionId */
const sessionDirName = (sessionId) => (typeof sessionId === 'string' && sessionId ? sessionId : 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);

/**
 * Write the envelope to its own spool file (tmp, then rename) before any network call.
 * @param {string} root
 * @param {{ deliveryId: string, observedAt: string, hook: Record<string, unknown> }} envelope
 */
export function writeSpool(root, envelope) {
  const dir = path.join(root, sessionDirName(envelope.hook.session_id));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${envelope.observedAt.replace(/[:.]/g, '-')}-${envelope.deliveryId}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/**
 * Spool files, oldest first (names start with the observed time). Drops expired and oversized entries.
 * @param {string} root
 * @param {number} nowMs
 * @returns {{ file: string, bytes: number }[]}
 */
export function listSpool(root, nowMs = Date.now()) {
  /** @type {{ file: string, name: string, bytes: number, mtimeMs: number }[]} */
  const all = [];
  let sessions = [];
  try {
    sessions = readdirSync(root);
  } catch {
    return [];
  }
  for (const s of sessions) {
    let names = [];
    try {
      names = readdirSync(path.join(root, s));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(root, s, name);
      try {
        const st = statSync(file);
        all.push({ file, name, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // removed meanwhile by another hook
      }
    }
  }
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** @param {string} file */
  const remove = (file) => {
    try {
      rmSync(file, { force: true });
    } catch {
      // read-only spool: leave it
    }
  };
  const kept = all.filter((e) => {
    if (nowMs - e.mtimeMs <= SPOOL_TTL_MS) return true;
    remove(e.file);
    return false;
  });
  let total = kept.reduce((n, e) => n + e.bytes, 0);
  while (total > SPOOL_MAX_BYTES && kept.length > 0) {
    const oldest = /** @type {{ file: string, bytes: number }} */ (kept.shift());
    remove(oldest.file);
    total -= oldest.bytes;
  }
  return kept.map(({ file, bytes }) => ({ file, bytes }));
}

/**
 * A spool file's envelope, or null (unreadable or not a v1 envelope: deleted).
 * @param {string} file
 */
function readSpooled(file) {
  try {
    const env = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(env) && env.v === 1 && typeof env.deliveryId === 'string' && isRecord(env.hook)) return env;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
  }
  rmSync(file, { force: true });
  return null;
}

// ── network ────────────────────────────────────────────────────────────

/**
 * POST envelopes. Returns the HTTP status, or 0 on a network error or timeout.
 * @param {string} url
 * @param {string} token
 * @param {unknown[]} envelopes
 * @param {number} timeoutMs
 */
export async function postEnvelopes(url, token, envelopes, timeoutMs) {
  try {
    const res = await fetch(`${url}${INGEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runloop-token': token },
      body: JSON.stringify({ envelopes }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {string} file */
function readToken(file) {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Problems with the token file's permissions, or null (Windows: not checked).
 * @param {string} file
 */
export function tokenFileProblem(file) {
  if (process.platform === 'win32') return null;
  try {
    const st = statSync(file);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `owned by another user (uid ${st.uid})`;
    if ((st.mode & 0o077) !== 0) return `readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`;
  } catch {
    // missing: reported separately
  }
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function recordError(env, message, extra = {}) {
  try {
    const dir = dataDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, 'last-error.json'), JSON.stringify({ at: new Date().toISOString(), message, ...extra }, null, 2));
  } catch {
    // nothing else we can do without stdout
  }
  if (env.RUNLOOP_TRACE_DEBUG === '1') process.stderr.write(`[runloop-tracer] ${message}\n`);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, unknown>} info
 */
function recordOk(env, info) {
  try {
    writeFileSync(path.join(dataDir(env), 'last-ok.json'), JSON.stringify({ at: new Date().toISOString(), ...info }, null, 2));
  } catch {
    // best effort
  }
}

/** @typedef {{ file: string | null, bytes: number, envelope?: unknown }} Pending */

/**
 * Send pending envelopes in order (oldest first, across sessions), in requests
 * of at most MAX_BATCH envelopes and MAX_BATCH_BYTES, until all are sent or the
 * deadline is near. An envelope is never sent before an older one that is still
 * waiting, so a late SessionEnd cannot close a run ahead of its own events.
 * Spool files are deleted once accepted (or rejected as invalid: 400, 413).
 * @param {{ url: string, token: string, entries: Pending[], deadline: number, timeoutMs: number }} opts
 * @returns {Promise<{ sent: number, dropped: number, left: number, error: string | null, status: number }>}
 */
export async function sendInOrder({ url, token, entries, deadline, timeoutMs }) {
  let sent = 0;
  let dropped = 0;
  let i = 0;
  /**
   * @param {{ file: string | null, env: unknown }[]} chunk
   * @returns {Promise<{ ok: boolean, status: number, error: string | null }>}
   */
  const send = async (chunk) => {
    const remaining = deadline - Date.now();
    if (remaining < MIN_POST_MS) return { ok: false, status: 0, error: 'out of time' };
    const { status, error } = await postEnvelopes(url, token, chunk.map((c) => c.env), Math.min(timeoutMs, remaining - 50));
    const invalid = status === 400 || status === 413;
    // One invalid envelope must not take the valid ones with it: split and retry, in order.
    if (invalid && chunk.length > 1) {
      const half = Math.ceil(chunk.length / 2);
      const first = await send(chunk.slice(0, half));
      return first.ok ? send(chunk.slice(half)) : first;
    }
    if ((status >= 200 && status < 300) || invalid) {
      for (const c of chunk) if (c.file) rmSync(c.file, { force: true });
      if (invalid) dropped += chunk.length;
      else sent += chunk.length;
      return { ok: true, status, error: invalid ? error : null };
    }
    return { ok: false, status, error };
  };
  while (i < entries.length) {
    /** @type {{ file: string | null, env: unknown }[]} */
    const chunk = [];
    let bytes = 0;
    while (i < entries.length && chunk.length < MAX_BATCH && (chunk.length === 0 || bytes + entries[i].bytes <= MAX_BATCH_BYTES)) {
      const e = entries[i++];
      bytes += e.bytes;
      const env = e.file ? readSpooled(e.file) : e.envelope;
      if (env) chunk.push({ file: e.file, env });
    }
    if (chunk.length === 0) continue;
    const r = await send(chunk);
    if (!r.ok) return { sent, dropped, left: entries.length - i + chunk.length, error: r.error, status: r.status };
  }
  return { sent, dropped, left: 0, error: null, status: 202 };
}

/**
 * Deliver this hook's envelope: everything older in the spool goes first.
 * `own.file` is null when the spool could not be written (sent directly, last).
 * @param {NodeJS.ProcessEnv} env
 * @param {{ file: string | null, envelope: unknown }} own
 * @param {{ deadline: number, timeoutMs: number }} limits
 */
async function deliver(env, own, limits) {
  const { url, loopback } = resolveRuntimeUrl(env);
  if (!loopback) return recordError(env, `Refusing non-loopback runtime URL ${url}; events stay in the spool`);
  const tokenFile = resolveTokenFile(env);
  const token = readToken(tokenFile);
  if (!token) return recordError(env, `No ingest token at ${tokenFile}; start the Runloop runtime once to create it`);
  /** @type {Pending[]} */
  const entries = listSpool(spoolRoot(env));
  if (own.file === null) entries.push({ file: null, bytes: JSON.stringify(own.envelope).length, envelope: own.envelope });
  const r = await sendInOrder({ url, token, entries, ...limits });
  if (r.sent > 0 && r.error === null) recordOk(env, { sent: r.sent });
  if (r.error !== null) {
    const what = r.error === 'out of time' ? `Out of time after sending ${r.sent}` : `Runtime ${url} answered ${r.error}`;
    recordError(env, `${what}; ${r.left} event(s) stay in the spool`, { status: r.status, sent: r.sent });
  } else if (r.dropped > 0) {
    recordError(env, `Runtime ${url} rejected ${r.dropped} invalid event(s); dropped them`, { status: r.status });
  }
}

/**
 * One hook invocation. Never throws and never writes to stdout.
 * `startedAt` is the process start (wall clock): the time budget counts from it.
 * @param {string[]} argv
 * @param {{ stdin: string, env: NodeJS.ProcessEnv, ppid: number, now?: Date, startedAt?: number }} io
 */
export async function runHook(argv, io) {
  try {
    if (!tracingEnabled(io.env)) return;
    let input;
    try {
      input = JSON.parse(io.stdin);
    } catch {
      return recordError(io.env, 'Hook input was not JSON');
    }
    if (!isRecord(input) || typeof input.session_id !== 'string' || typeof input.hook_event_name !== 'string') {
      return recordError(io.env, 'Hook input has no session_id or hook_event_name');
    }
    const envelope = buildEnvelope(input, { env: io.env, ppid: io.ppid, ...(io.now ? { now: io.now } : {}) });
    /** @type {string | null} */
    let file = null;
    try {
      file = writeSpool(spoolRoot(io.env), envelope);
    } catch (err) {
      // Read-only or full disk: still try to deliver this event directly.
      recordError(io.env, `Could not write the spool (${err instanceof Error ? err.message : String(err)}); sending directly`);
    }
    const sync = argv.includes('--sync');
    const deadline = (io.startedAt ?? Date.now()) + (sync ? SYNC_BUDGET_MS : BUDGET_MS);
    await deliver(io.env, { file, envelope }, { deadline, timeoutMs: sync ? SYNC_POST_TIMEOUT_MS : POST_TIMEOUT_MS });
  } catch (err) {
    recordError(io.env, `Hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── doctor ─────────────────────────────────────────────────────────────

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Print a setup check and flush the spool when the runtime answers.
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} print
 */
export async function doctor(env, print) {
  const { url, from, loopback } = resolveRuntimeUrl(env);
  const tokenFile = resolveTokenFile(env);
  const token = readToken(tokenFile);
  print(`Runloop tracer ${PLUGIN.version} doctor`);
  print(`  Tracing:      ${tracingEnabled(env) ? 'on' : 'off (RUNLOOP_TRACE or the plugin option disables it)'}`);
  print(`  Prompt text:  ${promptsEnabled(env) ? 'recorded (marked sensitive)' : 'not recorded'}`);
  print(`  Runtime URL:  ${url} (from ${from})${loopback ? '' : ' — REFUSED: not a loopback address'}`);
  print(`  Token file:   ${tokenFile} (${token ? 'found' : 'missing: start the runtime once to create it'})`);
  const loose = token ? tokenFileProblem(tokenFile) : null;
  if (loose) print(`  WARNING:      the token file is ${loose}`);
  let reachable = false;
  if (loopback) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      /** @type {any} */
      const health = await res.json();
      reachable = res.ok;
      const ingest = health?.ingest?.claudeCode ? `Claude Code ingest protocol ${health.ingest.claudeCode.protocol}` : 'Claude Code ingest OFF (RUNLOOP_TRACE=off?)';
      print(`  Runtime:      reachable, version ${health?.version ?? '?'}, ${ingest}`);
    } catch (err) {
      print(`  Runtime:      not reachable (${err instanceof Error ? err.message : String(err)}). Start it with: pnpm serve`);
    }
  }
  let everAccepted = false;
  /** @type {Pending[]} */
  const waiting = [];
  for (const dir of doctorDataDirs(env)) {
    const spool = listSpool(spoolRoot({ ...env, CLAUDE_PLUGIN_DATA: dir }));
    const ok = readJson(path.join(dir, 'last-ok.json'));
    const error = readJson(path.join(dir, 'last-error.json'));
    everAccepted ||= Boolean(ok);
    print(`  Data dir:     ${dir}`);
    print(`    Spool:         ${spool.length} event(s), ${spool.reduce((n, e) => n + e.bytes, 0)} bytes`);
    print(`    Last accepted: ${ok?.at ?? 'never'}`);
    print(`    Last error:    ${error ? `${error.at} ${error.message}` : 'none'}`);
    waiting.push(...spool);
  }
  if (reachable && token && waiting.length > 0) {
    // Oldest first across every data dir, like the hooks.
    waiting.sort((a, b) => (path.basename(a.file ?? '') < path.basename(b.file ?? '') ? -1 : 1));
    const r = await sendInOrder({ url, token, entries: waiting, deadline: Date.now() + 60_000, timeoutMs: 5000 });
    print(`  Flushed:      ${r.sent} spooled event(s)${r.dropped ? `, dropped ${r.dropped} invalid` : ''}${r.error ? `; stopped: ${r.error} (${r.left} left)` : ''}`);
  }
  if (!everAccepted) {
    print('  Hint: no event was ever accepted. Check that `node` is on the PATH Claude Code sees, that the plugin is');
    print('        enabled (/plugin), and that managed settings do not set allowManagedHooksOnly (it blocks plugin hooks).');
  }
}

// ── entry point ────────────────────────────────────────────────────────

/** @param {NodeJS.ReadStream} stream */
async function readStdin(stream) {
  if (stream.isTTY) return '';
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_STDIN) throw new Error('Hook input over 64 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--doctor')) {
    await doctor(process.env, (line) => process.stdout.write(`${line}\n`));
    return;
  }
  // The budget counts from process start: Node's start-up already used part of it under load.
  const startedAt = Date.now() - process.uptime() * 1000;
  const budget = argv.includes('--sync') ? SYNC_BUDGET_MS : BUDGET_MS;
  // Bound the run even if something hangs; Claude Code must never wait on Runloop.
  setTimeout(() => process.exit(0), Math.max(100, startedAt + budget + 200 - Date.now())).unref();
  let stdin = '';
  try {
    stdin = await readStdin(process.stdin);
  } catch (err) {
    recordError(process.env, err instanceof Error ? err.message : String(err));
    return;
  }
  await runHook(argv, { stdin, env: process.env, ppid: process.ppid, startedAt });
}

/** True when this file is the process's entry point (also through a symlinked plugin dir). */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(String(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main().finally(() => process.exit(0));
