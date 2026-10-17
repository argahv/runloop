/** Helpers for the Claude Code tracer tests (fixtures → envelopes → recorded runs). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeCodeHookEnvelope, RunEvent } from '@runloop-world/events';
import { loadWorld, type CompiledWorld } from '@runloop-world/world-engine';
import type { HookEnvelope } from '../src/tracers/claude-code/hook-input';
import { TraceSessionManager } from '../src/tracers/claude-code/session-manager';
import { REPO_ROOT, openRecorder } from './helpers';

export const FIXTURE_DIR = path.join(REPO_ROOT, 'packages', 'runtime', 'test', 'fixtures', 'claude-code');

/** Real (sanitised) probe sessions, then hand-written synthetic edge cases. */
export const REAL_FIXTURES = ['s1-basic', 's2-subagents', 's3-async'] as const;
export const SYNTHETIC_FIXTURES = [
  'synthetic-post-before-pre',
  'synthetic-out-of-order',
  'synthetic-permission-denied-then-stop',
  'synthetic-no-session-end',
] as const;
export const ALL_FIXTURES = [...REAL_FIXTURES, ...SYNTHETIC_FIXTURES];

/** One logged hook invocation: `input` is the hook's raw stdin JSON. */
export interface FixtureLine {
  t: number;
  pid: number;
  ppid: number;
  argv: string[];
  synthetic?: boolean;
  input: Record<string, unknown>;
}

export function readFixture(name: string): FixtureLine[] {
  return readFileSync(path.join(FIXTURE_DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FixtureLine);
}

/** The envelope the plugin would send for a fixture line (deterministic delivery id and time). */
export function envelopeOf(name: string, line: FixtureLine, index: number): HookEnvelope {
  const env: ClaudeCodeHookEnvelope = {
    v: 1,
    deliveryId: `fx-${name}-${index}`,
    observedAt: new Date(line.t).toISOString(),
    ppid: line.ppid,
    plugin: { name: 'runloop-tracer', version: 'fixture' },
    hook: line.input,
  };
  return env as HookEnvelope;
}

/** Deterministic event ids (UUID v4 shaped) so recorded runs render identically every time. */
export function sequentialIds(prefix = 1): () => string {
  let n = 0;
  return () => `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
}

export const world: CompiledWorld = loadWorld(JSON.parse(readFileSync(path.join(REPO_ROOT, 'worlds', 'research-campus', 'world.json'), 'utf8')));

/**
 * Fold a fixture through a TraceSessionManager into a fresh recorder (one
 * envelope per ingest call, like the plugin), then sweep a long time later
 * so a session without SessionEnd closes too. Returns each traced run's events.
 */
export function recordFixture(name: string, dataDir: string): { runs: RunEvent[][]; outcomes: { accepted: number; duplicates: number; ignored: number } } {
  const lines = readFixture(name);
  const lastMs = lines.at(-1)!.t;
  const { recorder, db } = openRecorder(dataDir, { now: () => new Date(lastMs + 30 * 24 * 3600_000) });
  // Deterministic ids: the recorder's newId is private, so build it with one.
  (recorder as unknown as { newId: () => string }).newId = sequentialIds();
  const manager = new TraceSessionManager({ recorder, db, now: () => new Date(lastMs), onError: (err) => { throw err; } });
  const outcomes = { accepted: 0, duplicates: 0, ignored: 0 };
  lines.forEach((line, i) => {
    const r = manager.ingest([envelopeOf(name, line, i)]);
    outcomes.accepted += r.accepted;
    outcomes.duplicates += r.duplicates;
    outcomes.ignored += r.ignored;
  });
  manager.sweepIdle(new Date(lastMs + 3 * 24 * 3600_000));
  const runs = recorder
    .listRuns()
    .filter((r) => r.mode === 'traced')
    .sort((a, b) => (a.source?.segment ?? 0) - (b.source?.segment ?? 0))
    .map((r) => recorder.listAll(r.runId));
  db.close();
  return { runs, outcomes };
}

/** One line per event: sequence, type, actor, task, provenance, visibility, parent sequence, payload. */
export function renderRun(events: readonly RunEvent[]): string {
  const seqOf = new Map(events.map((e) => [e.eventId, e.sequence]));
  return events
    .map((e) => {
      const parent = e.parentEventId ? `^${seqOf.get(e.parentEventId) ?? '?'}` : '-';
      const head = [
        `#${String(e.sequence).padStart(3, '0')}`,
        e.type,
        e.actorId ?? '-',
        e.taskId ?? '-',
        e.provenance ?? 'native',
        e.visibility,
        parent,
      ].join(' ');
      return `${head} ${JSON.stringify(e.payload)}`;
    })
    .join('\n');
}

/** Run events without volatile fields, for comparing two recordings of the same session. */
export function comparable(events: readonly RunEvent[]): unknown[] {
  const seqOf = new Map(events.map((e) => [e.eventId, e.sequence]));
  return events.map((e) => {
    const payload = { ...(e.payload as Record<string, unknown>) };
    // Inferred closes are timed by when Runloop noticed, which differs between deliveries.
    if (e.provenance === 'inferred' && 'durationMs' in payload) payload.durationMs = '(inferred)';
    if (e.type === 'run.started') {
      const source = { ...(payload.source as Record<string, unknown>) };
      delete source.pluginVersion;
      payload.source = source;
    }
    return {
      sequence: e.sequence,
      type: e.type,
      actorId: e.actorId ?? null,
      taskId: e.taskId ?? null,
      provenance: e.provenance ?? null,
      visibility: e.visibility,
      parent: e.parentEventId ? (seqOf.get(e.parentEventId) ?? '?') : null,
      payload,
    };
  });
}
