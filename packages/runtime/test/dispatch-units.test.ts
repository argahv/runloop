/** Dispatch v1 pure parts (plan §4.4): flag probe, exact argv, env allowlist, result → outcome, policy, approval digest. */
import { execFileSync } from 'node:child_process';
import { DISPATCH_PRESETS } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import {
  buildArgv,
  checkHelp,
  childEnv,
  findExecutable,
  formatUsd,
  isPassableEnvKey,
  needsPluginDir,
  outcomeOf,
  parseResultLine,
  REQUIRED_FLAGS,
  tracerPluginFrom,
  type ClaudeResult,
} from '../src/dispatch/claude-cli';
import { approvalDigest } from '../src/dispatch/dispatch-manager';
import { DEFAULT_DISPATCH_POLICY, normalizePolicy, resolveRequest } from '../src/dispatch/policy';
import { fakeHelp } from './fake-claude';

const SESSION = '0b9f3c1e-5d2a-4c7b-9e8f-1a2b3c4d5e6f';

describe('claude CLI flag probe', () => {
  it('accepts help that lists every flag and choice dispatch uses', () => {
    expect(checkHelp(fakeHelp())).toEqual({ ok: true, missing: [] });
  });

  it('names each missing flag', () => {
    expect(checkHelp(fakeHelp(['--max-budget-usd'])).missing).toEqual(['--max-budget-usd']);
    expect(checkHelp(fakeHelp(['--allowedTools', '--plugin-dir'])).missing).toEqual(['--allowedTools', '--plugin-dir']);
  });

  it('needs dontAsk and stream-json among the choices, not just mentioned elsewhere', () => {
    const noDontAsk = fakeHelp().replace('"dontAsk", ', '');
    expect(checkHelp(noDontAsk).missing).toEqual(['--permission-mode dontAsk']);
    // "--output-format=stream-json" in another option's description does not count as the option.
    const noOutputFormat = fakeHelp(['--output-format']).replace(/^\s+result\), or.*$/m, '').replace(/^\s+"stream-json"\)$/m, '');
    expect(checkHelp(noOutputFormat).missing).toContain('--output-format');
  });

  it('passes the installed CLI when there is one', () => {
    const exe = findExecutable('claude', process.env.PATH);
    if (!exe) return; // not installed here: the fake-binary tests cover the rest
    const help = execFileSync(exe, ['--help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    expect(checkHelp(help)).toEqual({ ok: true, missing: [] });
  });

  it('lists the flags of the plan', () => {
    expect([...REQUIRED_FLAGS]).toEqual(['--print', '--session-id', '--permission-mode', '--allowedTools', '--model', '--max-budget-usd', '--output-format', '--verbose', '--plugin-dir']);
  });
});

describe('tracer plugin probe (claude plugin list --json)', () => {
  const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, version: '0.1.0', scope: 'user', enabled: true, installPath: '/p', ...over });
  it('reads installed, absent or unknown', () => {
    expect(tracerPluginFrom(JSON.stringify([entry('humanizer@synced'), entry('runloop-tracer@local')]), 0)).toBe('installed');
    expect(tracerPluginFrom(`Warning: something\n${JSON.stringify([entry('runloop-tracer')])}`, 0)).toBe('installed');
    expect(tracerPluginFrom(JSON.stringify([entry('humanizer@synced')]), 0)).toBe('absent');
    expect(tracerPluginFrom(JSON.stringify([entry('runloop-tracer@local', { enabled: false })]), 0)).toBe('absent');
    expect(tracerPluginFrom(JSON.stringify([entry('runloop-tracer@x', { errors: ['Not loaded'] })]), 0)).toBe('absent');
    expect(tracerPluginFrom(JSON.stringify([entry('runloop-tracer-fork@x')]), 0)).toBe('absent');
    expect(tracerPluginFrom('error: unknown command', 1)).toBe('unknown');
    expect(tracerPluginFrom('not json', 0)).toBe('unknown');
  });

  it('passes --plugin-dir unless the tracer is installed; when unknown, only to a workspace that never sent a hook', () => {
    expect(needsPluginDir('installed', false)).toBe(false);
    expect(needsPluginDir('installed', true)).toBe(false);
    expect(needsPluginDir('absent', true)).toBe(true);
    expect(needsPluginDir('absent', false)).toBe(true);
    expect(needsPluginDir('unknown', false)).toBe(true);
    expect(needsPluginDir('unknown', true)).toBe(false);
  });
});

