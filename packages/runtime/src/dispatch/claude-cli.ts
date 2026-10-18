/**
 * The `claude` CLI as dispatch uses it (plan §4.4): a flag probe, the exact
 * argv, the child's environment allowlist, and how the final stream-json
 * `result` maps to an outcome. Everything here is pure except probeClaude,
 * which runs `claude --version` and `claude --help`.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { DispatchOutcome } from '@runloop-world/events';

export const CLAUDE_BIN = 'claude';

/** Every flag a dispatch may pass. The probe refuses a CLI whose --help lacks one. */
export const REQUIRED_FLAGS = [
  '--print',
  '--session-id',
  '--permission-mode',
  '--allowedTools',
  '--model',
  '--max-budget-usd',
  '--output-format',
  '--verbose',
  '--plugin-dir',
] as const;

/** Choices the dispatch relies on, checked in the option's help text. */
export const REQUIRED_CHOICES: Readonly<Record<string, string>> = { '--permission-mode': 'dontAsk', '--output-format': 'stream-json' };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A line that starts an option ("  -p, --print   Print …"); its spec ends at the first wide gap. */
const OPTION_LINE = /^\s{1,4}-/;

/** The help text of one option: the line declaring it, up to the next option (descriptions that merely mention it don't count). */
function optionBlock(help: string, flag: string): string | null {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => {
    if (!OPTION_LINE.test(l)) return false;
    const spec = l.trim().split(/\s{2,}/)[0] ?? '';
    return spec.split(/[\s,]+/).some((t) => t === flag || t.startsWith(`${flag}=`));
  });
  if (start < 0) return null;
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length && !OPTION_LINE.test(lines[i]!); i++) out.push(lines[i]!);
  return out.join('\n');
}

/** Which required flags (or choices) `claude --help` does not list. */
export function checkHelp(help: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const flag of REQUIRED_FLAGS) if (optionBlock(help, flag) === null) missing.push(flag);
  for (const [flag, choice] of Object.entries(REQUIRED_CHOICES)) {
    const block = optionBlock(help, flag);
    if (block !== null && !new RegExp(`\\b${escapeRe(choice)}\\b`).test(block)) missing.push(`${flag} ${choice}`);
  }
  return { ok: missing.length === 0, missing };
}

