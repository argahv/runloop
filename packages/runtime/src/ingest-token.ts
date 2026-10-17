/**
 * The per-user ingest token shared by the runtime and the Claude Code plugin.
 *
 * The runtime's data dir is per repo, which the plugin cannot discover, so
 * the token lives in the user's config dir:
 *   $RUNLOOP_INGEST_TOKEN_FILE, else
 *   %APPDATA%\runloop\ingest-token (Windows), else
 *   $XDG_CONFIG_HOME/runloop/ingest-token, else ~/.config/runloop/ingest-token.
 * The plugin resolves the same path (integrations/claude-code-plugin/scripts/runloop-hook.mjs).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The token file path from `env` only (no fallback to the process's home):
 * null when the environment names no config or home directory.
 */
export function resolveIngestTokenFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const explicit = env.RUNLOOP_INGEST_TOKEN_FILE?.trim();
  if (explicit) return path.resolve(explicit);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'runloop', 'ingest-token');
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'runloop', 'ingest-token');
  const home = env.HOME ?? env.USERPROFILE;
  return home ? path.join(home, '.config', 'runloop', 'ingest-token') : null;
}

function readToken(file: string): string | null {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return token.length >= 16 ? token : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Keep the token private: mode 0600 (Windows: the profile's ACL applies
 * instead). Returns a warning when the file belongs to another user, whose
 * token this runtime should not trust.
 */
function securePermissions(file: string): string | null {
  if (process.platform === 'win32') return null;
  const st = statSync(file);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    return `The ingest token file ${file} is owned by another user (uid ${st.uid}); delete it so the runtime creates its own.`;
  }
  if ((st.mode & 0o077) !== 0) chmodSync(file, 0o600);
  return null;
}

/**
 * Read the token, creating it (32 random bytes, base64url, mode 0600) if
 * missing. An existing file readable by others is tightened to 0600.
 */
export function ensureIngestToken(file: string, warn: (message: string) => void = (m) => console.warn(`[runtime] ${m}`)): string {
  const existing = readToken(file);
  if (existing) {
    const problem = securePermissions(file);
    if (problem) warn(problem);
    return existing;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  try {
    // 'wx': if another runtime created it meanwhile, use theirs.
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = readToken(file);
    if (raced) return raced;
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the user profile's ACL applies instead of mode bits.
  }
  return token;
}

/** Constant-time comparison on SHA-256 digests (also hides the token length). */
export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}
