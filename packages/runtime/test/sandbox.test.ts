import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedCommand, runCommand } from '../src/sandbox/command';
import { MAX_FILE_BYTES, ToolReportedError, listFiles, readWorkspaceFile, writeWorkspaceFile } from '../src/sandbox/fs-tools';
import { SandboxError, resolveInside } from '../src/sandbox/paths';
import { parseTap } from '../src/sandbox/tap';
import { tempDir } from './helpers';

const TEST_ARGV = ['node', '--test', '--test-reporter=tap'];

function workspace(): { ws: string; outside: string } {
  const root = tempDir('sandbox');
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(ws, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  return { ws, outside };
}

function denied(fn: () => unknown): SandboxError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxError);
    return err as SandboxError;
  }
  throw new Error('expected a SandboxError');
}

describe('resolveInside', () => {
  it('accepts paths inside the workspace', () => {
    const { ws } = workspace();
    expect(resolveInside(ws, 'src/a.js')).toBe(path.join(ws, 'src', 'a.js'));
    expect(resolveInside(ws, './src/../src/new/file.js')).toBe(path.join(ws, 'src', 'new', 'file.js'));
  });

  it('rejects traversal, absolute paths, NUL bytes and empty paths', () => {
    const { ws, outside } = workspace();
    expect(denied(() => resolveInside(ws, '../outside/secret.txt')).code).toBe('path_escape');
    expect(denied(() => resolveInside(ws, 'src/../../outside')).code).toBe('path_escape');
    expect(denied(() => resolveInside(ws, path.join(outside, 'secret.txt'))).code).toBe('path_escape');
    expect(denied(() => resolveInside(ws, 'src/a.js\0.txt')).code).toBe('invalid_path');
    expect(denied(() => resolveInside(ws, '')).code).toBe('invalid_path');
  });

  it('rejects symlink escapes (file, directory and dangling links)', () => {
    const { ws, outside } = workspace();
    symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'));
    symlinkSync(outside, path.join(ws, 'linkdir'));
    symlinkSync(path.join(outside, 'not-yet.txt'), path.join(ws, 'dangling.txt'));
    expect(() => readWorkspaceFile(ws, 'link.txt')).toThrow(SandboxError);
    expect(() => writeWorkspaceFile(ws, 'link.txt', 'x')).toThrow(SandboxError);
    expect(() => readWorkspaceFile(ws, 'linkdir/secret.txt')).toThrow(SandboxError);
    expect(() => writeWorkspaceFile(ws, 'linkdir/new/file.txt', 'x')).toThrow(SandboxError);
    expect(() => writeWorkspaceFile(ws, 'dangling.txt', 'x')).toThrow(SandboxError);
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('allows a symlink that stays inside', () => {
    const { ws } = workspace();
    symlinkSync(path.join(ws, 'src', 'a.js'), path.join(ws, 'alias.js'));
    expect(readWorkspaceFile(ws, 'alias.js').content).toContain('export const a');
  });
});

describe('fs tools', () => {
  it('caps reads and writes at 256 KB', () => {
    const { ws } = workspace();
    writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
    expect(denied(() => readWorkspaceFile(ws, 'big.txt')).code).toBe('too_large');
    expect(denied(() => writeWorkspaceFile(ws, 'big2.txt', 'y'.repeat(MAX_FILE_BYTES + 1))).code).toBe('too_large');
  });

  it('reports a missing file as a tool error, not a sandbox denial', () => {
    const { ws } = workspace();
    expect(() => readWorkspaceFile(ws, 'nope.js')).toThrow(ToolReportedError);
  });

  it('lists recursively, sorted, skipping node_modules and .git', () => {
    const { ws } = workspace();
    mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(ws, '.git'));
    writeFileSync(path.join(ws, 'README.md'), '#');
    expect(listFiles(ws).entries).toEqual(['README.md', 'src/', 'src/a.js']);
  });
});

describe('runCommand', () => {
  afterEach(() => {
    delete process.env.RUNLOOP_SANDBOX_TEST_TOKEN;
  });

  it('allows only the exact test argv', () => {
    expect(isAllowedCommand(TEST_ARGV)).toBe(true);
    for (const argv of [
      ['node', '-e', 'process.exit(0)'],
      ['rm', '-rf', '/'],
      ['node', '--test'],
      [...TEST_ARGV, 'extra.js'],
      ['bash', '-c', 'node --test --test-reporter=tap'],
      ['/usr/bin/node', '--test', '--test-reporter=tap'],
    ]) {
      expect(isAllowedCommand(argv)).toBe(false);
      expect(() => runCommand(argv, { cwd: '.' })).toThrow(SandboxError);
    }
  });

  it('gives the child a minimal env: no secrets, no NODE_OPTIONS, HOME = workspace', { timeout: 20_000 }, async () => {
    const { ws } = workspace();
    process.env.RUNLOOP_SANDBOX_TEST_TOKEN = 'leak-me-if-you-can-123';
    mkdirSync(path.join(ws, 'test'));
    writeFileSync(
      path.join(ws, 'test', 'env.test.mjs'),
      `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('dump env', () => { writeFileSync(new URL('../env.json', import.meta.url), JSON.stringify(process.env)); });
`,
    );
    const r = await runCommand(TEST_ARGV, { cwd: ws });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(readFileSync(path.join(ws, 'env.json'), 'utf8')) as Record<string, string>;
    expect(JSON.stringify(env)).not.toContain('leak-me-if-you-can-123');
    expect(env.RUNLOOP_SANDBOX_TEST_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HOME).toBe(ws);
    expect(env.NO_COLOR).toBe('1');
  });

  it('kills the whole process group on timeout', { timeout: 20_000 }, async () => {
    const { ws } = workspace();
    mkdirSync(path.join(ws, 'test'));
    writeFileSync(
      path.join(ws, 'test', 'hang.test.mjs'),
      `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('hang', () => { writeFileSync(new URL('../pid', import.meta.url), String(process.pid)); return new Promise(() => setInterval(() => {}, 1000)); });
`,
    );
    const r = await runCommand(TEST_ARGV, { cwd: ws, timeoutMs: 3000 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.durationMs).toBeLessThan(10_000);
    // The test-file subprocess (a grandchild) must be gone too (or a zombie awaiting reaping).
    const pid = Number(readFileSync(path.join(ws, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    let alive = true;
    try {
      process.kill(pid, 0);
      alive = !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('kills the child when aborted', { timeout: 20_000 }, async () => {
    const { ws } = workspace();
    mkdirSync(path.join(ws, 'test'));
    writeFileSync(path.join(ws, 'test', 'hang.test.mjs'), `import { test } from 'node:test';\ntest('hang', () => new Promise(() => setInterval(() => {}, 1000)));\n`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runCommand(TEST_ARGV, { cwd: ws, signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  });
});

describe('parseTap', () => {
  it('reads the footer counts and leaf failure names (not failing suites)', () => {
    const tap = [
      'TAP version 13',
      '# Subtest: ok one',
      'ok 1 - ok one',
      '  ---',
      "  type: 'test'",
      '  ...',
      '# Subtest: group',
      '    # Subtest: inner \\# hash',
      '    not ok 1 - inner \\# hash',
      '      ---',
      "      type: 'test'",
      "      error: 'nope'",
      '      ...',
      '    1..1',
      'not ok 2 - group',
      '  ---',
      "  type: 'suite'",
      '  ...',
      'not ok 3 - top level',
      '  ---',
      "  type: 'test'",
      '  ...',
      'ok 4 - skipped one # SKIP',
      '1..4',
      '# tests 4',
      '# suites 1',
      '# pass 2',
      '# fail 2',
    ].join('\n');
    expect(parseTap(tap)).toEqual({
      metrics: { tests: 4, passed: 2, failed: 2 },
      failingTests: ['inner # hash', 'top level'],
    });
  });

  it('leaves metrics out when there is no footer', () => {
    expect(parseTap('garbage\n')).toEqual({ failingTests: [] });
  });
});
