import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_VERSION = '0.1.0';

/** Origins allowed to call the API from a browser (the studio dev server). */
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/** Env keys whose values are treated as secrets and redacted from events and artifacts. */
const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL/i;

/** Walk up from `start` to the directory that contains pnpm-workspace.yaml. */
export function findRepoRoot(start: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find the repository root (pnpm-workspace.yaml) above ${start}`);
    dir = parent;
  }
}

/** `RUNLOOP_DATA_DIR`, or `<repoRoot>/.runloop`. */
export function resolveDataDir(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const fromEnv = env.RUNLOOP_DATA_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(repoRoot, '.runloop');
}

/** Defaults plus a comma-separated `RUNLOOP_ALLOWED_ORIGINS`. */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.RUNLOOP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])];
}

/** Values (≥ 8 chars) of env vars whose name looks like a credential. */
export function collectEnvSecrets(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_KEY_RE.test(key)) out.add(value);
  }
  // Longest first so a secret that contains another is masked whole.
  return [...out].sort((a, b) => b.length - a.length);
}
