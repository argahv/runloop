/**
 * Claude Code hook input: the slimming applied to every hook payload, field
 * access, and the semantic keys used to dedupe deliveries. (The envelope
 * schema is ClaudeCodeHookEnvelopeSchema in @runloop-world/events.)
 *
 * Hook payloads are loose on purpose: only `session_id` and
 * `hook_event_name` are required, unknown keys pass, and fields are read
 * defensively (Claude Code adds fields between versions).
 *
 * `slimHook` is mirrored in integrations/claude-code-plugin/scripts/runloop-hook.mjs
 * (the plugin cannot import this package); a parity test keeps them equal. It is
 * idempotent, so the runtime applies it again to whatever arrives.
 */
import { redactText, secretValuesIn, type ValidClaudeCodeHookEnvelope } from '@runloop-world/events';
import { isShellTool, redactShell, shellSecretValues } from './summarize';

/** A validated envelope (the hook is loose: unknown keys pass). */
export type HookEnvelope = ValidClaudeCodeHookEnvelope;

// ── slimming ───────────────────────────────────────────────────────────

/** Longest string sent; longer ones keep their head and tail (test summaries are at the end). */
export const MAX_STRING = 4096;
const HEAD = 1000;
const TAIL = 3000;
/** Kept from the end of stdout/stderr, enough for a test runner's summary. */
const OUTPUT_TAIL = 2000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 200;
/** Extra characters around each kept part that are redacted before cutting (a secret across a cut is still seen whole). */
const MARGIN = 4096;
/** Absolute paths of Claude Code's own files; never needed, never sent. */
const DROP_KEYS = new Set(['transcript_path', 'agent_transcript_path', 'scratchpad_dir', 'tool_response']);
/** Short string fields of a tool response worth keeping (Agent results, Write type, ...). */
const SHORT_STRING_FIELDS = new Set(['status', 'agentId', 'agentType', 'resolvedModel', 'type', 'mode']);
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** What is kept of a tool_response: sizes, counts and the end of command output. */
export interface ToolResultSummary {
  bytes: number;
  lines?: number;
  /** Top-level numbers, booleans and a few short strings of the response. */
  fields?: Record<string, number | boolean | string>;
  /** Agent tool: token usage as reported. */
  usage?: Record<string, number>;
  stdoutTail?: string;
  stdoutLines?: number;
  stderrTail?: string;
  stderrLines?: number;
  /** Read tool: line counts of the file read. */
  file?: Record<string, number>;
  /** Edit / Write: line counts of the patch. */
  linesAdded?: number;
  linesRemoved?: number;
}

type Redact = (s: string) => string;
const keep: Redact = (s) => s;

/** Keep the head and tail of a long string. `redact` runs on each kept part (plus a margin) before it is cut. */
export function capString(s: string, redact: Redact = keep): string {
  if (s.length <= MAX_STRING) return redact(s);
  const head = redact(s.slice(0, HEAD + MARGIN)).slice(0, HEAD);
  const tail = redact(s.slice(-(TAIL + MARGIN))).slice(-TAIL);
  return `${head}\n…[${s.length - HEAD - TAIL} characters omitted]…\n${tail}`;
}

function capValue(v: unknown, depth: number, redact: Redact): unknown {
  if (typeof v === 'string') return capString(v, redact);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => capValue(x, depth + 1, redact));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (x !== undefined) out[k] = capValue(x, depth + 1, redact);
    }
    return out;
  }
  return null;
}

