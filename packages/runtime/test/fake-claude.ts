/**
 * A fake `claude` executable for the dispatch tests (plan §8 S4). It answers
 * --version and --help (optionally without a flag), and for a run it:
 * - logs its argv, cwd, environment variable names and pid to <logDir>/<session-id>.json;
 * - prints stream-json (an init line carrying its cwd, a result line);
 * - replays a recorded fixture through the REAL plugin hook script, as Claude
 *   Code would (the --plugin-dir one, else the checkout's plugin as if installed);
 * - behaves as the task text says: `[fake:exit]` (default), `[fake:hang]`,
 *   `[fake:ignore-term]` (it and its child ignore SIGTERM), `[fake:budget]`,
 *   `[fake:fail]`, `[fake:flood]` (more than the 1 MiB output cap).
 * Hanging modes start a child in their process group and log both pids to
 * <logDir>/<session-id>.pids.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '../src/config';

/** Not from ./helpers, so scripts outside vitest can make a fake too. */
const REPO_ROOT = findRepoRoot();

export const FAKE_VERSION = '9.9.9 (Claude Code, fake)';

/** Help text in the installed CLI's layout, listing exactly what dispatch needs. */
export function fakeHelp(omit: readonly string[] = []): string {
  const lines = [
    'Usage: claude [options] [command] [prompt]',
    '',
    'Options:',
    '  --allowedTools, --allowed-tools <tools...>',
    '      Comma or space-separated list of tool names to allow',
    '  --include-hook-events                 Include hook events (only works with --output-format=stream-json and --print)',
    '  --max-budget-usd <amount>             Maximum dollar amount to spend on API calls (only works with --print)',
    '  --model <model>                       Model for the current session',
    '  --output-format <format>              Output format (only works with --print): "text" (default), "json" (single',
    '                                        result), or "stream-json" (realtime streaming) (choices: "text", "json",',
    '                                        "stream-json")',
    '  --permission-mode <mode>              Permission mode to use for the session',
    '                                        (choices: "acceptEdits", "auto", "bypassPermissions", "manual",',
    '                                        "dontAsk", "plan")',
    '  --plugin-dir <path>                   Load a plugin from a directory for this session only',
    '  -p, --print                           Print response and exit (useful for pipes)',
    '  --session-id <uuid>                   Use a specific session ID for the conversation',
    '  --verbose                             Override verbose mode setting from config',
  ];
  return lines.filter((l) => !omit.some((f) => l.trimStart().startsWith(f) || l.includes(`, ${f}`))).join('\n');
}

/** What `claude plugin list --json` answers: the tracer installed, absent, or the command failing (an older CLI). */
export type FakePluginList = 'installed' | 'absent' | 'fail';

