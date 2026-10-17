import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SandboxError, resolveInside, toRel } from './paths';

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LIST_ENTRIES = 500;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** The tool ran but reports a failure (e.g. file not found): tool.call_completed{status:error}. */
export class ToolReportedError extends Error {
  constructor(
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Recursive listing, sorted, directories suffixed with "/". Symlinks are
 * listed but never followed. Capped at MAX_LIST_ENTRIES.
 */
export function listFiles(root: string, rel = '.'): { entries: string[]; truncated: boolean } {
  const start = resolveInside(root, rel);
  if (!statSync(start, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ToolReportedError('not_a_directory', `Not a directory: ${rel}`);
  }
  const entries: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        entries.push(`${toRel(root, abs)}/`);
        walk(abs);
      } else {
        entries.push(toRel(root, abs));
      }
    }
  };
  walk(start);
  return { entries, truncated };
}

export function readWorkspaceFile(root: string, rel: string): { content: string; bytes: number } {
  const abs = resolveInside(root, rel);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) throw new ToolReportedError('not_found', `No such file: ${rel}`);
  if (!st.isFile()) throw new ToolReportedError('not_a_file', `Not a regular file: ${rel}`);
  if (st.size > MAX_FILE_BYTES) throw new SandboxError('too_large', `${rel} is ${st.size} bytes (limit ${MAX_FILE_BYTES})`);
  const buf = readFileSync(abs);
  return { content: buf.toString('utf8'), bytes: buf.byteLength };
}

export function writeWorkspaceFile(root: string, rel: string, content: string): { bytes: number } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) throw new SandboxError('too_large', `Refusing to write ${bytes} bytes (limit ${MAX_FILE_BYTES})`);
  const abs = resolveInside(root, rel);
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ToolReportedError('is_a_directory', `Is a directory: ${rel}`);
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  // Re-check after mkdir: the parent now exists and may be reached via a symlink.
  resolveInside(root, rel);
  writeFileSync(abs, content, 'utf8');
  return { bytes };
}
