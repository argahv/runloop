import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { AgentAdapter } from './adapter';
import { collectEnvSecrets, findRepoRoot, resolveAllowedOrigins, resolveDataDir } from './config';
import { createApp } from './http/app';
import type { IngestRouteOptions } from './http/ingest';
import { ensureIngestToken, resolveIngestTokenFile } from './ingest-token';
import { Recorder } from './recorder';
import { RunManager } from './run-manager';
import { openDb, type Db } from './store/db';
import { TraceSessionManager } from './tracers/claude-code/session-manager';

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
  trace?: TraceOptions;
}

/** Claude Code tracer mode (POST /api/ingest/claude-code). */
export interface TraceOptions {
  /** Default: on, unless RUNLOOP_TRACE=off. */
  enabled?: boolean;
  /** Ingest token file; default from env (see resolveIngestTokenFile). null or unresolvable = tracing off. */
  tokenFile?: string | null;
  /** Close sessions without events for this long (default RUNLOOP_TRACE_IDLE_MINUTES or 120). */
  idleMinutes?: number;
  /** Idle sweep interval (default 60 s). */
  sweepMs?: number;
  rate?: IngestRouteOptions['rate'];
  now?: () => Date;
}

export interface Runtime {
  repoRoot: string;
  dataDir: string;
  db: Db;
  recorder: Recorder;
  manager: RunManager;
  /** Claude Code session tracing; null when turned off. */
  tracer: TraceSessionManager | null;
  /** Where the ingest token lives (null when tracing is off). */
  ingestTokenFile: string | null;
  app: Hono;
  /** Runs found `running` at boot and marked interrupted. */
  recovered: string[];
  /** Stop the active run (recorded as stopped), stop the idle sweep and close the database. */
  close(): Promise<void>;
}

/** Wire storage, recovery, the run manager and the HTTP app together. */
export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const dataDir = opts.dataDir ?? resolveDataDir(env, repoRoot);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'runloop.db'));
  const secrets = opts.secrets ?? collectEnvSecrets(env);
  const recorder = new Recorder({ db, dataDir, secrets });
  const recovered = recorder.recoverInterrupted();
  const manager = new RunManager({
    recorder,
    dataDir,
    missionsDir: opts.missionsDir ?? path.join(repoRoot, 'examples'),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.commandTimeoutMs !== undefined ? { commandTimeoutMs: opts.commandTimeoutMs } : {}),
    onError: (err) => console.error('[runtime]', err),
  });
  const trace = opts.trace ?? {};
  const tokenFile = trace.tokenFile !== undefined ? trace.tokenFile : resolveIngestTokenFile(env);
  const traceOn = (trace.enabled ?? env.RUNLOOP_TRACE?.trim().toLowerCase() !== 'off') && tokenFile !== null;
  let tracer: TraceSessionManager | null = null;
  let token: string | null = null;
  if (traceOn) {
    token = ensureIngestToken(tokenFile);
    const idle = trace.idleMinutes ?? Number(env.RUNLOOP_TRACE_IDLE_MINUTES ?? 120);
    tracer = new TraceSessionManager({
      recorder,
      db,
      ctx: { idleMinutes: Number.isFinite(idle) && idle > 0 ? idle : 120 },
      secrets,
      ...(trace.now ? { now: trace.now } : {}),
      onError: (err) => console.error('[tracer]', err),
    });
    tracer.start(trace.sweepMs ?? 60_000);
  }
  const app = createApp({
    recorder,
    manager,
    worldsDir: opts.worldsDir ?? path.join(repoRoot, 'worlds'),
    allowedOrigins: opts.allowedOrigins ?? resolveAllowedOrigins(env),
    ...(opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}),
    tracer: tracer && token ? { manager: tracer, token, ...(trace.rate ? { rate: trace.rate } : {}) } : null,
  });
  let closed = false;
  return {
    repoRoot,
    dataDir,
    db,
    recorder,
    manager,
    tracer,
    ingestTokenFile: traceOn ? tokenFile : null,
    app,
    recovered,
    async close() {
      if (closed) return;
      closed = true;
      tracer?.stop();
      await manager.shutdown();
      db.close();
    },
  };
}