describe('argv', () => {
  it('is exactly the plan’s command line, task as one element', () => {
    const argv = buildArgv({
      task: 'Summarise README.md; then `rm -rf /`?',
      sessionId: SESSION,
      allowedTools: DISPATCH_PRESETS.read_only,
      model: 'haiku',
      maxBudgetUsd: 0.25,
      pluginDir: null,
    });
    expect(argv).toEqual([
      'claude',
      '-p',
      'Summarise README.md; then `rm -rf /`?',
      '--session-id',
      SESSION,
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--model',
      'haiku',
      '--max-budget-usd',
      '0.25',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('adds --plugin-dir last, and keeps each tool spec whole', () => {
    const argv = buildArgv({ task: 't', sessionId: SESSION, allowedTools: DISPATCH_PRESETS.edit_test, model: 'sonnet', maxBudgetUsd: 1, pluginDir: '/opt/runloop/plugin' });
    expect(argv.slice(-2)).toEqual(['--plugin-dir', '/opt/runloop/plugin']);
    expect(argv).toContain('Bash(pnpm test:*)');
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('1');
  });

  it('formats budgets in cents without exponents', () => {
    expect([0.25, 1, 0.05, 0.1 + 0.2, 0.999].map(formatUsd)).toEqual(['0.25', '1', '0.05', '0.3', '1']);
  });
});

describe('child environment', () => {
  const apiKey = 'test-' + 'anthropic-' + 'placeholder';
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    ANTHROPIC_API_KEY: apiKey,
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDECODE: '1',
    NODE_OPTIONS: '--require /evil.js',
    GITHUB_TOKEN: 'not-' + 'passed',
    HTTPS_PROXY: 'http://proxy:3128',
  };

  it('is an allowlist: PATH, HOME, the API key when set, and what the plugin needs', () => {
    const env = childEnv(base, { runtimeUrl: 'http://127.0.0.1:4505', tokenFile: '/home/u/.config/runloop/ingest-token' });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'PATH', 'RUNLOOP_INGEST_TOKEN_FILE', 'RUNLOOP_URL']);
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it('leaves out what is unset, and never passes a Claude Code session variable', () => {
    const env = childEnv({ PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'x' }, { runtimeUrl: null, tokenFile: null, passEnv: ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'HTTPS_PROXY'] });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('passes operator-listed names, if they are plain names', () => {
    const env = childEnv(base, { runtimeUrl: null, tokenFile: null, passEnv: ['HTTPS_PROXY', 'bad name', 'CLAUDE_CODE_ENTRYPOINT'] });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'HTTPS_PROXY', 'PATH']);
    expect(isPassableEnvKey('CLAUDECODE')).toBe(false);
    expect(isPassableEnvKey('claude_code_session_id')).toBe(false);
    expect(isPassableEnvKey('NO_PROXY')).toBe(true);
    expect(isPassableEnvKey('https_proxy')).toBe(true);
    expect(isPassableEnvKey('A=B')).toBe(false);
  });
});

describe('result and outcome', () => {
  const ok: ClaudeResult = { subtype: 'success', isError: false, costUsd: 0.01, numTurns: 2, text: 'done' };

  it('parses only the final result line, as reported', () => {
    expect(parseResultLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, num_turns: 2, result: 'Done' }))).toEqual({
      subtype: 'success',
      isError: false,
      costUsd: 0.0123,
      numTurns: 2,
      text: 'Done',
    });
    expect(parseResultLine(JSON.stringify({ type: 'assistant', message: { content: 'the "result" is' } }))).toBeNull();
    expect(parseResultLine('{"type":"result", broken')).toBeNull();
    expect(parseResultLine(JSON.stringify({ type: 'result', total_cost_usd: -1 }))?.costUsd).toBeNull();
  });

  it.each([
    [{ result: ok, exitCode: 0, stop: null }, 'completed'],
    [{ result: ok, exitCode: 0, stop: 'cancel' }, 'completed'],
    [{ result: null, exitCode: null, stop: 'cancel' }, 'cancelled'],
    [{ result: null, exitCode: null, stop: 'timeout' }, 'timed_out'],
    [{ result: { ...ok, subtype: 'error_max_budget_usd', isError: true }, exitCode: 1, stop: null }, 'budget_exceeded'],
    [{ result: { ...ok, isError: true, subtype: 'error_during_execution' }, exitCode: 1, stop: null }, 'failed'],
    [{ result: ok, exitCode: 3, stop: null }, 'failed'],
    [{ result: null, exitCode: 0, stop: null }, 'failed'],
  ] as const)('%o → %s', (input, outcome) => {
    expect(outcomeOf(input)).toBe(outcome);
  });
});

