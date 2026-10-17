import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { AgentAdapter } from './adapter';
import { collectEnvSecrets, findRepoRoot, resolveAllowedOrigins, resolveDataDir } from './config';
import { createApp } from './http/app';
import { Recorder } from './recorder';
import { RunManager } from './run-manager';
import { openDb, type Db } from './store/db';

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  dataDir?: string;
  /** Defaults to secrets collected from `env`. */
  secrets?: readonly string[];
  missionsDir?: string;
  worldsDir?: string;
  allowedOrigins?: readonly string[];
  adapters?: readonly AgentAdapter[];
  commandTimeoutMs?: number;
  pingMs?: number;
}

export interface Runtime {
  repoRoot: string;
  dataDir: string;
  db: Db;
  recorder: Recorder;
  manager: RunManager;
  app: Hono;
  /** Runs found `running` at boot and marked interrupted. */
  recovered: string[];
  /** Stop the active run (recorded as stopped) and close the database. */
  close(): Promise<void>;
}

/** Wire storage, recovery, the run manager and the HTTP app together. */
export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const dataDir = opts.dataDir ?? resolveDataDir(env, repoRoot);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'runloop.db'));
  const recorder = new Recorder({ db, dataDir, secrets: opts.secrets ?? collectEnvSecrets(env) });
  const recovered = recorder.recoverInterrupted();
  const manager = new RunManager({
    recorder,
    dataDir,
    missionsDir: opts.missionsDir ?? path.join(repoRoot, 'examples'),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.commandTimeoutMs !== undefined ? { commandTimeoutMs: opts.commandTimeoutMs } : {}),
    onError: (err) => console.error('[runtime]', err),
  });
  const app = createApp({
    recorder,
    manager,
    worldsDir: opts.worldsDir ?? path.join(repoRoot, 'worlds'),
    allowedOrigins: opts.allowedOrigins ?? resolveAllowedOrigins(env),
    ...(opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}),
  });
  let closed = false;
  return {
    repoRoot,
    dataDir,
    db,
    recorder,
    manager,
    app,
    recovered,
    async close() {
      if (closed) return;
      closed = true;
      await manager.shutdown();
      db.close();
    },
  };
}
