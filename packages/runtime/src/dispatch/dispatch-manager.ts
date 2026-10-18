/**
 * Task dispatch v1 (plan §4.4): approval-gated, headless Claude Code.
 *
 * 1. preview: the request is checked against the org policy and the exact
 *    argv is built (`claude -p <task> --session-id <uuid> --permission-mode
 *    dontAsk --allowedTools … --model … --max-budget-usd … --output-format
 *    stream-json --verbose [--plugin-dir …]`). It returns a single-use nonce,
 *    kept in memory for 5 minutes and bound to sha256(executable, argv, cwd,
 *    env keys).
 * 2. create (allowed Origin, JSON and the nonce, checked by http/dispatch.ts
 *    and here): the workspace realpath, policy, CLI and digest are checked
 *    again, then the argv runs with shell:false in its own process group with
 *    an allowlisted environment. Nothing spawns any other way (P11).
 * 3. The session is an ordinary traced session: its hooks reach the tracer
 *    and bind to the agent by the pre-assigned session id
 *    (registry.dispatchAgentFor). stream-json output is kept in memory (1 MiB
 *    cap) for the stream; the final `result` is stored as reported.
 * 4. Cancel and the timeout send SIGTERM to the group, then SIGKILL after
 *    10 s. After a restart a dispatch whose process is still alive is
 *    `orphaned` (cancel still works), otherwise it ends `lost`.
 *
 * World commands (agent.dispatch): approved is the user's (source user);
 * running and finished are Runloop's observations (source system). They never
 * carry task text, argv, paths or env. Every step is in audit_log, with ids only.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  DISPATCH_DEFAULTS,
  redactText,
  type CommandEnvelope,
  type DispatchCreateRequest,
  type DispatchErrorCode,
  type DispatchOutcome,
  type DispatchOutputFrame,
  type DispatchPhase,
  type DispatchPolicy,
  type DispatchPolicyResponse,
  type DispatchPreset,
  type DispatchPreview,
  type DispatchPreviewRequest,
  type DispatchStatus,
  type DispatchSummary,
} from '@runloop-world/events';
import type { AgentService, DispatchSignals } from '../agents/service';
import type { AgentRecord } from '../agents/registry';
import { isWithin, pathHintOf, realpathOrNull } from '../agents/local-roots';
import { tx, type Db } from '../store/db';
import type { WorldCommandSink } from '../world/projector';
import { buildArgv, childEnv, needsPluginDir, outcomeOf, parseResultLine, probeClaude, type ClaudeProbe, type ClaudeResult } from './claude-cli';
import { ensurePolicy, readPolicy, resolveRequest } from './policy';

export interface DispatchManagerOptions {
  db: Db;
  agents: AgentService;
  world: WorldCommandSink;
  /** This checkout's integrations/claude-code-plugin, passed as --plugin-dir to a workspace that never sent a hook (null = never). */
  pluginDir: string | null;
  /** The ingest token file the plugin reads (null = tracing is off: no --plugin-dir, no RUNLOOP_* variables). */
  ingestTokenFile: string | null;
  /** RUNLOOP_URL for the plugin; default: the URL the request reached this runtime on. */
  runtimeUrl?: string | null;
  /** The environment the allowlist picks from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** More variable names to pass through (RUNLOOP_DISPATCH_ENV), shown in every preview. */
  passEnv?: readonly string[];
  /** Literal secrets to mask in output and in the stored task. */
  secrets?: readonly string[];
  /** Program name looked up on PATH (default `claude`). */
  claudeBin?: string;
  now?: () => number;
  nonceTtlMs?: number;
  cancelGraceMs?: number;
  orphanPollMs?: number;
  outputCapBytes?: number;
  /** Length of one timeout minute (tests shorten it; default 60 000 ms). */
  timeoutMinuteMs?: number;
  /**
   * Runloop stopped a dispatch (cancel or timeout), so its session will send
   * no SessionEnd. The tracer can close the open run here (inferred); until
   * it does, the run stays open until the idle sweep.
   */
  onStopped?: (s: { sessionId: string; dispatchId: string; outcome: DispatchOutcome }) => void;
  onError?: (err: unknown) => void;
}

export type DispatchFailure = { ok: false; status: 400 | 403 | 404 | 409 | 500; code: DispatchErrorCode; error: string };

const fail = (status: DispatchFailure['status'], code: DispatchErrorCode, error: string): DispatchFailure => ({ ok: false, status, code, error });

/** The task's slot in the stored argv template (the task itself is stored redacted, separately). */
const TASK_SLOT = '{task}';
const KEEP_FINISHED = 10;
const RESULT_TEXT_MAX = 8000;

