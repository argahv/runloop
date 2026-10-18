/**
 * Turn Claude Code tool inputs and results into short, path-safe summaries,
 * categories and (when unambiguous) test counts. Pure functions.
 *
 * Nothing here invents a value: a count that is not in the output is left
 * out, and absolute paths never reach an event (they become relative to the
 * project, `~/…`, or `…/<last two segments>`).
 */
import type { TestMetrics, ToolCategory } from '@runloop-world/events';
import { formatTestSummary, parseTap } from '../../sandbox/tap';
import type { ToolResultSummary } from './hook-input';

export const INPUT_SUMMARY_MAX = 200;
export const OUTPUT_SUMMARY_MAX = 300;
export const MESSAGE_MAX = 2048;

// ── text helpers ───────────────────────────────────────────────────────

/** Collapse whitespace to one line and cap the length with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Cap a multi-line text (messages, prompts), keeping line breaks. */
export function clipText(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HOME_PREFIX = /^\/(?:home|Users)\/[^/]+(?:\/|$)|^\/root(?:\/|$)/;
/** An absolute POSIX path of two or more segments that is not part of a URL or a relative path. */
const ABS_PATH = /(?<![\w.~:/\\-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g;

/** Home paths become `~/…`; other paths of three or more segments `…/<last two>`; short ones (`/dev/null`) stay. */
function shortenAbsolute(p: string): string {
  if (HOME_PREFIX.test(p)) return p.replace(HOME_PREFIX, '~/').replace(/\/$/, '') || '~';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/** A file path for display: relative to the project when inside it. */
export function relPath(p: string, cwd: string | null): string {
  if (!p.startsWith('/')) return p;
  if (cwd && cwd !== '/') {
    if (p === cwd) return '.';
    if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  }
  return shortenAbsolute(p);
}

/** Remove absolute paths from free text (commands, errors, messages): paths inside the project become relative. */
export function sanitizeText(text: string, cwd: string | null): string {
  let out = text;
  if (cwd && cwd !== '/') out = out.replace(new RegExp(`${escapeRegExp(cwd.replace(/\/+$/, ''))}/`, 'g'), '');
  return out.replace(ABS_PATH, shortenAbsolute);
}

/**
 * Shell-specific secrets, on top of the shared patterns (@runloop-world/events
 * redact.ts): `NAME_KEY=value` assignments in any case, `--password value`
 * style flags, `… login -p value` and `sshpass -p value`, and a long value after a credential-like
 * word (`aws configure set aws_secret_access_key <value>`). Group 1 is kept.
 * Mirrored in the plugin (parity-tested).
 */
export const SHELL_SECRET_PATTERNS: readonly { re: RegExp; replace: string }[] = [
  { re: /(\b\w{0,60}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD)\w{0,60}=)(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/gi, replace: '$1[REDACTED]' },
  { re: /(--(?:password|passwd|token|secret|api-key|access-key|secret-key)(?:=|\s+))(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/gi, replace: '$1[REDACTED]' },
  { re: /(\b(?:login|sshpass)\b[^|;&\n]{0,200}?\s-p\s+)(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/g, replace: '$1[REDACTED]' },
  { re: /(\b[\w-]{0,60}(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key)[\w-]{0,60}\s+)(?![-[])[A-Za-z0-9/+=_.:-]{16,}/gi, replace: '$1[REDACTED]' },
];

export function redactShell(command: string): string {
  let out = command;
  for (const { re, replace } of SHELL_SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Values (8+ characters) the shell patterns would mask in `command`. */
export function shellSecretValues(command: string): string[] {
  const out: string[] = [];
  for (const { re } of SHELL_SECRET_PATTERNS) {
    for (const m of command.matchAll(re)) {
      const value = m[0].slice((m[1] ?? '').length).replace(/^["']|["']$/g, '');
      if (value.length >= 8 && !value.includes('[REDACTED]')) out.push(value);
    }
  }
  return out;
}

// ── categories ─────────────────────────────────────────────────────────

const TEST_COMMAND =
  /\b(?:vitest|jest|pytest|mocha|rspec|phpunit|ctest|go\s+test|cargo\s+test|deno\s+test|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test)\b|\bnode\b[^|;&\n]*\s--test\b/;
const DEPLOY_COMMAND =
  /\b(?:git\s+(?:push|tag)|gh\s+(?:pr|release)|docker\s+(?:build|push)|kubectl|terraform\s+apply|npm\s+publish|vercel|fly\s+deploy)\b/;

/** Shell commands: a test run, a deploy, or anything else. Test wins (`pnpm test && git push` is a test). */
export function classifyCommand(command: string): 'test' | 'deploy' | 'execute' {
  if (TEST_COMMAND.test(command)) return 'test';
  if (DEPLOY_COMMAND.test(command)) return 'deploy';
  return 'execute';
}

const str = (input: Record<string, unknown>, key: string): string | undefined =>
  typeof input[key] === 'string' ? (input[key] as string) : undefined;

export function toolCategory(tool: string, input: Record<string, unknown>): ToolCategory {
  switch (tool) {
    case 'Read':
      return 'read';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
    case 'PowerShell':
      return classifyCommand(str(input, 'command') ?? '');
    case 'Monitor':
      return 'execute';
    case 'Agent':
    case 'Task': // the Agent tool's name in older Claude Code versions
      return 'delegate';
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'plan';
    default:
      return tool.startsWith('mcp__') ? 'mcp' : 'other';
  }
}

export const isShellTool = (tool: string) => tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor';

// ── input summaries ────────────────────────────────────────────────────

const GENERIC_FIELDS = ['description', 'subject', 'title', 'name', 'query', 'path', 'file_path', 'url', 'command', 'prompt'];

/** `Read src/app.ts`, `Grep "useStore" in src/`, `Bash pnpm test`, `Agent → Explore: "find auth code"`. */
export function inputSummary(tool: string, input: Record<string, unknown>, cwd: string | null): string {
  const path = (key: string) => {
    const p = str(input, key);
    return p ? relPath(p, cwd) : '';
  };
  let text: string;
  switch (tool) {
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      text = path('file_path') + (offset !== undefined && limit !== undefined ? ` (lines ${offset}–${offset + limit})` : '');
      break;
    }
    case 'Write':
    case 'Edit':
      text = path('file_path');
      break;
    case 'NotebookEdit':
      text = path('notebook_path');
      break;
    case 'Grep':
    case 'Glob': {
      const pattern = str(input, 'pattern') ?? '';
      const where = path('path');
      const glob = str(input, 'glob');
      text = `${tool === 'Grep' ? `"${pattern}"` : pattern}${where ? ` in ${where}` : ''}${glob ? ` (${glob})` : ''}`;
      break;
    }
    case 'Bash':
    case 'PowerShell':
    case 'Monitor':
      text = redactShell(str(input, 'command') ?? '');
      break;
    case 'WebFetch':
      text = str(input, 'url') ?? '';
      break;
    case 'WebSearch':
      text = `"${str(input, 'query') ?? ''}"`;
      break;
    case 'Agent':
    case 'Task': {
      const type = str(input, 'subagent_type') ?? 'general-purpose';
      const description = str(input, 'description');
      text = `→ ${type}${description ? `: "${description}"` : ''}`;
      break;
    }
    default: {
      const key = GENERIC_FIELDS.find((k) => str(input, k));
      text = key ? str(input, key)! : '';
    }
  }
  return oneLine(sanitizeText(text, cwd), INPUT_SUMMARY_MAX);
}

// ── targets ────────────────────────────────────────────────────────────

export const TARGET_MAX = 300;

/** Leading `NAME=value` assignments (their values may be secrets) and wrappers that do not name the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'exec']);

/**
 * A shell command's head: its first word after env assignments and wrappers,
 * as a base name (`./node_modules/.bin/vitest run` → `vitest`). Never the
 * arguments, so no secret can reach it. Undefined when there is none.
 */
export function commandHead(command: string): string | undefined {
  for (const word of command.trim().split(/\s+/)) {
    if (word === '' || ENV_ASSIGNMENT.test(word) || WRAPPERS.has(word)) continue;
    const head = word.replace(/^["'(]+|["';|&)]+$/g, '').split('/').filter(Boolean).at(-1);
    return head && /^[\w.@+-]+$/.test(head) ? head.slice(0, 100) : undefined;
  }
  return undefined;
}

/**
 * What a call acts on (tool.call_started `target`), when the input names it:
 * the file for Read/Edit/Write/NotebookEdit, the directory for Grep/Glob, the
 * command head for shell tools. Paths are made project-relative like the
 * input summary. Undefined = not reported (no guessing from free text).
 */
export function toolTarget(tool: string, input: Record<string, unknown>, cwd: string | null): string | undefined {
  const path = (key: string) => {
    const p = str(input, key);
    return p ? oneLine(sanitizeText(relPath(p, cwd), cwd), TARGET_MAX) || undefined : undefined;
  };
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return path('file_path');
    case 'NotebookEdit':
      return path('notebook_path');
    case 'Grep':
    case 'Glob':
      return path('path');
    case 'Bash':
    case 'PowerShell':
    case 'Monitor': {
      const command = str(input, 'command');
      return command ? commandHead(command) : undefined;
    }
    default:
      return undefined;
  }
}

// ── test results ───────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const counts = (s: string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of s.matchAll(/(\d+)\s+([a-z]+)/g)) out.set(m[2]!, (out.get(m[2]!) ?? 0) + Number(m[1]));
  return out;
};

function vitestSummary(text: string): TestMetrics | undefined {
  const m = /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/m.exec(text);
  if (!m) return undefined;
  const c = counts(m[1]!);
  if (!c.has('passed') && !c.has('failed')) return undefined;
  return { tests: Number(m[2]), passed: c.get('passed') ?? 0, failed: c.get('failed') ?? 0 };
}

function jestSummary(text: string): TestMetrics | undefined {
  const m = /^\s*Tests:\s+(.+?)\s*$/m.exec(text);
  if (!m) return undefined;
  const c = counts(m[1]!);
  if (!c.has('total')) return undefined;
  return { tests: c.get('total')!, passed: c.get('passed') ?? 0, failed: c.get('failed') ?? 0 };
}

function pytestSummary(text: string): TestMetrics | undefined {
  const m = /^(?:=+ )?((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s\b/m.exec(text);
  if (!m) return undefined;
  const c = counts(m[1]!);
  // Errors and expected failures do not map onto passed/failed: leave the counts out.
  for (const k of ['error', 'errors', 'xfailed', 'xpassed']) if (c.has(k)) return undefined;
  if (!c.has('passed') && !c.has('failed')) return undefined;
  const passed = c.get('passed') ?? 0;
  const failed = c.get('failed') ?? 0;
  return { tests: passed + failed + (c.get('skipped') ?? 0), passed, failed };
}

const consistent = (m: TestMetrics) =>
  [m.tests, m.passed, m.failed].every((n) => Number.isInteger(n) && n >= 0) && m.passed + m.failed <= m.tests;

/**
 * Test counts from a runner's output (TAP / node:test, vitest, jest, pytest).
 * Returns metrics only when exactly one reading is found; otherwise none.
 */
export function parseTestOutput(output: string): { metrics?: TestMetrics; failingTests: string[] } {
  const text = output.replace(ANSI, '');
  const tap = parseTap(text);
  const found = [tap.metrics, vitestSummary(text), jestSummary(text), pytestSummary(text)].filter(
    (m): m is TestMetrics => m !== undefined && consistent(m),
  );
  const distinct = new Map(found.map((m) => [`${m.tests}/${m.passed}/${m.failed}`, m]));
  if (distinct.size !== 1) return { failingTests: [] };
  const metrics = [...distinct.values()][0]!;
  const failingTests = tap.metrics ? tap.failingTests.slice(0, 20).map((n) => oneLine(n, 200)) : [];
  return { metrics, failingTests };
}

// ── result summaries ───────────────────────────────────────────────────

const fmtInt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

function field(r: ToolResultSummary | undefined, key: string): number | undefined {
  const v = r?.fields?.[key];
  return typeof v === 'number' ? v : undefined;
}

function fieldStr(r: ToolResultSummary | undefined, key: string): string | undefined {
  const v = r?.fields?.[key];
  return typeof v === 'string' ? v : undefined;
}

const numberOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** outputSummary of a call that completed (PostToolUse). */
export function successSummary(tool: string, result: ToolResultSummary | undefined, metrics: TestMetrics | undefined): string {
  if (metrics) return formatTestSummary(metrics);
  if (!result) return 'Completed (no result details reported)';
  switch (tool) {
    case 'Read': {
      const n = numberOf(result.file?.numLines);
      const total = numberOf(result.file?.totalLines);
      if (n !== undefined) return `Read ${plural(n, 'line')}${total !== undefined && total > n ? ` of ${fmtInt(total)}` : ''}`;
      break;
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const a = numberOf(result.linesAdded);
      const r = numberOf(result.linesRemoved);
      if (a !== undefined && r !== undefined && a + r > 0) return `+${fmtInt(a)} −${fmtInt(r)} lines`;
      const type = fieldStr(result, 'type');
      if (type === 'create') return 'Created the file';
      break;
    }
    case 'Bash':
    case 'PowerShell':
    case 'Monitor': {
      const n = numberOf(result.stdoutLines);
      if (n !== undefined) return n === 0 ? 'Completed with no output' : `Completed · ${plural(n, 'line')} of output`;
      break;
    }
    case 'Agent':
    case 'Task': {
      const type = fieldStr(result, 'agentType') ?? 'Subagent';
      const parts = [`${type} finished`];
      const calls = field(result, 'totalToolUseCount');
      const tokens = field(result, 'totalTokens');
      if (calls !== undefined) parts.push(plural(calls, 'tool call'));
      if (tokens !== undefined) parts.push(`${fmtInt(tokens)} tokens reported`);
      const status = fieldStr(result, 'status');
      if (status && status !== 'completed') parts.push(status);
      return parts.join(' · ');
    }
    case 'Grep':
    case 'Glob': {
      const files = field(result, 'numFiles');
      if (files !== undefined) return `${plural(files, 'file')} found`;
      break;
    }
    case 'WebFetch': {
      const code = field(result, 'code');
      const bytes = field(result, 'bytes');
      if (code !== undefined) return `HTTP ${code}${bytes !== undefined ? ` · ${plural(bytes, 'byte')}` : ''}`;
      break;
    }
    default:
      break;
  }
  return 'Completed';
}

/** `Exit code N` + the output after it, from a PostToolUseFailure error. */
export function splitExitCode(error: string): { exitCode?: number; output: string } {
  const m = /^Exit code (\d+)(?:\r?\n|$)/.exec(error);
  return m ? { exitCode: Number(m[1]), output: error.slice(m[0].length) } : { output: error };
}

/** outputSummary of a call that ran and failed (PostToolUseFailure). */
export function failureSummary(error: string, exitCode: number | undefined, metrics: TestMetrics | undefined, cwd: string | null): string {
  const output = exitCode === undefined ? error : splitExitCode(error).output;
  if (exitCode !== undefined) {
    if (metrics) return `Exit code ${exitCode} · ${formatTestSummary(metrics)}`;
    const first = output.split('\n').find((l) => l.trim() !== '');
    return oneLine(`Exit code ${exitCode}${first ? `: ${sanitizeText(first, cwd)}` : ''}`, OUTPUT_SUMMARY_MAX);
  }
  return oneLine(sanitizeText(error, cwd), OUTPUT_SUMMARY_MAX) || 'The tool reported an error';
}