describe('policy', () => {
  it('defaults: haiku, $0.25 capped at $1, 10 minutes, both presets, enabled', () => {
    expect(DEFAULT_DISPATCH_POLICY).toMatchObject({ enabled: true, defaultBudgetUsd: 0.25, maxBudgetUsd: 1, defaultTimeoutMin: 10, presets: ['read_only', 'edit_test'] });
    expect(DEFAULT_DISPATCH_POLICY.models[0]).toBe('haiku');
    const r = resolveRequest(DEFAULT_DISPATCH_POLICY, { task: 'x', preset: 'read_only' });
    expect(r).toEqual({ ok: true, preset: 'read_only', allowedTools: ['Read', 'Grep', 'Glob'], model: 'haiku', maxBudgetUsd: 0.25, timeoutMin: 10 });
  });

  it('refuses what the policy does not allow', () => {
    const p = normalizePolicy({ ...DEFAULT_DISPATCH_POLICY, maxBudgetUsd: 0.5, models: ['haiku'], presets: ['read_only'], maxTimeoutMin: 15 });
    expect(resolveRequest(p, { task: 'x', preset: 'read_only', maxBudgetUsd: 0.75 })).toMatchObject({ ok: false, status: 400, code: 'budget_over_cap' });
    expect(resolveRequest(p, { task: 'x', preset: 'read_only', model: 'opus' })).toMatchObject({ ok: false, code: 'model_not_allowed' });
    expect(resolveRequest(p, { task: 'x', preset: 'edit_test' })).toMatchObject({ ok: false, status: 403, code: 'preset_not_allowed' });
    expect(resolveRequest(p, { task: 'x', preset: 'read_only', timeoutMin: 20 })).toMatchObject({ ok: false, code: 'timeout_over_cap' });
    expect(resolveRequest({ ...p, enabled: false }, { task: 'x', preset: 'read_only' })).toMatchObject({ ok: false, status: 403, code: 'blocked_by_policy' });
  });

  it('a stored policy can never exceed the hard caps', () => {
    const p = normalizePolicy({ maxBudgetUsd: 50, maxTimeoutMin: 600, defaultBudgetUsd: 10, models: ['haiku', 'Robert"); DROP'], presets: ['yolo'] });
    expect(p.maxBudgetUsd).toBe(1);
    expect(p.maxTimeoutMin).toBe(30);
    expect(p.defaultBudgetUsd).toBe(0.25);
    expect(p.models).toEqual(['haiku']);
    expect(p.presets).toEqual(['read_only', 'edit_test']);
    expect(normalizePolicy('nonsense')).toEqual(DEFAULT_DISPATCH_POLICY);
  });
});

describe('approval digest', () => {
  it('binds executable, argv, cwd and env keys (in any order)', () => {
    const argv = ['claude', '-p', 'x'];
    const d = approvalDigest('/bin/claude', argv, '/w', ['PATH', 'HOME']);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalDigest('/bin/claude', argv, '/w', ['HOME', 'PATH'])).toBe(d);
    expect(approvalDigest('/bin/claude', [...argv, '--verbose'], '/w', ['PATH', 'HOME'])).not.toBe(d);
    expect(approvalDigest('/bin/claude', argv, '/w2', ['PATH', 'HOME'])).not.toBe(d);
    expect(approvalDigest('/bin/claude', argv, '/w', ['PATH', 'HOME', 'ANTHROPIC_API_KEY'])).not.toBe(d);
    expect(approvalDigest('/usr/bin/claude', argv, '/w', ['PATH', 'HOME'])).not.toBe(d);
  });
});
