import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { EventBus } from '../src/bus';
import { findRepoRoot } from '../src/config';
import { Recorder, type RunManifest } from '../src/recorder';
import { openDb } from '../src/store/db';

export const REPO_ROOT = findRepoRoot();
export const EXAMPLE_DIR = path.join(REPO_ROOT, 'examples', 'coding-mission');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp dir, removed after the current test. */
export function tempDir(label = 'test'): string {
  const d = mkdtempSync(path.join(os.tmpdir(), `runloop-${label}-`));
  dirs.push(d);
  return d;
}

export const MANIFEST: RunManifest = {
  title: 'Test run',
  missionId: 'test-mission',
  worldId: 'research-campus',
  seed: 1,
  adapter: { id: 'test', kind: 'scripted', label: 'Test adapter' },
  workspace: 'workspaces/test',
};

/** A recorder on a file DB in `dataDir`; listener errors are swallowed quietly. */
export function openRecorder(dataDir: string, opts: { secrets?: string[] } = {}) {
  const file = path.join(dataDir, 'runloop.db');
  const db = openDb(file);
  const recorder = new Recorder({ db, dataDir, bus: new EventBus(() => {}), ...opts });
  return { db, file, recorder };
}

/** sha256 over every file (path + bytes) under `dir`, for "unchanged" checks. */
export function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update('\0').update(readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Incrementally parse an SSE response body. */
export function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  let done = false;

  const parse = () => {
    let i: number;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const f: SseFrame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) f.comment = line.slice(1).trim();
        else {
          const [k, ...rest] = line.split(':');
          const v = rest.join(':').replace(/^ /, '');
          if (k === 'id') f.id = v;
          else if (k === 'event') f.event = v;
          else if (k === 'data') f.data = f.data === undefined ? v : `${f.data}\n${v}`;
        }
      }
      if (Object.keys(f).length) frames.push(f);
    }
  };

  return {
    frames,
    get done() {
      return done;
    },
    /** Read until `pred(frames)` holds or the stream ends. */
    async until(pred: (frames: SseFrame[]) => boolean, timeoutMs = 5000): Promise<SseFrame[]> {
      const deadline = Date.now() + timeoutMs;
      while (!pred(frames) && !done) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`SSE timeout; got ${JSON.stringify(frames.slice(-3))}`);
        const r = await Promise.race([
          reader.read(),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
        ]);
        if (r === 'timeout') continue;
        if (r.done) done = true;
        else buffer += decoder.decode(r.value, { stream: true });
        parse();
      }
      return frames;
    },
    cancel: () => reader.cancel(),
  };
}