interface Pending {
  previewId: string;
  agentId: string;
  workspaceId: string;
  cwd: string;
  hint: string;
  executable: string;
  argv: string[];
  digest: string;
  nonceDigest: Buffer;
  expiresAt: number;
  sessionId: string;
  preset: DispatchPreset;
  model: string;
  maxBudgetUsd: number;
  timeoutMin: number;
  allowedTools: string[];
  task: string;
}

type Stream = 'stdout' | 'stderr';

/** A dispatch this process launched (or adopted as orphaned): its process and in-memory output. */
interface Live {
  dispatchId: string;
  agentId: string;
  sessionId: string;
  cwd: string;
  hint: string;
  child: ChildProcess | null;
  pid: number | null;
  orphan: boolean;
  frames: DispatchOutputFrame[];
  bytes: number;
  truncated: boolean;
  partial: Record<Stream, string>;
  skipping: Record<Stream, boolean>;
  decoders: Record<Stream, StringDecoder>;
  result: ClaudeResult | null;
  stop: 'cancel' | 'timeout' | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  spawnError: string | null;
  timers: { timeout?: NodeJS.Timeout; kill?: NodeJS.Timeout; settle?: NodeJS.Timeout; poll?: NodeJS.Timeout };
  wakers: Set<() => void>;
  done: boolean;
  /** World submissions of this dispatch, in order. */
  world: Promise<void>;
}

interface Row {
  dispatch_id: string;
  agent_id: string;
  session_id: string;
  argv_template_json: string;
  task_redacted: string;
  status: DispatchStatus;
  pid: number | null;
  exit_code: number | null;
  cost_usd: number | null;
  outcome: DispatchOutcome | null;
  created_at: string;
  ended_at: string | null;
}

/** argv_template_json: the argv with the task slot, plus what the argv does not carry. */
interface Template {
  argv: string[];
  timeoutMin: number;
  preset: DispatchPreset;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();

/** What the nonce is bound to (plan §4.4). */
export function approvalDigest(executable: string, argv: readonly string[], cwd: string, envKeys: readonly string[]): string {
  return sha256(JSON.stringify([executable, argv, cwd, [...envKeys].sort()])).toString('hex');
}

/** Whether `pid` is alive and is the claude process of this session (its argv carries the session id). */
export function processMatches(pid: number, sessionId: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(sessionId);
    if (process.platform === 'darwin') return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(sessionId);
  } catch {
    return false;
  }
  return true;
}