export function countLines(s: string): number {
  if (s === '') return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

const tail = (s: string, n: number, redact: Redact) => (s.length <= n ? redact(s) : redact(s.slice(-(n + MARGIN))).slice(-n));
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Reduce a tool_response to the facts the mapper uses (no file contents, no diffs). */
export function summarizeToolResponse(resp: unknown, redact: Redact = keep): ToolResultSummary {
  const text = typeof resp === 'string' ? resp : (JSON.stringify(resp) ?? '');
  const out: ToolResultSummary = { bytes: Buffer.byteLength(text, 'utf8') };
  if (typeof resp === 'string') {
    out.lines = countLines(resp);
    return out;
  }
  if (!isRecord(resp)) return out;
  const fields: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(resp)) {
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') fields[k] = v;
    else if (typeof v === 'string' && SHORT_STRING_FIELDS.has(k) && v.length <= 200) fields[k] = v;
  }
  if (Object.keys(fields).length > 0) out.fields = fields;
  if (isRecord(resp.usage)) {
    const usage: Record<string, number> = {};
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
    const file: Record<string, number> = {};
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

/** PostToolBatch: only which calls the batch held (their inputs and results are not needed). */
function slimToolCalls(calls: unknown[]): Record<string, unknown>[] {
  return calls.slice(0, MAX_ITEMS).flatMap((c) => {
    if (!isRecord(c)) return [];
    const out: Record<string, unknown> = {};
    for (const k of ['tool_name', 'tool_use_id']) if (typeof c[k] === 'string') out[k] = (c[k] as string).slice(0, 200);
    return [out];
  });
}

/**
 * The hook payload as sent: Claude Code's own file paths dropped, the tool
 * response replaced by a summary (`tool_result`), long strings capped (after
 * `redact` has seen them whole). Idempotent: slimHook(slimHook(h)) deep-equals slimHook(h).
 */
export function slimHook(hook: Record<string, unknown>, redact: Redact = keep): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hook)) {
    if (DROP_KEYS.has(k) || v === undefined) continue;
    out[k] = k === 'tool_calls' && Array.isArray(v) ? capValue(slimToolCalls(v), 0, redact) : capValue(v, 0, redact);
  }
  if ('tool_response' in hook) out.tool_result = capValue(summarizeToolResponse(hook.tool_response, redact), 0, redact);
  return out;
}

// ── redaction ──────────────────────────────────────────────────────────

function shellCommand(hook: Record<string, unknown>): string | undefined {
  const input = hook.tool_input;
  return isShellTool(String(hook.tool_name)) && isRecord(input) && typeof input.command === 'string' ? input.command : undefined;
}

/** The parts of a string that are kept after capping (with the margin), the only parts worth scanning. */
function scanParts(s: string): string[] {
  return s.length <= MAX_STRING + 2 * MARGIN ? [s] : [s.slice(0, HEAD + MARGIN), s.slice(-(TAIL + MARGIN))];
}

/**
 * Literal secrets for one hook: the given ones (e.g. from the environment) plus
 * every value a pattern finds anywhere in the hook, so a password from a
 * command is also masked where the command's output repeats it. Longest first.
 */
export function hookSecrets(hook: Record<string, unknown>, given: readonly string[] = []): string[] {
  const found = new Set(given.filter((s) => s.length >= 8));
  const visit = (v: unknown, depth: number): void => {
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
 * Redact, then slim (mirrored by the plugin's buildEnvelope): shell commands
 * get the shell patterns, every string the shared patterns and the hook's
 * literal secrets, before anything is cut. Idempotent.
 */
export function redactHook(hook: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  const literal = hookSecrets(hook, secrets);
  const command = shellCommand(hook);
  const input = command === undefined ? hook : { ...hook, tool_input: { ...(hook.tool_input as Record<string, unknown>), command: redactShell(command) } };
  return slimHook(input, (s) => redactText(s, { secrets: literal }));
}

// ── field access ───────────────────────────────────────────────────────

export function str(h: Record<string, unknown>, key: string): string | undefined {
  const v = h[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(h: Record<string, unknown>, key: string): number | undefined {
  const v = h[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function rec(h: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = h[key];
  return isRecord(v) ? v : undefined;
}

export function toolResult(h: Record<string, unknown>): ToolResultSummary | undefined {
  const v = h.tool_result;
  return isRecord(v) && typeof v.bytes === 'number' ? (v as unknown as ToolResultSummary) : undefined;
}

/**
 * Dedupe key for a delivery: semantic where Claude Code gives an id (so a
 * retried or double-sent event is recognised), else the delivery id.
 */
export function ingestKey(hook: Record<string, unknown>, deliveryId: string): string {
  const id = (k: string) => {
    const v = str(hook, k);
    return v ? v.slice(0, 200) : undefined;
  };
  const toolUseId = id('tool_use_id');
  switch (str(hook, 'hook_event_name')) {
    case 'PreToolUse':
      if (toolUseId) return `pre:${toolUseId}`;
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (toolUseId) return `post:${toolUseId}`;
      break;
    case 'PermissionDenied':
      if (toolUseId) return `denied:${toolUseId}`;
      break;
    case 'UserPromptSubmit': {
      const promptId = id('prompt_id');
      if (promptId) return `prompt:${promptId}`;
      break;
    }
    case 'SubagentStart':
    case 'SubagentStop': {
      const agentId = id('agent_id');
      if (agentId) return `${str(hook, 'hook_event_name') === 'SubagentStart' ? 'sa-start' : 'sa-stop'}:${agentId}`;
      break;
    }
    default:
      break;
  }
  return `delivery:${deliveryId}`;
}
