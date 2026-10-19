/**
 * Workspace roots: the only module that reads or writes absolute paths
 * (table workspace_roots). Everything else, the world and every API response
 * carry the workspace id, its label (base name) and a pathHint instead (P8).
 *
 * Roots are realpaths. A session binds to the root that is the longest
 * prefix of realpath(cwd), on path-segment boundaries (case-folded where the
 * file system usually is: macOS and Windows).
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../store/db';

export type RootProblem = 'not_found' | 'not_a_directory' | 'filesystem_root' | 'inside_data_dir' | 'already_bound';

/** User-facing text for each problem. It never repeats the path (P8). */
export const ROOT_PROBLEM_TEXT: Record<RootProblem, string> = {
  not_found: 'That folder does not exist on this machine',
  not_a_directory: 'That path is not a folder',
  filesystem_root: 'Choose a project folder, not the file system root',
  inside_data_dir: "That folder is inside Runloop's own data directory",
  already_bound: 'That folder already belongs to an agent',
};

export interface RootMatch {
  workspaceId: string;
  /** Length of the matched root, for tests and tie-breaks (longest wins). */
  length: number;
}

const foldsCase = (platform: NodeJS.Platform) => platform === 'darwin' || platform === 'win32';

/** The realpath of `p`, or null when it does not exist (or cannot be read). */
export function realpathOrNull(p: string): string | null {
  try {
    return realpathSync.native(path.resolve(p));
  } catch {
    return null;
  }
}

/**
 * Whether `child` is `root` or inside it, on segment boundaries
 * (`/a/bc` is not inside `/a/b`). Both must be absolute and normalised.
 */
export function isWithin(child: string, root: string, platform: NodeJS.Platform = process.platform, sep: string = path.sep): boolean {
  const fold = foldsCase(platform);
  const c = fold ? child.toLowerCase() : child;
  let r = fold ? root.toLowerCase() : root;
  if (c === r) return true;
  if (!r.endsWith(sep)) r += sep;
  return c.startsWith(r);
}

/** The root that is the longest prefix of `cwdReal` (pure; roots are realpaths). */
export function longestRootMatch(
  cwdReal: string,
  roots: readonly { workspaceId: string; root: string }[],
  platform: NodeJS.Platform = process.platform,
  sep: string = path.sep,
): RootMatch | null {
  let best: RootMatch | null = null;
  for (const { workspaceId, root } of roots) {
    if (!isWithin(cwdReal, root, platform, sep)) continue;
    if (!best || root.length > best.length) best = { workspaceId, length: root.length };
  }
  return best;
}

/** The folder's base name, shown as the workspace label. */
export function labelOf(real: string): string {
  const base = path.basename(real.replace(/[\\/]+$/, ''));
  return base || 'workspace';
}

/**
 * A short hint such as "…/code/runloop": the last two segments, or only the
 * base name for a path that short, so a hint never contains the whole path.
 */
export function pathHintOf(real: string, sep: string = path.sep): string {
  const parts = real.split(/[\\/]+/).filter(Boolean);
  const tail = parts.length >= 3 ? parts.slice(-2) : parts.slice(-1);
  const s = sep === '\\' ? '\\' : '/';
  return `…${s}${tail.join(s)}`;
}

export class LocalRoots {
  constructor(
    private readonly db: Db,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /**
   * Check a typed path as a new root: it must exist, be a folder, not be the
   * file system root, sit outside the data dir, and not be bound already.
   */
  check(input: string, dataDir: string): { ok: true; realpath: string } | { ok: false; problem: RootProblem } {
    const real = realpathOrNull(input);
    if (!real) return { ok: false, problem: 'not_found' };
    try {
      if (!statSync(real).isDirectory()) return { ok: false, problem: 'not_a_directory' };
    } catch {
      return { ok: false, problem: 'not_found' };
    }
    if (path.parse(real).root === real) return { ok: false, problem: 'filesystem_root' };
    const data = realpathOrNull(dataDir) ?? path.resolve(dataDir);
    if (isWithin(real, data, this.platform)) return { ok: false, problem: 'inside_data_dir' };
    if (this.isBound(real)) return { ok: false, problem: 'already_bound' };
    return { ok: true, realpath: real };
  }

  /** Whether exactly this root is registered (to any workspace). */
  isBound(real: string): boolean {
    const key = foldsCase(this.platform) ? real.toLowerCase() : real;
    return this.all().some((r) => (foldsCase(this.platform) ? r.root.toLowerCase() : r.root) === key);
  }

  /** Register a root for a workspace. Call inside the transaction that creates the workspace. */
  add(workspaceId: string, real: string): void {
    this.db.prepare('INSERT INTO workspace_roots (workspace_id, root_realpath) VALUES (?, ?)').run(workspaceId, real);
  }

  /** Remove a workspace's roots (rollback of a rejected Add to World). Call inside a transaction. */
  removeAll(workspaceId: string): void {
    this.db.prepare('DELETE FROM workspace_roots WHERE workspace_id = ?').run(workspaceId);
  }

  /** The workspace whose root is the longest prefix of realpath(cwd); null when none (an Arrival). */
  match(cwd: string): RootMatch | null {
    if (!path.isAbsolute(cwd)) return null;
    // A folder that no longer exists still matches by its normalised path.
    const real = realpathOrNull(cwd) ?? path.resolve(cwd);
    return longestRootMatch(real, this.all(), this.platform);
  }

  /**
   * The workspace's root realpath, for the one caller that needs it: the
   * dispatch manager, which runs Claude Code there. Never return it from an
   * API, store it elsewhere or put it in the world (P8).
   */
  rootOf(workspaceId: string): string | null {
    const row = this.db
      .prepare('SELECT root_realpath FROM workspace_roots WHERE workspace_id = ? ORDER BY root_realpath LIMIT 1')
      .get(workspaceId) as { root_realpath: string } | undefined;
    return row?.root_realpath ?? null;
  }

  /** Whether the workspace has at least one root. */
  hasRoot(workspaceId: string): boolean {
    return this.db.prepare('SELECT 1 FROM workspace_roots WHERE workspace_id = ? LIMIT 1').get(workspaceId) !== undefined;
  }

  private all(): { workspaceId: string; root: string }[] {
    const rows = this.db.prepare('SELECT workspace_id, root_realpath FROM workspace_roots').all() as {
      workspace_id: string;
      root_realpath: string;
    }[];
    return rows.map((r) => ({ workspaceId: r.workspace_id, root: r.root_realpath }));
  }
}
