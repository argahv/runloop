import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// The plugin cannot import the monorepo packages at run time; its copies are checked against them here.
import { REDACTION_PATTERNS as EVENTS_PATTERNS, redactText as eventsRedactText } from '../../../packages/events/src/redact';
import { redactHook as runtimeRedactHook, slimHook as runtimeSlimHook } from '../../../packages/runtime/src/tracers/claude-code/hook-input';
import { SHELL_SECRET_PATTERNS as RUNTIME_SHELL_PATTERNS } from '../../../packages/runtime/src/tracers/claude-code/summarize';
import {
  DEFAULT_URL,
  PLUGIN,
  REDACTION_PATTERNS,
  SHELL_SECRET_PATTERNS,
  buildEnvelope,
  doctorDataDirs,
  listSpool,
  redactHook,
  redactText,
  resolveRuntimeUrl,
  resolveTokenFile,
  runHook,
  slimHook,
  spoolRoot,
  tokenFileProblem,
  tracingEnabled,
  writeSpool,
} from '../scripts/runloop-hook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'runloop-hook.mjs');
const FIXTURES = path.join(HERE, '..', '..', '..', 'packages', 'runtime', 'test', 'fixtures', 'claude-code');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'runloop-plugin-'));
  dirs.push(d);
  return d;
};

const fixtureInputs = (): Record<string, unknown>[] =>
  readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(path.join(FIXTURES, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { input: Record<string, unknown> }).input),
    );

