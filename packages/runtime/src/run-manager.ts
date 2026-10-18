import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PayloadOf, RunSummary } from '@runloop-world/events';
import {
  abortError,
  isAdapterEventType,
  type AdapterResult,
  type AgentAdapter,
  type RunContext,
} from './adapter';
import { scriptedCodingMission } from './adapters/scripted-coding-mission';
import { loadMission, type Mission } from './mission';
import { UnknownRunError, type Recorder } from './recorder';
import { ToolInvoker } from './tool-invoker';

export interface RunManagerOptions {
  recorder: Recorder;
  dataDir: string;
  /** Directory holding `<missionId>/mission.json` (the repo's `examples/`). */
  missionsDir: string;
  /** Adapters by id; defaults to the scripted coding-mission adapter. */
  adapters?: readonly AgentAdapter[];
  commandTimeoutMs?: number;
  onError?: (err: unknown) => void;
}

export interface StartRunOptions {
  missionId: string;
  /** Pacing multiplier; 0 = no delays. Default 1. */
  speed?: number;
}

/** Another run is active (HTTP 409). */
export class RunConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super(`Run ${activeRunId} is still active`);
  }
}

/** The run exists but is not the active run (HTTP 409). */
export class RunNotActiveError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} is not active`);
  }
}

/** Resolves waiters when resumed; rejects them when the run is stopped. */
class PauseGate {
  paused = false;
  private waiters: (() => void)[] = [];

  wait(signal: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  resume(): void {
    this.paused = false;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  gate: PauseGate;
  stopReason?: string;
}

/**
 * Owns the lifecycle of runs: creates the workspace, emits run.started /
 * run.paused / run.resumed / run.completed, and drives the adapter. One active
 * run at a time.
 */
export class RunManager {
  private readonly recorder: Recorder;
  private readonly adapters: Map<string, AgentAdapter>;
  private active: ActiveRun | null = null;
  private readonly done = new Map<string, Promise<RunSummary>>();

  constructor(private readonly opts: RunManagerOptions) {
    this.recorder = opts.recorder;
    this.adapters = new Map((opts.adapters ?? [scriptedCodingMission]).map((a) => [a.info.id, a]));
  }

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /** Start a run; returns once run.started is recorded. The adapter runs in the background. */
  start(req: StartRunOptions): { runId: string } {
    if (this.active) throw new RunConflictError(this.active.runId);
    const mission = loadMission(this.opts.missionsDir, req.missionId);
    const adapter = this.adapters.get(mission.adapter);
    if (!adapter) throw new Error(`Mission ${mission.id} needs adapter "${mission.adapter}", which is not registered`);
    const speed = req.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0) throw new Error('speed must be a number ≥ 0');

    const runId = randomUUID();
    const workspace = `workspaces/${runId}`;
    const workspaceDir = path.join(this.opts.dataDir, workspace);
    mkdirSync(path.dirname(workspaceDir), { recursive: true });
    // Only repo/ is copied: the mission's script/ never enters the workspace.
    cpSync(mission.repoDir, workspaceDir, {
      recursive: true,
      errorOnExist: true,
      filter: (src) => !['node_modules', '.git'].includes(path.basename(src)),
    });

    this.recorder.createRun({
      runId,
      manifest: {
        title: mission.title,
        missionId: mission.id,
        worldId: mission.worldId,
        seed: mission.seed,
        adapter: { ...adapter.info },
        workspace,
        speed,
      },
    });

    const active: ActiveRun = { runId, controller: new AbortController(), gate: new PauseGate() };
    this.active = active;
    const ctx = this.context(active, workspaceDir, speed);
    this.done.set(runId, this.drive(active, adapter, ctx, mission));
    return { runId };
  }

  /** Resolves with the final summary once the run has completed (any outcome). */
  async whenDone(runId: string): Promise<RunSummary> {
    const p = this.done.get(runId);
    if (p) return p;
    const run = this.recorder.getRun(runId);
    if (!run) throw new UnknownRunError(runId);
    return run;
  }

  stop(runId: string, reason = 'Stopped by request'): RunSummary {
    const a = this.requireActive(runId);
    a.stopReason ??= reason;
    a.controller.abort();
    return this.summary(runId);
  }

  pause(runId: string): RunSummary {
    const a = this.requireActive(runId);
    if (!a.gate.paused) {
      this.recorder.append(runId, { type: 'run.paused', payload: { reason: 'Paused by request' }, actorId: 'system' });
      a.gate.paused = true;
    }
    return this.summary(runId);
  }

  resume(runId: string): RunSummary {
    const a = this.requireActive(runId);
    if (a.gate.paused) {
      this.recorder.append(runId, { type: 'run.resumed', payload: {}, actorId: 'system' });
      a.gate.resume();
    }
    return this.summary(runId);
  }

  /** Stop the active run (if any) and wait for it to finish. */
  async shutdown(reason = 'The runtime is shutting down'): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.stop(a.runId, reason);
    await this.done.get(a.runId);
  }

  // ── internals ───────────────────────────────────────────────────

  private context(active: ActiveRun, workspaceDir: string, speed: number): RunContext {
    const { recorder } = this;
    const { runId, controller, gate } = active;
    const signal = controller.signal;
    const invoker = new ToolInvoker({
      recorder,
      runId,
      workspaceDir,
      signal,
      ...(this.opts.commandTimeoutMs !== undefined ? { commandTimeoutMs: this.opts.commandTimeoutMs } : {}),
    });
    return {
      runId,
      signal,
      speed,
      emit(type, payload, meta) {
        if (signal.aborted) throw abortError();
        if (!isAdapterEventType(type)) throw new Error(`Adapters may not emit ${type}`);
        if (type === 'task.completed') {
          // A completion may only cite artifacts the tool invoker actually recorded in this run.
          const cited = (payload as PayloadOf<'task.completed'>).artifactIds;
          const unknown = cited.filter((id) => !recorder.hasArtifact(runId, id));
          if (unknown.length > 0) throw new Error(`task.completed cites artifacts not recorded in this run: ${unknown.join(', ')}`);
        }
        // The generic draft type cannot be narrowed from T here; the recorder validates strictly.
        return recorder.append(runId, { type, payload, ...meta } as never);
      },
      tools: { invoke: (agentId, taskId, call) => invoker.invoke(agentId, taskId, call) },
      async pace(ms) {
        if (signal.aborted) throw abortError();
        const scaled = speed > 0 ? ms / speed : 0;
        if (scaled > 0) await sleep(scaled, signal);
        // At speed 0, still yield to the event loop so HTTP requests (stop, pause) get through.
        else await new Promise<void>((r) => setImmediate(r));
        await gate.wait(signal);
        if (signal.aborted) throw abortError();
      },
    };
  }

  private async drive(active: ActiveRun, adapter: AgentAdapter, ctx: RunContext, mission: Mission): Promise<RunSummary> {
    const { runId, controller } = active;
    let completion: AdapterResult | { outcome: 'stopped'; summary: string };
    try {
      const result = await adapter.run(ctx, mission);
      completion = controller.signal.aborted ? { outcome: 'stopped', summary: active.stopReason ?? 'Stopped' } : result;
    } catch (err) {
      if (controller.signal.aborted) {
        completion = { outcome: 'stopped', summary: active.stopReason ?? 'Stopped' };
      } else {
        this.opts.onError?.(err);
        completion = { outcome: 'failed', summary: `Adapter error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    // Free the slot before recording completion, so listeners reacting to
    // run.completed can start the next run.
    if (this.active === active) this.active = null;
    try {
      this.recorder.append(runId, { type: 'run.completed', payload: completion, actorId: 'system' });
    } catch (err) {
      this.opts.onError?.(err);
    }
    return this.summary(runId);
  }

  private requireActive(runId: string): ActiveRun {
    if (this.active?.runId === runId) return this.active;
    if (!this.recorder.getRun(runId)) throw new UnknownRunError(runId);
    throw new RunNotActiveError(runId);
  }

  private summary(runId: string): RunSummary {
    const run = this.recorder.getRun(runId);
    if (!run) throw new UnknownRunError(runId);
    return run;
  }
}
