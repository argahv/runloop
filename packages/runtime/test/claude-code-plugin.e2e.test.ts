/**
 * End to end: every fixture line goes through the REAL plugin hook script
 * (a child `node` process, stdin = the hook JSON) to a live runtime over
 * HTTP. Each invocation must exit 0 with empty stdout, and the recorded run
 * must match the golden fold of the same fixture.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import type { RunEvent } from '@runloop-world/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime';
import { ALL_FIXTURES, comparable, readFixture, recordFixture, type FixtureLine } from './claude-code-helpers';
import { REPO_ROOT, tempDir } from './helpers';

const SCRIPT = path.join(REPO_ROOT, 'integrations', 'claude-code-plugin', 'scripts', 'runloop-hook.mjs');
const SYNC_HOOKS = new Set(['Stop', 'StopFailure', 'SessionEnd']);
/** The script bounds itself at 1.5 s; allow for process start-up on a busy test machine. */
const MAX_INVOCATION_MS = 3000;

interface Invocation {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run the hook script like Claude Code does: exec form, JSON on stdin. */
function hook(input: string, env: Record<string, string>, args: string[] = []): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

const argsFor = (line: FixtureLine) => (SYNC_HOOKS.has(String(line.input.hook_event_name)) ? ['--sync'] : []);

let rt: Runtime;
let server: ServerType;
let url: string;
let tokenFile: string;
/** Lives for the whole suite (helpers' tempDir() is removed after each test). */
let suiteDir: string;

beforeAll(async () => {
  suiteDir = mkdtempSync(path.join(os.tmpdir(), 'runloop-e2e-'));
  tokenFile = path.join(suiteDir, 'config', 'ingest-token');
  rt = createRuntime({ repoRoot: REPO_ROOT, dataDir: path.join(suiteDir, 'data'), env: {}, trace: { tokenFile } });
  url = await new Promise<string>((resolve) => {
    server = serve({ fetch: rt.app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rt.close();
  rmSync(suiteDir, { recursive: true, force: true });
});

/** Env of a hook process: its own plugin data dir, the runtime URL and the token file. */
const hookEnv = (pluginData: string, overrides: Record<string, string> = {}) => ({
  HOME: pluginData,
  CLAUDE_PLUGIN_DATA: pluginData,
  RUNLOOP_URL: url,
  RUNLOOP_INGEST_TOKEN_FILE: tokenFile,
  ...overrides,
});

/** The traced run recorded for a session id (exactly one expected). */
function runOf(sessionId: string): RunEvent[] {
  const runs = rt.recorder.listRuns().filter((r) => r.source?.sessionId === sessionId);
  expect(runs).toHaveLength(1);
  return rt.recorder.listAll(runs[0]!.runId);
}

describe('Claude Code plugin → runtime (real hook script)', () => {
  it.each(ALL_FIXTURES)('%s: every invocation exits 0 silently and the run matches the golden', { timeout: 120_000 }, async (name) => {
    const lines = readFixture(name);
    const pluginData = tempDir(`e2e-${name}`);
    for (const line of lines) {
      const r = await hook(JSON.stringify(line.input), hookEnv(pluginData), argsFor(line));
      expect(r.status, `${line.argv[0]} exit`).toBe(0);
      expect(r.stdout, `${line.argv[0]} stdout`).toBe('');
      expect(r.ms).toBeLessThan(MAX_INVOCATION_MS);
    }
    // Delivered: nothing left in the spool.
    expect(readdirSync(path.join(pluginData, 'spool')).flatMap((s) => readdirSync(path.join(pluginData, 'spool', s)))).toEqual([]);
    // A session without SessionEnd is closed by the idle sweep (as in the golden fold).
    rt.tracer!.sweepIdle(new Date(Date.now() + 3 * 24 * 3600_000));
    const sessionId = String(lines[0]!.input.session_id);
    const golden = recordFixture(name, tempDir(`e2e-golden-${name}`)).runs[0]!;
    expect(comparable(runOf(sessionId))).toEqual(comparable(golden));
  });

  it('exits 0 with empty stdout on garbage input, a bad token and an unreachable runtime', { timeout: 60_000 }, async () => {
    const pluginData = tempDir('e2e-bad');
    const line = JSON.stringify({ session_id: 'e2e-bad', hook_event_name: 'SessionStart', cwd: '/home/dev/demo', source: 'startup' });
    const badToken = path.join(pluginData, 'bad-token');
    writeFileSync(badToken, 'not-the-right-token-at-all\n');
    const cases: [string, Record<string, string>, string][] = [
      ['garbage stdin', hookEnv(pluginData), '{"session_id": tru'],
      ['empty stdin', hookEnv(pluginData), ''],
      ['binary stdin', hookEnv(pluginData), '\u0000\u0001\u0002'],
      ['bad token', hookEnv(pluginData, { RUNLOOP_INGEST_TOKEN_FILE: badToken }), line],
      ['missing token', hookEnv(pluginData, { RUNLOOP_INGEST_TOKEN_FILE: path.join(pluginData, 'nope') }), line],
      ['unreachable runtime', hookEnv(pluginData, { RUNLOOP_URL: 'http://127.0.0.1:9' }), line],
      ['non-loopback runtime', hookEnv(pluginData, { RUNLOOP_URL: 'http://192.0.2.1:4380' }), line],
    ];
    for (const [label, env, input] of cases) {
      for (const args of [[], ['--sync']]) {
        const r = await hook(input, env, args);
        expect(r.status, label).toBe(0);
        expect(r.stdout, label).toBe('');
        expect(r.ms, label).toBeLessThan(MAX_INVOCATION_MS);
      }
    }
    expect(rt.recorder.listRuns().some((r) => r.source?.sessionId === 'e2e-bad')).toBe(false);
  });

  it('offline: hooks spool while the runtime is unreachable, and the next hook flushes them in order', { timeout: 120_000 }, async () => {
    const name = 's1-basic';
    const lines = readFixture(name);
    expect(lines.length).toBeLessThanOrEqual(21); // one hook flushes up to 20 older entries plus its own
    // Another session id, so this run does not collide with the one recorded above.
    const sessionId = 'e2e-offline-session';
    const input = (l: FixtureLine) => JSON.stringify({ ...l.input, session_id: sessionId });
    const pluginData = tempDir('e2e-offline');
    const spooled = () => readdirSync(path.join(pluginData, 'spool')).flatMap((d) => readdirSync(path.join(pluginData, 'spool', d)));
    for (const line of lines.slice(0, -1)) {
      const r = await hook(input(line), hookEnv(pluginData, { RUNLOOP_URL: 'http://127.0.0.1:9' }), argsFor(line));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(spooled()).toHaveLength(lines.length - 1);
    expect(rt.recorder.listRuns().some((r) => r.source?.sessionId === sessionId)).toBe(false);
    // The runtime is reachable again: the next hook sends the spool (oldest first) with its own event.
    const last = lines.at(-1)!;
    const r = await hook(input(last), hookEnv(pluginData), argsFor(last));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(spooled()).toEqual([]);
    const golden = recordFixture(name, tempDir('e2e-offline-golden')).runs[0]!;
    const withoutSession = (events: RunEvent[]) =>
      comparable(events).map((e) => {
        const x = e as { type: string; payload: Record<string, unknown> };
        if (x.type !== 'run.started') return e;
        return { ...x, payload: { ...x.payload, source: { ...(x.payload.source as Record<string, unknown>), sessionId: '(session)' } } };
      });
    expect(withoutSession(runOf(sessionId))).toEqual(withoutSession(golden));
  });

  it('a backlog larger than one request, ending in SessionEnd, arrives complete and in order', { timeout: 120_000 }, async () => {
    const name = 's2-subagents';
    const lines = readFixture(name);
    expect(lines.length).toBeGreaterThan(21);
    expect(lines.at(-1)!.input.hook_event_name).toBe('SessionEnd');
    const sessionId = 'e2e-backlog-session';
    const input = (l: FixtureLine) => JSON.stringify({ ...l.input, session_id: sessionId });
    const pluginData = tempDir('e2e-backlog');
    const spooled = () => readdirSync(path.join(pluginData, 'spool')).flatMap((d) => readdirSync(path.join(pluginData, 'spool', d)));
    for (const line of lines.slice(0, -1)) await hook(input(line), hookEnv(pluginData, { RUNLOOP_URL: 'http://127.0.0.1:9' }), argsFor(line));
    expect(spooled()).toHaveLength(lines.length - 1);
    // The runtime is back; the synchronous SessionEnd hook must not overtake the backlog.
    const r = await hook(input(lines.at(-1)!), hookEnv(pluginData), ['--sync']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // Whatever its time budget left over waits in the spool, in order; --doctor sends it.
    if (spooled().length > 0) expect((await hook('', hookEnv(pluginData), ['--doctor'])).status).toBe(0);
    expect(spooled()).toEqual([]);
    const golden = recordFixture(name, tempDir('e2e-backlog-golden')).runs[0]!;
    const withoutSession = (events: RunEvent[]) =>
      comparable(events).map((e) => {
        const x = e as { type: string; payload: Record<string, unknown> };
        if (x.type !== 'run.started') return e;
        return { ...x, payload: { ...x.payload, source: { ...(x.payload.source as Record<string, unknown>), sessionId: '(session)' } } };
      });
    expect(withoutSession(runOf(sessionId))).toEqual(withoutSession(golden));
  });
});