const SCRIPT = (o: { logDir: string; help: string; installedPlugin: string; fixtureDir: string; pluginList: FakePluginList }) => `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const LOG_DIR = ${JSON.stringify(o.logDir)};
const HELP = ${JSON.stringify(o.help)};
const INSTALLED_PLUGIN = ${JSON.stringify(o.installedPlugin)};
const FIXTURE_DIR = ${JSON.stringify(o.fixtureDir)};
const FIXTURE_CWD = '/home/dev/demo';
const SYNC = new Set(['Stop', 'StopFailure', 'SessionEnd']);

const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(${JSON.stringify(FAKE_VERSION)} + '\\n'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write(HELP + '\\n'); process.exit(0); }
if (args[0] === 'plugin') {
  const mode = ${JSON.stringify(o.pluginList)};
  if (mode === 'fail' || args[1] !== 'list') { process.stderr.write('error: unknown command plugin\\n'); process.exit(1); }
  const other = { id: 'humanizer@synced', version: '1.0.0', scope: 'user', enabled: true, installPath: '/x' };
  const ours = { id: 'runloop-tracer@local', version: '0.1.0', scope: 'user', enabled: true, installPath: INSTALLED_PLUGIN };
  process.stdout.write(JSON.stringify(mode === 'installed' ? [other, ours] : [other]) + '\\n');
  process.exit(0);
}

const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const sessionId = get('--session-id');
const task = get('-p') || '';
const mode = (/\\[fake:([a-z-]+)\\]/.exec(task) || [])[1] || 'exit';
const pluginDir = get('--plugin-dir') ? path.resolve(get('--plugin-dir')) : INSTALLED_PLUGIN;
fs.writeFileSync(path.join(LOG_DIR, sessionId + '.json'), JSON.stringify({ argv: args, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), pid: process.pid }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

function hook(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(pluginDir, 'scripts', 'runloop-hook.mjs'), ...(SYNC.has(input.hook_event_name) ? ['--sync'] : [])], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir, CLAUDE_PLUGIN_DATA: path.join(LOG_DIR, 'plugin-data') },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('close', resolve);
    child.on('error', resolve);
    child.stdin.end(JSON.stringify(input));
  });
}

/** Replay a fixture as this session, in this folder; stop after the first hook named \`stopAfter\`. */
async function replay(name, stopAfter) {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, name + '.jsonl'), 'utf8').split('\\n').filter((l) => l.trim());
  for (const l of lines) {
    const input = JSON.parse(JSON.stringify(JSON.parse(l).input).split(FIXTURE_CWD).join(process.cwd()));
    input.session_id = sessionId;
    await hook(input);
    if (stopAfter && input.hook_event_name === stopAfter) return;
  }
}

function hangWithChild(ignoreTerm) {
  if (ignoreTerm) process.on('SIGTERM', () => out({ type: 'system', subtype: 'note', text: 'ignoring SIGTERM' }));
  const code = (ignoreTerm ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  fs.writeFileSync(path.join(LOG_DIR, sessionId + '.pids'), JSON.stringify({ parent: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
}

(async () => {
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: get('--model') });
  if (mode === 'hang' || mode === 'ignore-term') {
    await replay('s1-basic', 'PreToolUse');
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working in ' + process.cwd() }] } });
    return hangWithChild(mode === 'ignore-term');
  }
  if (mode === 'budget') {
    out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.05, num_turns: 3 });
    process.exit(1);
  }
  if (mode === 'fail') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.002, num_turns: 1 });
    process.stderr.write('something went wrong\\n');
    process.exit(1);
  }
  if (mode === 'flood') {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } }) + '\\n';
    for (let i = 0; i < 320; i++) process.stdout.write(line);
  } else {
    await replay('s1-basic');
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Read the files in ' + process.cwd() + '/src' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, num_turns: 2, result: 'Done. Looked at ' + process.cwd() + '/src' });
  process.stdout.write('', () => process.exit(0));
})();
`;

export interface FakeClaude {
  binDir: string;
  logDir: string;
  /** What the fake logged for a session (null = it never ran for it). */
  log(sessionId: string): { argv: string[]; cwd: string; envKeys: string[]; pid: number } | null;
  pids(sessionId: string): { parent: number; child: number } | null;
  /** How many sessions it ran. */
  runs(): number;
}

export function makeFakeClaude(root: string, opts: { omitFlags?: readonly string[]; pluginList?: FakePluginList } = {}): FakeClaude {
  const binDir = path.join(root, 'bin');
  const logDir = path.join(root, 'log');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(logDir, 'plugin-data'), { recursive: true });
  const file = path.join(binDir, 'claude');
  writeFileSync(
    file,
    SCRIPT({
      logDir,
      help: fakeHelp(opts.omitFlags),
      installedPlugin: path.join(REPO_ROOT, 'integrations', 'claude-code-plugin'),
      fixtureDir: path.join(REPO_ROOT, 'packages', 'runtime', 'test', 'fixtures', 'claude-code'),
      pluginList: opts.pluginList ?? 'fail',
    }),
  );
  chmodSync(file, 0o755);
  const read = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null);
  return {
    binDir,
    logDir,
    log: (id) => read(path.join(logDir, `${id}.json`)),
    pids: (id) => read(path.join(logDir, `${id}.pids`)),
    runs: () => readdirSync(logDir).filter((f) => f.endsWith('.json')).length,
  };
}
