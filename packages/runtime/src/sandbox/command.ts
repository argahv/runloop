import { spawn } from 'node:child_process';
import { SandboxError } from './paths';

/** The only commands the sandbox will run, matched argv-exactly. */
export const ALLOWED_COMMANDS: readonly (readonly string[])[] = [['node', '--test', '--test-reporter=tap']];

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function isAllowedCommand(argv: readonly string[]): boolean {
  return ALLOWED_COMMANDS.some((allowed) => allowed.length === argv.length && allowed.every((a, i) => a === argv[i]));
}

/**
 * The child sees only PATH, HOME (= the workspace) and NO_COLOR: no
 * NODE_OPTIONS, loaders or credentials from the runtime's environment.
 */
export function minimalEnv(cwd: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: cwd, NO_COLOR: '1' };
}

/**
 * Run an allowlisted command in `cwd`. `node` is this runtime's own binary
 * (process.execPath), spawned without a shell. On timeout or abort the whole
 * process group is SIGKILLed (node --test forks one child per test file).
 * Spawn failures reject; everything else resolves with what happened.
 */
export function runCommand(argv: readonly string[], opts: RunCommandOptions): Promise<CommandResult> {
  if (!isAllowedCommand(argv)) throw new SandboxError('not_allowed', `Command not allowed: ${argv.join(' ')}`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const started = performance.now();

  return new Promise<CommandResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false, durationMs: 0 });
      return;
    }
    const child = spawn(process.execPath, argv.slice(1), {
      cwd: opts.cwd,
      env: minimalEnv(opts.cwd),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], size: 0, truncated: false };
    const collect = (key: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = MAX_OUTPUT_BYTES - out.size;
      if (room <= 0) {
        out.truncated = true;
        return;
      }
      const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      if (part !== chunk) out.truncated = true;
      out[key].push(part);
      out.size += part.byteLength;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (err) => {
      cleanup();
      reject(err);
    });
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out.stdout).toString('utf8'),
        stderr: Buffer.concat(out.stderr).toString('utf8'),
        timedOut,
        aborted,
        truncated: out.truncated,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}
