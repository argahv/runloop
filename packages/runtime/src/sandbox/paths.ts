import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type SandboxErrorCode = 'path_escape' | 'invalid_path' | 'too_large' | 'not_allowed';

/** A request the sandbox refuses to run (reported as tool.call_failed{denied}). */
export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function lexists(p: string): boolean {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false; // e.g. ENOTDIR: a parent component is a file
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a workspace-relative path to an absolute one that is guaranteed to
 * stay inside `root`, including after following symlinks. For a path that does
 * not exist yet (a write), the nearest existing ancestor is checked instead.
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new SandboxError('invalid_path', 'Path must be a non-empty string');
  if (rel.includes('\0')) throw new SandboxError('invalid_path', 'Path contains a NUL byte');
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\')) {
    throw new SandboxError('path_escape', `Absolute paths are not allowed: ${rel}`);
  }
  const rootReal = realpathSync(root);
  const target = path.resolve(rootReal, rel);
  if (!isInside(rootReal, target)) throw new SandboxError('path_escape', `Path escapes the workspace: ${rel}`);

  // Follow symlinks on the deepest existing ancestor (or the target itself).
  // lstat, not exists: a dangling symlink must be checked, not skipped.
  let probe = target;
  while (probe !== rootReal && !lexists(probe)) probe = path.dirname(probe);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    // A dangling symlink: refuse rather than guess where it points.
    throw new SandboxError('path_escape', `Cannot resolve path: ${rel}`);
  }
  if (!isInside(rootReal, real)) throw new SandboxError('path_escape', `Path escapes the workspace via a symlink: ${rel}`);
  return target;
}

/** Workspace-relative display form with forward slashes. */
export function toRel(root: string, abs: string): string {
  return path.relative(realpathSync(root), abs).split(path.sep).join('/') || '.';
}
