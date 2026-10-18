import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { AgentAdapter } from './adapter';
import { AgentService } from './agents/service';
import { collectEnvSecrets, findRepoRoot, resolveAllowedOrigins, resolveDataDir } from './config';
import { createDispatchManager, type DispatchManager } from './dispatch/dispatch-manager';
import { mountAgentRoutes } from './http/agents';
import { createApp } from './http/app';
import { mountDispatchRoutes } from './http/dispatch';
import type { IngestRouteOptions } from './http/ingest';
import { mountWorldRoutes } from './http/world';
import { ensureIngestToken, resolveIngestTokenFile } from './ingest-token';
import { Recorder } from './recorder';
import { RunManager } from './run-manager';
import { openDb, type Db } from './store/db';
import { TraceSessionManager } from './tracers/claude-code/session-manager';
import { readTownFiles } from './world/town-files';
import { WorldHost } from './world/world-host';

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
  world?: WorldOptions;
}

/** The town simulation (plan §4.1). */
export interface WorldOptions {
  /** Default: on, unless RUNLOOP_WORLD=off (then every /api/world route answers 404). */
  enabled?: boolean;
  /** Seed and population of a new world (an existing world keeps its own). */
  seed?: number;
  population?: number;
  /** Town directory under worldsDir (default runloop-commons). */
  townId?: string;
  /** Wall clock (ms since the epoch) and wake interval, for tests. */
  now?: () => number;
  tickMs?: number;
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
  /** The town simulation; null when RUNLOOP_WORLD=off. */
  world: WorldHost | null;
  /** Real agents in the town (Add to World, bindings, projector); null when the world is off. */
  agents: AgentService | null;
  /** Task dispatch to Claude Code (S4); null when the world is off or RUNLOOP_DISPATCH=off. */
  dispatch: DispatchManager | null;
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
  // Created after the tracer (it needs the world); the tracer's hook reads it lazily.
  let agents: AgentService | null = null;
  if (traceOn) {
    token = ensureIngestToken(tokenFile);
    const idle = trace.idleMinutes ?? Number(env.RUNLOOP_TRACE_IDLE_MINUTES ?? 120);
    tracer = new TraceSessionManager({
      recorder,
      db,
      ctx: { idleMinutes: Number.isFinite(idle) && idle > 0 ? idle : 120 },
      secrets,
      ...(trace.now ? { now: trace.now } : {}),
      onSessionSeen: (seen) => agents?.onSessionSeen(seen),
      onError: (err) => console.error('[tracer]', err),
    });
    tracer.start(trace.sweepMs ?? 60_000);
  }
  const allowedOrigins = opts.allowedOrigins ?? resolveAllowedOrigins(env);
  const app = createApp({
    recorder,
    manager,
    worldsDir: opts.worldsDir ?? path.join(repoRoot, 'worlds'),
    allowedOrigins,
    ...(opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}),
    tracer: tracer && token ? { manager: tracer, token, ...(trace.rate ? { rate: trace.rate } : {}) } : null,
  });
  const worldOpts = opts.world ?? {};
  const worldOn = worldOpts.enabled ?? env.RUNLOOP_WORLD?.trim().toLowerCase() !== 'off';
  const world = worldOn
    ? new WorldHost({
        db,
        town: readTownFiles(opts.worldsDir ?? path.join(repoRoot, 'worlds'), worldOpts.townId),
        now: worldOpts.now ?? Date.now,
        ...(worldOpts.seed !== undefined ? { seed: worldOpts.seed } : {}),
        ...(worldOpts.population !== undefined ? { population: worldOpts.population } : {}),
        ...(worldOpts.tickMs !== undefined ? { tickMs: worldOpts.tickMs } : {}),
        onError: (err) => console.error('[world]', err),
      })
    : null;
  mountWorldRoutes(app, { host: world });
  // Agents and dispatch live in the world: with RUNLOOP_WORLD=off their routes answer 404.
  let dispatch: DispatchManager | null = null;
  if (world) {
    agents = new AgentService({ db, recorder, world, dataDir, ingestOn: tracer !== null, onError: (err) => console.error('[agents]', err) });
    dispatch = createDispatchManager({
      env,
      repoRoot,
      db,
      agents,
      world,
      ingestTokenFile: traceOn ? tokenFile : null,
      secrets,
      // A cancelled or timed-out session sends no SessionEnd: close its run (inferred).
      onStopped: ({ sessionId }) => void tracer?.closeStopped(sessionId),
    });
  }
  mountAgentRoutes(app, agents);
  mountDispatchRoutes(app, { dispatch, allowedOrigins });
  world?.start();
  const agentsReady = (async () => {
    await agents?.start();
    await dispatch?.start();
  })().catch((err) => console.error('[agents]', err));
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
    world,
    agents,
    dispatch,
    async close() {
      if (closed) return;
      closed = true;
      tracer?.stop();
      await agentsReady;
      // Dispatch and agents submit to the world, which refuses commands once stopped.
      await dispatch?.stop();
      await agents?.stop();
      await manager.shutdown();
      await world?.stop();
      db.close();
    },
  };
}