/** The first executable `name` on `envPath` (or `name` itself when it is a path). */
export function findExecutable(name: string, envPath: string | undefined, platform: NodeJS.Platform = process.platform): string | null {
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const isExe = (p: string) => {
    try {
      if (!statSync(p).isFile()) return false;
      if (platform !== 'win32') accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (name.includes('/') || name.includes('\\')) return path.isAbsolute(name) && isExe(name) ? name : null;
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExe(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Whether Claude Code has Runloop's tracer plugin installed and enabled
 * (`claude plugin list --json`): then its hooks report every session and a
 * dispatch must not load it again; when it is absent, a dispatch loads this
 * checkout's copy with --plugin-dir. `unknown` when the CLI cannot say.
 */
export type TracerPlugin = 'installed' | 'absent' | 'unknown';

/** The tracer plugin's manifest name (integrations/claude-code-plugin/.claude-plugin/plugin.json). */
export const TRACER_PLUGIN_NAME = 'runloop-tracer';

export type ClaudeProbe =
  | { state: 'ok'; executable: string; version: string | null; reason: null; tracerPlugin: TracerPlugin }
  | { state: 'missing'; executable: string | null; version: string | null; reason: string };

/** Read `claude plugin list --json` output: is runloop-tracer installed, enabled and loaded? */
export function tracerPluginFrom(out: string, code: number | null): TracerPlugin {
  if (code !== 0) return 'unknown';
  const start = out.indexOf('[');
  if (start < 0) return 'unknown';
  let list: unknown;
  try {
    list = JSON.parse(out.slice(start, out.lastIndexOf(']') + 1));
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(list)) return 'unknown';
  const ours = list.filter((p): p is Record<string, unknown> => {
    if (!p || typeof p !== 'object') return false;
    const id = String((p as { id?: unknown }).id ?? '');
    return id === TRACER_PLUGIN_NAME || id.startsWith(`${TRACER_PLUGIN_NAME}@`);
  });
  const loaded = ours.some((p) => p.enabled === true && !(Array.isArray(p.errors) && p.errors.length > 0));
  return loaded ? 'installed' : 'absent';
}

/**
 * --plugin-dir for a dispatched session: never when the tracer is installed
 * (it would report twice), always when the CLI says it is absent, and when
 * the CLI cannot say, only for a workspace that never sent a hook.
 */
export function needsPluginDir(tracer: TracerPlugin, workspaceSentHook: boolean): boolean {
  if (tracer === 'installed') return false;
  if (tracer === 'absent') return true;
  return !workspaceSentHook;
}

function run(exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { env, shell: false, timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
        resolve({ out: `${stdout}\n${stderr}`, code });
      },
    );
  });
}

/**
 * Find `claude` on PATH and check that its --help lists every flag dispatch
 * passes. The probe runs with PATH and HOME only (no session variables).
 */
export async function probeClaude(opts: { bin?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ClaudeProbe> {
  const bin = opts.bin ?? CLAUDE_BIN;
  const exe = findExecutable(bin, opts.env.PATH);
  if (!exe) return { state: 'missing', executable: null, version: null, reason: `the claude CLI was not found on PATH` };
  const env: NodeJS.ProcessEnv = { PATH: opts.env.PATH ?? '', ...(opts.env.HOME ? { HOME: opts.env.HOME } : {}) };
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const [version, help, plugins] = await Promise.all([
    run(exe, ['--version'], env, timeoutMs),
    run(exe, ['--help'], env, timeoutMs),
    run(exe, ['plugin', 'list', '--json'], env, timeoutMs),
  ]);
  const v = version.code === 0 ? (version.out.trim().split('\n')[0]?.trim().slice(0, 80) ?? null) : null;
  if (help.code !== 0) return { state: 'missing', executable: exe, version: v, reason: 'claude --help failed' };
  const check = checkHelp(help.out);
  if (!check.ok) return { state: 'missing', executable: exe, version: v, reason: `claude ${v ?? ''} lacks ${check.missing.join(', ')}`.replace(/\s+/g, ' ') };
  return { state: 'ok', executable: exe, version: v, reason: null, tracerPlugin: tracerPluginFrom(plugins.out, plugins.code) };
}

/** Budget as passed to --max-budget-usd: cents, no exponent ("0.25", "1"). */
export function formatUsd(usd: number): string {
  return String(Math.round(usd * 100) / 100);
}

export interface ArgvInput {
  task: string;
  sessionId: string;
  allowedTools: readonly string[];
  model: string;
  maxBudgetUsd: number;
  /** Load the Runloop plugin for this session only (the workspace never sent a hook). */
  pluginDir: string | null;
}

/**
 * The exact argv (plan §4.4). The task is one element (no shell); each tool
 * is its own element after the variadic --allowedTools, ended by --model.
 */
export function buildArgv(i: ArgvInput): string[] {
  return [
    CLAUDE_BIN,
    '-p',
    i.task,
    '--session-id',
    i.sessionId,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    ...i.allowedTools,
    '--model',
    i.model,
    '--max-budget-usd',
    formatUsd(i.maxBudgetUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    ...(i.pluginDir ? ['--plugin-dir', i.pluginDir] : []),
  ];
}

/** Names an operator may add to the allowlist: plain env names (proxies are often lowercase), never a Claude Code session variable. */
export function isPassableEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !/^claude/i.test(key);
}

/**
 * The child's environment: PATH and HOME, ANTHROPIC_API_KEY when set (never
 * stored), what the Runloop plugin needs to reach this runtime (RUNLOOP_URL,
 * RUNLOOP_INGEST_TOKEN_FILE: a path, not the token) and any names the
 * operator listed in RUNLOOP_DISPATCH_ENV. Nothing else, so no
 * CLAUDE_CODE_SESSION_ID or other CLAUDE_* session variable of a parent
 * Claude Code reaches it.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  extra: { runtimeUrl: string | null; tokenFile: string | null; passEnv?: readonly string[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | null | undefined) => {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  };
  put('PATH', base.PATH);
  put('HOME', base.HOME);
  put('ANTHROPIC_API_KEY', base.ANTHROPIC_API_KEY);
  for (const k of extra.passEnv ?? []) if (isPassableEnvKey(k) && !(k in out)) put(k, base[k]);
  put('RUNLOOP_URL', extra.runtimeUrl);
  put('RUNLOOP_INGEST_TOKEN_FILE', extra.tokenFile);
  return out;
}

/** The final stream-json `result` line, as reported. */
export interface ClaudeResult {
  subtype: string | null;
  isError: boolean;
  costUsd: number | null;
  numTurns: number | null;
  text: string | null;
}

/** Parse one stdout line; null unless it is a `{"type":"result", …}` object. */
export function parseResultLine(line: string): ClaudeResult | null {
  if (!line.includes('"result"')) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || (v as { type?: unknown }).type !== 'result') return null;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  return {
    subtype: typeof r.subtype === 'string' ? r.subtype : null,
    isError: r.is_error === true,
    costUsd: num(r.total_cost_usd),
    numTurns: num(r.num_turns),
    text: typeof r.result === 'string' ? r.result : null,
  };
}

/**
 * How a dispatch ended. A success result with exit 0 is `completed` (shown as
 * "Claude Code reports done") even if a stop raced it; then a stop Runloop
 * asked for; then a budget stop Claude Code reported; anything else failed.
 */
export function outcomeOf(r: { result: ClaudeResult | null; exitCode: number | null; stop: 'cancel' | 'timeout' | null }): DispatchOutcome {
  if (r.result && !r.result.isError && r.result.subtype === 'success' && r.exitCode === 0) return 'completed';
  if (r.stop === 'cancel') return 'cancelled';
  if (r.stop === 'timeout') return 'timed_out';
  if (r.result?.subtype && /budget/i.test(r.result.subtype)) return 'budget_exceeded';
  return 'failed';
}