/** Signal the process group (Unix) or the process (Windows); a group already gone is fine. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // gone
    }
  }
}

const REFUSED_TEXT: Partial<Record<DispatchErrorCode, string>> = {
  preview_unknown: 'That approval is not valid (expired, already used, or Runloop restarted since). Preview the task again.',
  nonce_used: 'That approval was already used. Preview the task again.',
  nonce_expired: 'That approval expired (they last 5 minutes). Preview the task again.',
  bad_nonce: 'That approval does not match the preview. Preview the task again.',
  workspace_moved: "The agent's workspace folder is gone or has moved. Nothing was run.",
  preview_changed: 'What would run is no longer what was previewed (Claude Code or the environment changed). Preview the task again.',
};

export class DispatchManager implements DispatchSignals {
  private readonly db: Db;
  private readonly agents: AgentService;
  private readonly worldSink: WorldCommandSink;
  private readonly opts: DispatchManagerOptions;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly secrets: readonly string[];
  private readonly ttl: number;
  private readonly grace: number;
  private readonly cap: number;
  private readonly onError: (err: unknown) => void;
  private readonly pending = new Map<string, Pending>();
  /** Previews that can no longer be approved, and why (to tell "used" from "expired"). */
  private readonly spent = new Map<string, { why: 'used' | 'expired'; at: number }>();
  private readonly lives = new Map<string, Live>();
  private probeState: ClaudeProbe | { state: 'unprobed'; executable: null; version: null; reason: string } = {
    state: 'unprobed',
    executable: null,
    version: null,
    reason: 'the claude CLI has not been checked yet',
  };
  private probedAt = 0;
  private probing: Promise<void> | null = null;
  private worldChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: DispatchManagerOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.agents = opts.agents;
    this.worldSink = opts.world;
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? process.env;
    this.secrets = opts.secrets ?? [];
    this.ttl = opts.nonceTtlMs ?? DISPATCH_DEFAULTS.nonceTtlMs;
    this.grace = opts.cancelGraceMs ?? DISPATCH_DEFAULTS.cancelGraceMs;
    this.cap = opts.outputCapBytes ?? DISPATCH_DEFAULTS.outputCapBytes;
    this.onError = opts.onError ?? ((err) => console.error('[dispatch]', err));
  }

  /** Write the default policy if none, settle dispatches left by a previous process, probe the CLI. */
  async start(): Promise<void> {
    ensurePolicy(this.db);
    this.agents.setDispatchSignals(this);
    this.reconcile();
    await this.probe();
  }

  /**
   * Stop following processes (they keep their own process group; the next
   * boot finds them orphaned or lost) and wait for world commands in flight.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.agents.setDispatchSignals(null);
    for (const live of this.lives.values()) {
      for (const t of Object.values(live.timers)) clearTimeout(t);
      if (!live.done && live.child) {
        live.child.removeAllListeners();
        live.child.stdout?.removeAllListeners().destroy();
        live.child.stderr?.removeAllListeners().destroy();
        live.child.unref();
      }
      this.wake(live);
    }
    await Promise.allSettled([this.worldChain, ...[...this.lives.values()].map((l) => l.world)]);
  }

  // ── CLI and policy ─────────────────────────────────────────────────

  /** DispatchSignals: the CLI probe as the submit_task capability reads it. */
  cli(): { state: 'unprobed' | 'missing' | 'ok'; reason: string | null } {
    return { state: this.probeState.state, reason: this.probeState.reason };
  }

  /** Run (or re-run) the flag probe. */
  probe(): Promise<void> {
    this.probing ??= probeClaude({ ...(this.opts.claudeBin ? { bin: this.opts.claudeBin } : {}), env: this.env })
      .then((r) => {
        this.probeState = r;
      })
      .catch((err: unknown) => {
        this.probeState = { state: 'missing', executable: null, version: null, reason: `the claude CLI probe failed: ${String(err)}` };
      })
      .finally(() => {
        this.probedAt = this.now();
        this.probing = null;
      });
    return this.probing;
  }

  policy(): DispatchPolicy {
    return readPolicy(this.db);
  }

  policyResponse(): DispatchPolicyResponse {
    const p = this.probeState;
    return { policy: this.policy(), cli: { state: p.state, version: p.version, reason: p.reason } };
  }

  // ── preview and approval ───────────────────────────────────────────

  /** Exactly what would run, and the nonce that approves it. Nothing is spawned. */
  async preview(agentId: string, req: DispatchPreviewRequest, ctx: { runtimeUrl: string | null }): Promise<{ ok: true; preview: DispatchPreview } | DispatchFailure> {
    this.prune();
    const agent = this.agents.registry.get(agentId);
    if (!agent) return fail(404, 'unknown_agent', 'No such agent');
    if (!agent.housed) return fail(409, 'not_housed', 'The agent is not in the town yet');
    if (!agent.workspace) return fail(409, 'no_workspace', 'The agent has no workspace folder');
    const cwd = this.workspaceRoot(agent);
    if (!cwd) return fail(409, 'workspace_moved', REFUSED_TEXT.workspace_moved!);
    const policy = this.policy();
    const r = resolveRequest(policy, req);
    if (!r.ok) return r;
    if (this.probeState.state !== 'ok' && this.now() - this.probedAt > 30_000) await this.probe();
    const cli = this.probeState;
    if (cli.state !== 'ok') return fail(409, 'cli_unavailable', `Claude Code cannot be run: ${cli.reason}`);
    const busy = this.capacity(agentId, policy);
    if (busy) return busy;

    const sessionId = randomUUID();
    const pluginDir = this.pluginDirFor(agent, cwd);
    const argv = buildArgv({ task: req.task.trim(), sessionId, allowedTools: r.allowedTools, model: r.model, maxBudgetUsd: r.maxBudgetUsd, pluginDir });
    const envKeys = Object.keys(this.childEnvFor(ctx.runtimeUrl)).sort();
    const nonce = randomBytes(32).toString('base64url');
    const previewId = `pvw_${randomUUID()}`;
    const expiresAt = this.now() + this.ttl;
    this.pending.set(previewId, {
      previewId,
      agentId,
      workspaceId: agent.workspace.workspaceId,
      cwd,
      hint: agent.workspace.pathHint || pathHintOf(cwd),
      executable: cli.executable,
      argv,
      digest: approvalDigest(cli.executable, argv, cwd, envKeys),
      nonceDigest: sha256(nonce),
      expiresAt,
      sessionId,
      preset: r.preset,
      model: r.model,
      maxBudgetUsd: r.maxBudgetUsd,
      timeoutMin: r.timeoutMin,
      allowedTools: r.allowedTools,
      task: req.task.trim(),
    });
    this.audit('dispatch.previewed', {
      previewId,
      agentId,
      sessionId,
      preset: r.preset,
      model: r.model,
      maxBudgetUsd: r.maxBudgetUsd,
      timeoutMin: r.timeoutMin,
      usesPluginDir: pluginDir !== null,
    });
    return {
      ok: true,
      preview: {
        previewId,
        agentId,
        argv,
        executable: cli.executable,
        cliVersion: cli.version,
        sessionId,
        preset: r.preset,
        workspaceLabel: agent.workspace.label,
        envKeys,
        model: r.model,
        maxBudgetUsd: r.maxBudgetUsd,
        timeoutMin: r.timeoutMin,
        permissionMode: 'dontAsk',
        allowedTools: r.allowedTools,
        usesPluginDir: pluginDir !== null,
        approvalNonce: nonce,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    };
  }

  /**
   * Approve a preview and run it. The nonce is spent by the first attempt,
   * whatever its outcome; every refusal is audited and nothing is spawned.
   * (The route has already required an allowed Origin and a JSON body.)
   */
  async create(req: DispatchCreateRequest, ctx: { runtimeUrl: string | null }): Promise<{ ok: true; dispatch: DispatchSummary } | DispatchFailure> {
    this.prune();
    const refuse = (status: DispatchFailure['status'], code: DispatchErrorCode, error = REFUSED_TEXT[code] ?? code) => {
      this.audit('dispatch.refused', { previewId: req.previewId, code });
      return fail(status, code, error);
    };
    const p = this.pending.get(req.previewId);
    if (!p) {
      const why = this.spent.get(req.previewId)?.why;
      return refuse(409, why === 'expired' ? 'nonce_expired' : why === 'used' ? 'nonce_used' : 'preview_unknown');
    }
    this.pending.delete(req.previewId);
    const given = sha256(req.approvalNonce);
    if (given.length !== p.nonceDigest.length || !timingSafeEqual(given, p.nonceDigest)) {
      this.spend(req.previewId, 'used');
      return refuse(403, 'bad_nonce');
    }
    if (this.now() > p.expiresAt) {
      this.spend(req.previewId, 'expired');
      return refuse(409, 'nonce_expired');
    }
    this.spend(req.previewId, 'used');

    // Re-check what the approval was based on.
    const agent = this.agents.registry.get(p.agentId);
    if (!agent?.housed) return refuse(409, 'not_housed', 'The agent is not in the town any more');
    if (agent.workspace?.workspaceId !== p.workspaceId || this.workspaceRoot(agent) !== p.cwd) return refuse(409, 'workspace_moved');
    const policy = this.policy();
    if (!policy.enabled) return refuse(403, 'blocked_by_policy', "Your organisation's policy no longer allows task dispatch");
    if (this.probeState.state !== 'ok' || this.probeState.executable !== p.executable) return refuse(409, 'cli_unavailable', 'Claude Code cannot be run any more');
    const env = this.childEnvFor(ctx.runtimeUrl);
    if (approvalDigest(p.executable, p.argv, p.cwd, Object.keys(env)) !== p.digest) return refuse(409, 'preview_changed');
    const busy = this.capacity(p.agentId, policy);
    if (busy) {
      this.audit('dispatch.refused', { previewId: req.previewId, code: busy.code });
      return busy;
    }
    return { ok: true, dispatch: this.launch(p, env) };
  }

  // ── read side and cancel ───────────────────────────────────────────

  get(dispatchId: string): DispatchSummary | null {
    const row = this.row(dispatchId);
    return row ? this.summarize(row) : null;
  }

  list(agentId?: string): DispatchSummary[] {
    const rows = (
      agentId
        ? this.db.prepare('SELECT * FROM dispatches WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(agentId)
        : this.db.prepare('SELECT * FROM dispatches ORDER BY created_at DESC, rowid DESC LIMIT 50').all()
    ) as unknown as Row[];
    return rows.map((r) => this.summarize(r));
  }

  /** Output kept in memory (empty after a restart) and whether more can come. */
  output(dispatchId: string): { frames: readonly DispatchOutputFrame[]; done: boolean; status: DispatchStatus; outcome: DispatchOutcome | null } | null {
    const row = this.row(dispatchId);
    if (!row) return null;
    const live = this.lives.get(dispatchId);
    return { frames: live?.frames ?? [], done: !live || live.done || this.stopped, status: row.status, outcome: row.outcome };
  }

  /** Call `fn` on new output or when the dispatch ends. */
  onOutput(dispatchId: string, fn: () => void): () => void {
    const live = this.lives.get(dispatchId);
    if (!live) return () => {};
    live.wakers.add(fn);
    return () => live.wakers.delete(fn);
  }

  /** SIGTERM to the process group now, SIGKILL after the grace period. */
  cancel(dispatchId: string): { ok: true; dispatch: DispatchSummary } | DispatchFailure {
    const row = this.row(dispatchId);
    if (!row) return fail(404, 'unknown_dispatch', 'No such dispatch');
    const live = this.lives.get(dispatchId);
    if (row.status === 'finished' || !live || live.done) return fail(409, 'not_running', 'That task is not running');
    this.terminate(live, 'cancel');
    return { ok: true, dispatch: this.summarize(this.row(dispatchId)!) };
  }

  // ── internals: launching and following ─────────────────────────────

  private launch(p: Pending, env: Record<string, string>): DispatchSummary {
    const dispatchId = `dsp_${randomUUID()}`;
    const template: Template = { argv: p.argv.map((a, i) => (i === 2 ? TASK_SLOT : a)), timeoutMin: p.timeoutMin, preset: p.preset };
    const at = new Date(this.now()).toISOString();
    tx(this.db, () => {
      // Inserted before the spawn, so the session's first hook already finds it and binds by dispatch.
      this.db
        .prepare(
          `INSERT INTO dispatches (dispatch_id, agent_id, session_id, argv_template_json, task_redacted, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(dispatchId, p.agentId, p.sessionId, JSON.stringify(template), this.scrub(p.task, p.cwd, p.hint).slice(0, 4000), at);
      this.audit('dispatch.approved', { dispatchId, previewId: p.previewId, agentId: p.agentId, sessionId: p.sessionId });
    });
    const live = this.track({ dispatchId, agentId: p.agentId, sessionId: p.sessionId, cwd: p.cwd, hint: p.hint, pid: null, orphan: false });
    this.queueWorld(live, 'approved', 'user');

    let child: ChildProcess;
    try {
      child = spawn(p.executable, p.argv.slice(1), {
        cwd: p.cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      live.spawnError = (err as NodeJS.ErrnoException).code ?? 'spawn_error';
      this.finish(live);
      return this.get(dispatchId)!;
    }
    live.child = child;
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (live.pid !== null) return this.onError(err);
      live.spawnError = err.code ?? 'spawn_error';
      this.finish(live);
    });
    if (child.pid !== undefined) {
      live.pid = child.pid;
      this.db.prepare('UPDATE dispatches SET pid = ? WHERE dispatch_id = ?').run(child.pid, dispatchId);
      this.audit('dispatch.spawned', { dispatchId, pid: child.pid });
      this.queueWorld(live, 'running', 'system');
      live.timers.timeout = setTimeout(() => this.terminate(live, 'timeout'), p.timeoutMin * (this.opts.timeoutMinuteMs ?? 60_000));
      live.timers.timeout.unref();
    }
    for (const stream of ['stdout', 'stderr'] as const) child[stream]?.on('data', (chunk: Buffer) => this.onChunk(live, stream, chunk));
    child.once('exit', (code, signal) => {
      live.exit = { code, signal };
      // Normally 'close' follows at once; a leftover process holding the pipes must not keep the dispatch open.
      live.timers.settle = setTimeout(() => this.finish(live), 1000);
      live.timers.settle.unref();
    });
    child.once('close', (code, signal) => {
      live.exit ??= { code, signal };
      this.finish(live);
    });
    this.agents.projector.touch(p.agentId);
    return this.get(dispatchId)!;
  }

  private track(t: Pick<Live, 'dispatchId' | 'agentId' | 'sessionId' | 'cwd' | 'hint' | 'pid' | 'orphan'>): Live {
    const live: Live = {
      ...t,
      child: null,
      frames: [],
      bytes: 0,
      truncated: false,
      partial: { stdout: '', stderr: '' },
      skipping: { stdout: false, stderr: false },
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      result: null,
      stop: null,
      exit: null,
      spawnError: null,
      timers: {},
      wakers: new Set(),
      done: false,
      world: Promise.resolve(),
    };
    this.lives.set(t.dispatchId, live);
    return live;
  }

  private onChunk(live: Live, stream: Stream, chunk: Buffer): void {
    this.feed(live, stream, live.decoders[stream].write(chunk));
  }

  /** Split into lines; a line longer than the cap is dropped whole. */
  private feed(live: Live, stream: Stream, text: string): void {
    let buf = live.partial[stream] + text;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (live.skipping[stream]) live.skipping[stream] = false;
      else this.onLine(live, stream, line);
    }
    if (buf.length > this.cap) {
      buf = '';
      live.skipping[stream] = true;
      live.truncated = true;
    }
    live.partial[stream] = buf;
  }

  private onLine(live: Live, stream: Stream, line: string): void {
    if (!line.trim()) return;
    if (stream === 'stdout') {
      const result = parseResultLine(line);
      if (result) live.result = result;
    }
    const size = Buffer.byteLength(line, 'utf8');
    if (live.bytes + size > this.cap) {
      live.truncated = true;
      return;
    }
    live.bytes += size;
    live.frames.push({ at: new Date(this.now()).toISOString(), stream, line: this.scrub(line, live.cwd, live.hint) });
    this.wake(live);
  }

  private wake(live: Live): void {
    for (const fn of live.wakers) fn();
  }

  /** Cancel or timeout: SIGTERM to the group now, SIGKILL after the grace period. */
  private terminate(live: Live, reason: 'cancel' | 'timeout'): void {
    if (live.done || live.stop) return;
    live.stop = reason;
    this.audit(reason === 'cancel' ? 'dispatch.cancel_requested' : 'dispatch.timed_out', { dispatchId: live.dispatchId });
    if (live.pid === null) return;
    signalGroup(live.pid, 'SIGTERM');
    live.timers.kill = setTimeout(() => {
      if (live.done) return;
      this.audit('dispatch.killed', { dispatchId: live.dispatchId, signal: 'SIGKILL' });
      signalGroup(live.pid!, 'SIGKILL');
    }, this.grace);
    live.timers.kill.unref();
    this.wake(live);
  }

  /** The process ended (or could not start, or an orphan vanished): store the outcome as reported. */
  private finish(live: Live, forced?: DispatchOutcome): void {
    if (live.done || this.stopped) return;
    live.done = true;
    const { timeout, settle, poll, kill } = live.timers;
    for (const t of [timeout, settle, poll, kill]) clearTimeout(t);
    // A stopped task's leftovers in its group go with it.
    if (live.stop && live.pid !== null) signalGroup(live.pid, 'SIGKILL');
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = live.decoders[stream].end();
      if (rest || live.partial[stream]) this.feed(live, stream, `${rest}\n`);
    }
    const outcome =
      forced ?? (live.spawnError ? 'failed' : live.orphan && live.stop === null ? 'lost' : outcomeOf({ result: live.result, exitCode: live.exit?.code ?? null, stop: live.stop }));
    const cost = live.result?.costUsd ?? null;
    tx(this.db, () => {
      this.db
        .prepare(`UPDATE dispatches SET status = 'finished', exit_code = ?, cost_usd = ?, outcome = ?, ended_at = ? WHERE dispatch_id = ?`)
        .run(live.exit?.code ?? null, cost, outcome, new Date(this.now()).toISOString(), live.dispatchId);
      if (live.spawnError) this.audit('dispatch.spawn_failed', { dispatchId: live.dispatchId, error: live.spawnError });
      this.audit('dispatch.exited', {
        dispatchId: live.dispatchId,
        exitCode: live.exit?.code ?? null,
        signal: live.exit?.signal ?? null,
        outcome,
        reportedCostUsd: cost,
      });
    });
    this.queueWorld(live, 'finished', 'system', outcome);
    if (live.stop && (outcome === 'cancelled' || outcome === 'timed_out')) {
      try {
        this.opts.onStopped?.({ sessionId: live.sessionId, dispatchId: live.dispatchId, outcome });
      } catch (err) {
        this.onError(err);
      }
    }
    this.wake(live);
    live.wakers.clear();
    this.agents.projector.touch(live.agentId);
    const finished = [...this.lives.values()].filter((l) => l.done);
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.lives.delete(old.dispatchId);
  }

  /**
   * Boot: a dispatch still marked running belongs to a previous process.
   * Alive (and still this session's claude) = orphaned, followed until it
   * ends; otherwise lost.
   */
  private reconcile(): void {
    const rows = this.db.prepare(`SELECT * FROM dispatches WHERE status IN ('running', 'orphaned')`).all() as unknown as Row[];
    for (const row of rows) {
      if (this.lives.has(row.dispatch_id)) continue;
      if (row.pid !== null && processMatches(row.pid, row.session_id)) {
        if (row.status !== 'orphaned') {
          this.db.prepare(`UPDATE dispatches SET status = 'orphaned' WHERE dispatch_id = ?`).run(row.dispatch_id);
          this.audit('dispatch.orphaned', { dispatchId: row.dispatch_id, pid: row.pid });
        }
        const agent = this.agents.registry.get(row.agent_id);
        const cwd = agent ? this.workspaceRoot(agent) : null;
        const live = this.track({
          dispatchId: row.dispatch_id,
          agentId: row.agent_id,
          sessionId: row.session_id,
          cwd: cwd ?? '',
          hint: agent?.workspace?.pathHint ?? '',
          pid: row.pid,
          orphan: true,
        });
        const poll = () => {
          if (live.done) return;
          if (!processMatches(row.pid!, row.session_id)) return this.finish(live);
          live.timers.poll = setTimeout(poll, this.opts.orphanPollMs ?? 2000);
          live.timers.poll.unref();
        };
        poll();
      } else {
        const at = new Date(this.now()).toISOString();
        tx(this.db, () => {
          this.db.prepare(`UPDATE dispatches SET status = 'finished', outcome = 'lost', ended_at = ? WHERE dispatch_id = ?`).run(at, row.dispatch_id);
          this.audit('dispatch.lost', { dispatchId: row.dispatch_id });
        });
        this.worldChain = this.worldChain.then(() => this.submitWorld(row.agent_id, row.dispatch_id, 'finished', 'system', 'lost'));
      }
    }
  }

  // ── internals: helpers ─────────────────────────────────────────────

  private queueWorld(live: Live, phase: DispatchPhase, source: 'user' | 'system', outcome?: DispatchOutcome): void {
    live.world = live.world.then(() => this.submitWorld(live.agentId, live.dispatchId, phase, source, outcome));
  }

  private async submitWorld(agentId: string, dispatchId: string, phase: DispatchPhase, source: 'user' | 'system', outcome?: DispatchOutcome): Promise<void> {
    const env: CommandEnvelope = {
      id: `dsp:${dispatchId}:${phase}`,
      source,
      command: { type: 'agent.dispatch', agentId, dispatchId, phase, ...(outcome ? { outcome } : {}) },
    };
    try {
      const r = await this.worldSink.submit(env);
      if (!r.ok) this.onError(new Error(`The world refused ${env.id}: ${r.code}`));
    } catch (err) {
      this.onError(err);
    }
  }

  /** The agent's root, if it still resolves to itself and is a folder (null = gone or moved). */
  private workspaceRoot(agent: AgentRecord): string | null {
    const root = agent.workspace ? this.agents.roots.rootOf(agent.workspace.workspaceId) : null;
    if (!root || realpathOrNull(root) !== root) return null;
    try {
      return statSync(root).isDirectory() ? root : null;
    } catch {
      return null;
    }
  }

  /**
   * --plugin-dir unless Claude Code has the tracer installed (it would report
   * twice); see needsPluginDir. Inside the workspace (Runloop's own checkout)
   * it is passed relative to it, so the argv never carries the workspace path (P8).
   */
  private pluginDirFor(agent: AgentRecord, cwd: string): string | null {
    const dir = this.opts.pluginDir;
    if (!dir || !this.opts.ingestTokenFile) return null;
    const sentHook = agent.firstEventAt !== null || agent.lastEnvelopeAt !== null || this.agents.registry.sessionCount(agent.agentId) > 0;
    const tracer = this.probeState.state === 'ok' ? this.probeState.tracerPlugin : 'unknown';
    if (!needsPluginDir(tracer, sentHook)) return null;
    return isWithin(dir, cwd) ? `.${path.sep}${path.relative(cwd, dir)}` : dir;
  }

  private childEnvFor(requestUrl: string | null): Record<string, string> {
    const tracing = this.opts.ingestTokenFile !== null;
    return childEnv(this.env, {
      runtimeUrl: tracing ? (this.opts.runtimeUrl ?? requestUrl) : null,
      tokenFile: this.opts.ingestTokenFile,
      ...(this.opts.passEnv ? { passEnv: this.opts.passEnv } : {}),
    });
  }

  private capacity(agentId: string, policy: DispatchPolicy): DispatchFailure | null {
    const rows = this.db.prepare(`SELECT agent_id FROM dispatches WHERE status IN ('running', 'orphaned')`).all() as { agent_id: string }[];
    if (rows.filter((r) => r.agent_id === agentId).length >= policy.maxRunningPerAgent) {
      return fail(409, 'dispatch_running', 'This agent is already running a task. Wait for it to finish or cancel it.');
    }
    if (rows.length >= policy.maxRunningTotal) return fail(409, 'dispatch_running', `${rows.length} tasks are already running, the most the policy allows.`);
    return null;
  }

  /** Mask secrets, and shorten the workspace path to its hint (P8). */
  private scrub(text: string, cwd: string, hint: string): string {
    let out = redactText(text, { secrets: this.secrets });
    if (cwd.length > 1) {
      out = out.split(cwd).join(hint);
      const escaped = JSON.stringify(cwd).slice(1, -1);
      if (escaped !== cwd) out = out.split(escaped).join(JSON.stringify(hint).slice(1, -1));
    }
    return out;
  }

  private spend(previewId: string, why: 'used' | 'expired'): void {
    this.spent.set(previewId, { why, at: this.now() });
  }

  /** Expired previews become tombstones; tombstones are forgotten after a while. */
  private prune(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (now > p.expiresAt) {
        this.pending.delete(id);
        this.spend(id, 'expired');
      }
    }
    for (const [id, s] of this.spent) if (now - s.at > 2 * this.ttl || this.spent.size > 1000) this.spent.delete(id);
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    if (!this.db.isOpen) return;
    this.agents.registry.audit(action, detail);
  }

  private row(dispatchId: string): Row | null {
    return (this.db.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(dispatchId) as Row | undefined) ?? null;
  }

  private summarize(row: Row): DispatchSummary {
    const t = parseTemplate(row.argv_template_json);
    const live = this.lives.get(row.dispatch_id);
    const after = (flag: string) => {
      const i = t.argv.indexOf(flag);
      return i >= 0 ? (t.argv[i + 1] ?? null) : null;
    };
    const tools = t.argv.indexOf('--allowedTools');
    const model = t.argv.indexOf('--model');
    const run = this.db
      .prepare(`SELECT run_id FROM runs WHERE source_kind = 'claude-code' AND external_session_id = ? ORDER BY segment LIMIT 1`)
      .get(row.session_id) as { run_id: string } | undefined;
    const text = live?.result?.text ?? null;
    return {
      dispatchId: row.dispatch_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      runId: run?.run_id ?? null,
      status: row.status,
      outcome: row.outcome,
      exitCode: row.exit_code,
      reportedCostUsd: row.cost_usd,
      reportedTurns: live?.result?.numTurns ?? null,
      resultText: text === null ? null : this.scrub(text, live!.cwd, live!.hint).slice(0, RESULT_TEXT_MAX),
      model: after('--model') ?? 'unknown',
      allowedTools: tools >= 0 && model > tools ? t.argv.slice(tools + 1, model) : [],
      maxBudgetUsd: Number(after('--max-budget-usd') ?? 0),
      timeoutMin: t.timeoutMin,
      stopping: !!live && !live.done && live.stop !== null,
      outputTruncated: live?.truncated ?? false,
      taskPreview: row.task_redacted.length > 200 ? `${row.task_redacted.slice(0, 199)}…` : row.task_redacted,
      startedAt: row.created_at,
      endedAt: row.ended_at,
    };
  }
}

/**
 * The manager as runtime.ts wires it, or null when RUNLOOP_DISPATCH=off.
 * --plugin-dir is this checkout's plugin; RUNLOOP_DISPATCH_ENV lists extra
 * variable names to pass through (e.g. HTTPS_PROXY,NODE_EXTRA_CA_CERTS).
 */
export function createDispatchManager(o: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  db: Db;
  agents: AgentService;
  world: WorldCommandSink;
  ingestTokenFile: string | null;
  secrets?: readonly string[];
  runtimeUrl?: string | null;
  onStopped?: DispatchManagerOptions['onStopped'];
}): DispatchManager | null {
  if (o.env.RUNLOOP_DISPATCH?.trim().toLowerCase() === 'off') return null;
  const pluginDir = path.join(o.repoRoot, 'integrations', 'claude-code-plugin');
  return new DispatchManager({
    db: o.db,
    agents: o.agents,
    world: o.world,
    pluginDir: existsSync(path.join(pluginDir, 'hooks', 'hooks.json')) ? pluginDir : null,
    ingestTokenFile: o.ingestTokenFile,
    env: o.env,
    passEnv: (o.env.RUNLOOP_DISPATCH_ENV ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.runtimeUrl !== undefined ? { runtimeUrl: o.runtimeUrl } : {}),
    ...(o.onStopped ? { onStopped: o.onStopped } : {}),
    onError: (err) => console.error('[dispatch]', err),
  });
}

function parseTemplate(json: string): Template {
  try {
    const t = JSON.parse(json) as Partial<Template>;
    return { argv: Array.isArray(t.argv) ? t.argv.map(String) : [], timeoutMin: Number(t.timeoutMin) || DISPATCH_DEFAULTS.timeoutMin, preset: t.preset ?? 'read_only' };
  } catch {
    return { argv: [], timeoutMin: DISPATCH_DEFAULTS.timeoutMin, preset: 'read_only' };
  }
}