/** Credentials as they appear in real commands (each must never reach an envelope). */
const SECRET_COMMANDS: [command: string, secret: string][] = [
  ['curl -u admin:Sup3rS3cretPassw0rd https://api.internal.example.com/v1/users', 'Sup3rS3cretPassw0rd'],
  ['psql "postgresql://app_user:pgS3cr3t' + 'Passw0rd@db.prod.example.com:5432/app" -c "select 1"', 'pgS3cr3t' + 'Passw0rd'],
  ['curl -H "X-API-Key: 4f9d2c8e7a1b4e6f9c3d2a1b8e7f6c5d" https://api.example.com/v1/items', '4f9d2c8e7a1b4e6f9c3d2a1b8e7f6c5d'],
  ['curl https://api.stripe.com/v1/charges -u sk_' + 'live_51HxYzAbCdEfGhIjKlMnOpQrStUvWx:', 'sk_' + 'live_51HxYzAbCdEfGhIjKlMnOpQrStUvWx'],
  ['mysql -h db -u root -pMyR00tPassw0rd prod', 'MyR00tPassw0rd'],
  ['curl "https://api.example.com/data?api_key=AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"', 'AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'],
  ['git clone https://oauth2:glpat' + '-Zx8vQ2mN4pL6rT1yU3wE@gitlab.com/org/repo.git', 'glpat' + '-Zx8vQ2mN4pL6rT1yU3wE'],
  ['aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['docker login -u bob -p dckr_pat_2b3e36beeb386dfdaacb9b46004ccb7c registry.example.com', 'dckr_pat_2b3e36beeb386dfdaacb9b46004ccb7c'],
  ['docker login -u bob -p Hunter2Hunter2xyz registry.example.com', 'Hunter2Hunter2xyz'],
  ['sshpass -p hunter2pw ssh deploy@host', 'hunter2pw'],
  ['curl -H "Authorization: token ghs' + '_16C7e42F292c6912E7710c838347Ae178B4a" https://api.github.com/repos/x', 'ghs' + '_16C7e42F292c6912E7710c838347Ae178B4a'],
  ['curl -H "Authorization: Basic YWRtaW46U3VwM3JTM2NyZXQ=" https://intranet.example.com', 'YWRtaW46U3VwM3JTM2NyZXQ='],
  ['export OPENAI_API_KEY=sk-' + 'proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345 && node app.js', 'sk-' + 'proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['curl -d "username=admin&password=Hunter2Hunter2" https://example.com/login', 'Hunter2Hunter2'],
  ['export db_password=lowercase-secret-1 && ./run', 'lowercase-secret-1'],
  ['npm config set //registry.npmjs.org/:_authToken npm' + '_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'npm' + '_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
];

describe('parity with the monorepo', () => {
  it('uses the same redaction patterns as @runloop-world/events', () => {
    expect(REDACTION_PATTERNS).toEqual([...EVENTS_PATTERNS]);
    for (const [command] of SECRET_COMMANDS) expect(redactText(command, [])).toBe(eventsRedactText(command));
  });

  it('redacts and slims every fixture payload and every secret case exactly like the runtime, idempotently', () => {
    const cases = [
      ...fixtureInputs(),
      ...SECRET_COMMANDS.map(([command]) => ({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })),
    ];
    for (const input of cases) {
      for (const secrets of [[], ['my-very-secret-value']]) {
        const out = redactHook(input, secrets);
        expect(out).toEqual(runtimeRedactHook(input, secrets));
        expect(redactHook(out, secrets)).toEqual(out);
      }
    }
  });

  it('uses the same shell secret patterns as the runtime', () => {
    const shape = (list: readonly { re: RegExp; replace: string }[]) => list.map(({ re, replace }) => [re.source, re.flags, replace]);
    expect(shape(SHELL_SECRET_PATTERNS)).toEqual(shape(RUNTIME_SHELL_PATTERNS));
  });

  it('slims every fixture payload exactly like the runtime, idempotently', () => {
    const inputs = fixtureInputs();
    expect(inputs.length).toBeGreaterThan(60);
    for (const input of inputs) {
      const slim = slimHook(input);
      expect(slim).toEqual(runtimeSlimHook(input));
      expect(slimHook(slim)).toEqual(slim);
    }
  });
});

describe('buildEnvelope', () => {
  const input = {
    session_id: 's-1',
    hook_event_name: 'PreToolUse',
    transcript_path: '/home/dev/.claude/projects/x/s-1.jsonl',
    cwd: '/home/dev/demo',
    tool_name: 'Bash',
    tool_input: { command: 'DEPLOY_TOKEN=abc123 curl -H "Authorization: Bearer abcdefghijkl" https://x --password hunter22' },
    tool_use_id: 'toolu_1',
    prompt: `use sk-${'a'.repeat(24)} and my-very-secret-value`,
  };

  it('slims, redacts (patterns, shell and env secrets) and stamps', () => {
    const env = buildEnvelope(input, {
      env: { MY_API_KEY: 'my-very-secret-value' },
      ppid: 42,
      now: new Date('2026-10-17T09:00:00.000Z'),
      deliveryId: 'd-1',
    });
    expect(env).toMatchObject({ v: 1, deliveryId: 'd-1', observedAt: '2026-10-17T09:00:00.000Z', ppid: 42, plugin: PLUGIN });
    expect(env.hook).not.toHaveProperty('transcript_path');
    expect((env.hook.tool_input as { command: string }).command).toBe(
      'DEPLOY_TOKEN=[REDACTED] curl -H "Authorization: Bearer [REDACTED]" https://x --password [REDACTED]',
    );
    expect(env.hook.prompt).toBe('use [REDACTED] and [REDACTED]');
  });

  it('masks every credential form in commands, and the same values where the output repeats them', () => {
    for (const [command, secret] of SECRET_COMMANDS) {
      for (const event of ['PreToolUse', 'PostToolUseFailure']) {
        const hook = {
          session_id: 's',
          hook_event_name: event,
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: 't',
          ...(event === 'PostToolUseFailure' ? { error: `Exit code 2\nauthentication failed (tried ${secret})` } : {}),
        };
        const json = JSON.stringify(buildEnvelope(hook, { env: {}, ppid: 1 }));
        expect(json, command).not.toContain(secret);
        expect(json).toContain('[REDACTED]');
      }
    }
    const fetch = { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://hooks.slack.com/' + 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX' } };
    expect(JSON.stringify(buildEnvelope(fetch, { env: {}, ppid: 1 }))).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX');
  });

  it('redacts a long string before cutting it, so a secret across the cut leaves no fragment', () => {
    const key = `${'sk-' + 'ant'}-api03-${'Q7xV9mK2pL4nR8tY1wE6uI3oP5aS0dF2gH7jK9lZ'}`;
    for (const offset of [-3, 3, 20]) {
      // Put the key across the start of the kept tail (the last 3000 characters).
      const before = 5000 - 3000 - offset;
      const prompt = `${'x'.repeat(before - 1)} ${key} ${'y'.repeat(5000 - before - key.length - 1)}`;
      const env = buildEnvelope({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt }, { env: {}, ppid: 1 });
      expect(env.hook.prompt).toContain('characters omitted');
      expect(env.hook.prompt).not.toMatch(/api03|Q7xV9mK2|9lZ/);
    }
    const secret = 'an-env-secret-value-1234';
    const output = `${'o'.repeat(6000)}${secret}${'p'.repeat(1990)}`; // across the start of the kept 2000-character tail
    const env = buildEnvelope(
      { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: output } },
      { env: { BUILD_TOKEN: secret }, ppid: 1 },
    );
    expect(JSON.stringify(env)).not.toMatch(/env-secret|value-1234/);
  });

  it('replaces the prompt when prompt recording is off', () => {
    for (const env of [{ RUNLOOP_TRACE_PROMPTS: '0' }, { CLAUDE_PLUGIN_OPTION_TRACE_PROMPTS: 'false' }]) {
      expect(buildEnvelope(input, { env, ppid: 1 }).hook.prompt).toBe('[prompt not recorded]');
    }
  });
});

describe('configuration', () => {
  it('prefers RUNLOOP_URL, then the plugin option, and refuses non-loopback URLs', () => {
    expect(resolveRuntimeUrl({})).toEqual({ url: DEFAULT_URL, from: 'default', loopback: true });
    expect(resolveRuntimeUrl({ CLAUDE_PLUGIN_OPTION_RUNTIME_URL: 'http://localhost:9000/' }).url).toBe('http://localhost:9000');
    expect(resolveRuntimeUrl({ RUNLOOP_URL: 'http://127.0.0.2:1', CLAUDE_PLUGIN_OPTION_RUNTIME_URL: 'http://localhost:9' })).toMatchObject({
      url: 'http://127.0.0.2:1',
      from: 'RUNLOOP_URL',
      loopback: true,
    });
    for (const url of ['http://example.com', 'http://10.0.0.1:4380', 'http://127.0.0.1.evil.com', 'file:///etc/passwd', 'nonsense']) {
      expect(resolveRuntimeUrl({ RUNLOOP_URL: url }).loopback, url).toBe(false);
    }
  });

  it('resolves the token file like the runtime and honours the off switches', () => {
    expect(resolveTokenFile({ RUNLOOP_INGEST_TOKEN_FILE: '/t/x' })).toBe('/t/x');
    expect(resolveTokenFile({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe('/cfg/runloop/ingest-token');
    expect(resolveTokenFile({ HOME: '/h' }, 'linux')).toBe('/h/.config/runloop/ingest-token');
    expect(tracingEnabled({})).toBe(true);
    expect(tracingEnabled({ RUNLOOP_TRACE: '0' })).toBe(false);
    expect(tracingEnabled({ CLAUDE_PLUGIN_OPTION_ENABLED: 'false' })).toBe(false);
  });
});

describe('spool and delivery', () => {
  const hookInput = (id: string) => JSON.stringify({ session_id: 'sess/1', hook_event_name: 'Stop', cwd: '/x', note: id });

  it('spools before sending and keeps the event when the runtime is unreachable', async () => {
    const data = tempDir();
    const token = path.join(data, 'token');
    writeFileSync(token, 'a-token-of-sufficient-length\n');
    const env = { CLAUDE_PLUGIN_DATA: data, RUNLOOP_URL: 'http://127.0.0.1:9', RUNLOOP_INGEST_TOKEN_FILE: token };
    await runHook([], { stdin: hookInput('1'), env, ppid: 1 });
    const spooled = listSpool(spoolRoot(env));
    expect(spooled).toHaveLength(1);
    expect(path.basename(path.dirname(spooled[0]!.file))).toBe('sess_1');
    expect(JSON.parse(readFileSync(path.join(data, 'last-error.json'), 'utf8')).message).toMatch(/1 event\(s\) stay in the spool/);
  });

  it('records bad input and missing tokens without throwing', async () => {
    const data = tempDir();
    const env = { CLAUDE_PLUGIN_DATA: data, RUNLOOP_INGEST_TOKEN_FILE: path.join(data, 'missing') };
    await runHook([], { stdin: 'not json', env, ppid: 1 });
    expect(JSON.parse(readFileSync(path.join(data, 'last-error.json'), 'utf8')).message).toBe('Hook input was not JSON');
    await runHook([], { stdin: hookInput('2'), env, ppid: 1 });
    expect(JSON.parse(readFileSync(path.join(data, 'last-error.json'), 'utf8')).message).toMatch(/No ingest token/);
    await runHook([], { stdin: hookInput('3'), env: { ...env, RUNLOOP_URL: 'http://example.com' }, ppid: 1 });
    expect(JSON.parse(readFileSync(path.join(data, 'last-error.json'), 'utf8')).message).toMatch(/non-loopback/);
    expect(listSpool(spoolRoot(env))).toHaveLength(2); // kept for a later, valid delivery
  });

  it('does nothing at all when tracing is off', async () => {
    const data = tempDir();
    await runHook([], { stdin: hookInput('4'), env: { CLAUDE_PLUGIN_DATA: data, RUNLOOP_TRACE: 'off' }, ppid: 1 });
    expect(readdirSync(data)).toEqual([]);
  });

  it('lists the spool oldest first and drops entries older than 7 days', () => {
    const root = path.join(tempDir(), 'spool');
    const mk = (iso: string, id: string, session: string) =>
      writeSpool(root, { deliveryId: id, observedAt: iso, hook: { session_id: session, hook_event_name: 'Stop' } });
    const b = mk('2026-10-17T09:00:02.000Z', 'b', 's2');
    const a = mk('2026-10-17T09:00:01.000Z', 'a', 's1');
    const old = mk('2026-10-01T09:00:00.000Z', 'old', 's1');
    const longAgo = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(old, longAgo, longAgo);
    expect(listSpool(root).map((e) => e.file)).toEqual([a, b]);
    expect(existsSync(old)).toBe(false);
  });
});

/** A stand-in runtime: records what it accepts; `reject` marks envelopes it answers 400 for. */
async function fakeRuntime(reject: (hook: Record<string, unknown>) => boolean = () => false) {
  const received: Record<string, unknown>[][] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const envelopes = (JSON.parse(body) as { envelopes: { hook: Record<string, unknown> }[] }).envelopes;
      if (envelopes.some((e) => reject(e.hook))) {
        res.writeHead(400).end('{}');
        return;
      }
      received.push(envelopes.map((e) => e.hook));
      res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
    });
  });
  const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { url, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('delivery order and limits', () => {
  const setup = (url: string) => {
    const data = tempDir();
    const token = path.join(data, 'token');
    writeFileSync(token, 'a-token-of-sufficient-length\n');
    return { data, env: { CLAUDE_PLUGIN_DATA: data, RUNLOOP_URL: url, RUNLOOP_INGEST_TOKEN_FILE: token } };
  };
  /** Spool n envelopes of session `sid`, observed one second apart. */
  const spoolMany = (env: Record<string, string>, n: number, sid = 'sess') => {
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.parse('2026-10-17T09:00:00.000Z') + i * 1000);
      writeSpool(spoolRoot(env), buildEnvelope({ session_id: sid, hook_event_name: 'PreToolUse', n: i }, { env: {}, ppid: 1, now: at }));
    }
  };

  it('sends a large backlog oldest first, so the hook\'s own SessionEnd arrives last', async () => {
    const rt = await fakeRuntime();
    try {
      const { env } = setup(rt.url);
      spoolMany(env, 130);
      const own = JSON.stringify({ session_id: 'sess', hook_event_name: 'SessionEnd', reason: 'other' });
      await runHook(['--sync'], { stdin: own, env, ppid: 1 });
      const order = rt.received.flat();
      expect(order).toHaveLength(131);
      expect(order.map((h) => h.n ?? 'end')).toEqual([...Array.from({ length: 130 }, (_, i) => i), 'end']);
      expect(rt.received.length).toBeGreaterThan(1); // in several requests (at most 100 envelopes each)
      expect(listSpool(spoolRoot(env))).toEqual([]);
    } finally {
      await rt.close();
    }
  });

  it('with no time left, sends nothing out of order: the hook\'s own event waits in the spool behind the backlog', async () => {
    const rt = await fakeRuntime();
    try {
      const { env } = setup(rt.url);
      spoolMany(env, 30);
      const own = JSON.stringify({ session_id: 'sess', hook_event_name: 'SessionEnd', reason: 'other' });
      // Node's start-up already used the whole budget (counted from process start).
      await runHook(['--sync'], { stdin: own, env, ppid: 1, startedAt: Date.now() - 5000 });
      expect(rt.received).toEqual([]);
      expect(listSpool(spoolRoot(env))).toHaveLength(31);
      expect(JSON.parse(readFileSync(path.join(env.CLAUDE_PLUGIN_DATA, 'last-error.json'), 'utf8')).message).toMatch(/Out of time/);
    } finally {
      await rt.close();
    }
  });

  it('drops only the envelope the runtime rejects as invalid, and keeps the order of the rest', async () => {
    const rt = await fakeRuntime((hook) => hook.n === 7);
    try {
      const { env } = setup(rt.url);
      spoolMany(env, 12);
      await runHook([], { stdin: JSON.stringify({ session_id: 'sess', hook_event_name: 'Stop' }), env, ppid: 1 });
      expect(rt.received.flat().map((h) => h.n ?? 'stop')).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 'stop']);
      expect(listSpool(spoolRoot(env))).toEqual([]);
    } finally {
      await rt.close();
    }
  });

  it('still delivers the event directly when the spool cannot be written', async () => {
    const rt = await fakeRuntime();
    try {
      const { data, env } = setup(rt.url);
      writeFileSync(path.join(data, 'spool'), 'not a directory');
      await runHook([], { stdin: JSON.stringify({ session_id: 'sess-ro', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), env, ppid: 1 });
      expect(rt.received.flat().map((h) => h.session_id)).toEqual(['sess-ro']);
      expect(JSON.parse(readFileSync(path.join(data, 'last-error.json'), 'utf8')).message).toMatch(/Could not write the spool/);
    } finally {
      await rt.close();
    }
  });
});

describe('token file', () => {
  it.skipIf(process.platform === 'win32')('reports a token file other users can read', () => {
    const file = path.join(tempDir(), 'token');
    writeFileSync(file, 'a-token-of-sufficient-length\n', { mode: 0o600 });
    expect(tokenFileProblem(file)).toBeNull();
    chmodSync(file, 0o644);
    expect(tokenFileProblem(file)).toMatch(/readable by other users \(mode 644\)/);
  });
});

describe('the script as a process', () => {
  const run = (args: string[], input: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { input, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 10_000 });

  it('always exits 0 with empty stdout, whatever the input', () => {
    const data = tempDir();
    const env = { CLAUDE_PLUGIN_DATA: data, HOME: data, RUNLOOP_URL: 'http://127.0.0.1:9' };
    for (const input of ['', 'garbage', '{}', '[1,2]', JSON.stringify({ session_id: 's', hook_event_name: 'SessionEnd' })]) {
      for (const args of [[], ['--sync']]) {
        const r = run(args, input, env);
        expect(r.status, `${input} ${args}`).toBe(0);
        expect(r.stdout).toBe('');
      }
    }
  });

  it('--doctor reports the setup on stdout and exits 0', () => {
    const data = tempDir();
    const r = run(['--doctor'], '', { CLAUDE_PLUGIN_DATA: data, HOME: data, RUNLOOP_URL: 'http://127.0.0.1:9' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Runloop tracer');
    expect(r.stdout).toContain('Runtime URL:  http://127.0.0.1:9 (from RUNLOOP_URL)');
    expect(r.stdout).toMatch(/Token file: .*missing/);
    expect(r.stdout).toContain('not reachable');
    expect(r.stdout).toContain('allowManagedHooksOnly');
  });

  it('--doctor finds the data dirs Claude Code creates when CLAUDE_PLUGIN_DATA is not set', () => {
    const home = tempDir();
    const root = path.join(home, '.claude', 'plugins', 'data');
    for (const name of ['runloop-tracer-inline', 'runloop-tracer-runloop', 'other-plugin']) mkdirSync(path.join(root, name), { recursive: true });
    expect(doctorDataDirs({ HOME: home })).toEqual([path.join(root, 'runloop-tracer-inline'), path.join(root, 'runloop-tracer-runloop')]);
    expect(doctorDataDirs({ HOME: home, CLAUDE_PLUGIN_DATA: '/x' })).toEqual(['/x']);
    expect(doctorDataDirs({ HOME: tempDir() })).toHaveLength(1);
    const r = run(['--doctor'], '', { HOME: home, RUNLOOP_URL: 'http://127.0.0.1:9' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(path.join(root, 'runloop-tracer-inline'));
  });
});
