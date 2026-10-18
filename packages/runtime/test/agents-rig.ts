/** In-process rig for the agent layer: recorder + tracer + AgentService on a fake world host and a manual clock. */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { CommandEnvelope, RunEvent, ToolCategory, WorldEvent } from '@runloop-world/events';
import { expect } from 'vitest';
import { AgentService } from '../src/agents/service';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import type { HookEnvelope } from '../src/tracers/claude-code/hook-input';
import type { Recorder } from '../src/recorder';
import { envelopeOf, readFixture, type FixtureLine } from './claude-code-helpers';
import { openRecorder, tempDir } from './helpers';
import { FakeWorldHost, ManualClock } from './world-fakes';

/** The sanitised fixtures ran in this folder. */
export const FIXTURE_CWD = '/home/dev/demo';

/** A fixture as if it ran in `cwd` (every occurrence of the sanitised project path rewritten), optionally under another session id. */
export function fixtureIn(name: string, cwd: string, sessionId?: string): FixtureLine[] {
  return readFixture(name).map((l) => {
    let input = JSON.parse(JSON.stringify(l.input).split(FIXTURE_CWD).join(cwd)) as Record<string, unknown>;
    if (sessionId) input = { ...input, session_id: sessionId };
    return { ...l, input };
  });
}

/** A real folder to register as a workspace root (realpath). */
export function makeRepo(label = 'repo'): string {
  const dir = path.join(tempDir(`agents-${label}`), 'code', label);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  return realpathSync(dir);
}

/** Records when each command was submitted (wall ms of the manual clock). */
export class TimedHost extends FakeWorldHost {
  readonly submittedAt = new Map<string, number>();
  clock: ManualClock | null = null;

  override submit(env: CommandEnvelope) {
    if (!this.submittedAt.has(env.id)) this.submittedAt.set(env.id, this.clock?.now() ?? 0);
    return super.submit(env);
  }
}

export interface Rig {
  dataDir: string;
  clock: ManualClock;
  host: TimedHost;
  recorder: Recorder;
  tracer: TraceSessionManager;
  agents: AgentService;
  rejected: { id: string; code: string }[];
  /** Ingest fixture lines one at a time, moving the clock by their recorded gaps; flushes the projector. */
  play(name: string, lines: readonly FixtureLine[]): Promise<void>;
  settle(ms?: number): Promise<void>;
  /** Graceful stop, then close the database. */
  close(): Promise<void>;
  /** Stop without flushing anything (a crash), then close the database. */
  crash(): void;
}

export async function makeRig(opts: { dataDir?: string; host?: TimedHost; clock?: ManualClock } = {}): Promise<Rig> {
  const dataDir = opts.dataDir ?? tempDir('agents-rig');
  const clock = opts.clock ?? new ManualClock();
  const host = opts.host ?? new TimedHost();
  host.clock = clock;
  const { recorder, db } = openRecorder(dataDir, { now: () => new Date(clock.now()) });
  recorder.recoverInterrupted();
  const rejected: { id: string; code: string }[] = [];
  const fail = (err: unknown) => {
    throw err;
  };
  const agents = new AgentService({
    db,
    recorder,
    world: host,
    dataDir,
    ingestOn: true,
    clock,
    onRejected: (env, code) => rejected.push({ id: env.id, code }),
    onError: fail,
  });
  const tracer = new TraceSessionManager({
    recorder,
    db,
    now: () => new Date(clock.now()),
    onError: fail,
    onSessionSeen: (s) => agents.onSessionSeen(s),
  });
  await agents.start();
  const settle = async (ms = 0) => {
    clock.advance(ms);
    await agents.projector.idle();
  };
  let lastT: number | null = null;
  return {
    dataDir,
    clock,
    host,
    recorder,
    tracer,
    agents,
    rejected,
    async play(name, lines) {
      for (const [i, line] of lines.entries()) {
        if (lastT !== null) clock.advance(Math.max(0, line.t - lastT));
        lastT = line.t;
        const env: HookEnvelope = { ...envelopeOf(name, line, i), observedAt: new Date(clock.now()).toISOString() };
        tracer.ingest([env]);
        await settle(0);
      }
    },
    settle,
    async close() {
      if (!db.isOpen) return;
      await agents.stop();
      db.close();
    },
    crash() {
      if (!db.isOpen) return;
      void agents.projector.stop();
      tracer.stop();
      db.close();
    },
  };
}

/** tool.call_started events by category in [from, to] of a run (P4). */
export function callsIn(events: readonly RunEvent[], from: number, to: number): Partial<Record<ToolCategory, number>> {
  const out: Partial<Record<ToolCategory, number>> = {};
  for (const e of events) {
    if (e.sequence < from || e.sequence > to || e.type !== 'tool.call_started') continue;
    const c = e.payload.category ?? 'other';
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

/**
 * P4: every agent event's cause points into a run bound to that agent, and an
 * activity's counts equal that range's tool calls. P1: session and activity
 * events are external-agent (observed) or inferred.
 */
export function expectTruthful(events: readonly WorldEvent[], recorder: Recorder, agentOfSession: (sessionId: string) => string | null): void {
  for (const e of events) {
    if (e.type !== 'agent.session_changed' && e.type !== 'agent.activity_observed') continue;
    expect(['external-agent', 'inferred']).toContain(e.prov);
    if (e.prov === 'external-agent') expect(e.obs).toBe('observed');
    const cause = e.cause!;
    expect(cause.runId).toBe(e.p.runId);
    const run = recorder.getRun(cause.runId)!;
    expect(run, `run ${cause.runId}`).toBeTruthy();
    expect(agentOfSession(run.source!.sessionId)).toBe(e.p.agentId);
    expect(cause.seqTo).toBeLessThanOrEqual(run.lastSequence);
    if (e.type === 'agent.activity_observed') {
      expect(e.p.counts).toEqual(callsIn(recorder.listAll(cause.runId), cause.seqFrom, cause.seqTo));
    }
  }
}
