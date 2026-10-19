/**
 * session-events.json: real, recorded Claude Code sessions as Runloop records and shows them, for
 * the film's event layer (B). PLACEHOLDER DATA: the live capture (one real Haiku session, made after the
 * Studio's immersive rework) replaces it: re-run this exporter with --primary <capture hook log .jsonl>.
 *
 *   npx tsx tools/export-session.ts [--primary s1-basic | path/to/capture.jsonl] [--secondary s2-subagents | path.jsonl]
 *   (a capture's log uses the fixtures' line format: {t, pid, ppid, argv, input}, sanitised like them)
 *
 * Path, all through the product's own code (read-only):
 * 1. the sanitised hook logs in packages/runtime/test/fixtures/claude-code/<name>.jsonl (real `claude -p`
 *    Haiku sessions, Claude Code 2.1.302, 2026-10-17), one envelope per hook, exactly as the plugin sends it;
 * 2. TraceSessionManager + Recorder (the runtime's ingest: mapper, redaction, SQLite recorder) into a
 *    throw-away data dir, as packages/runtime/test/claude-code-helpers.ts recordFixture does;
 * 3. reduceRun (packages/replay: Layer-1 execution + Layer-2 world) on worlds/research-campus, the agent
 *    HQ's interior, so every tool call lands in the room the product puts it in (activityRules);
 * 4. the world projector's activityOf + deriveAttention: what the town shows on the agent's building;
 * 5. core summarizeRun / diffRuns: what the Lab's compare would say about the two sessions.
 *
 * Prompts and replies are left out (they are marked sensitive); tool input summaries are kept as the
 * trace shows them.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { RunEvent } from '../../packages/events/src/index.ts';
import { diffRuns, foldExecution, summarizeRun, selectOpenIncidents } from '../../packages/core/src/index.ts';
import { reduceRun, initialRunState } from '../../packages/replay/src/index.ts';
import { loadWorld, positionAt, type CompiledWorld } from '../../packages/world-engine/src/index.ts';
import { openDb } from '../../packages/runtime/src/store/db.ts';
import { Recorder } from '../../packages/runtime/src/recorder.ts';
import { EventBus } from '../../packages/runtime/src/bus.ts';
import { TraceSessionManager } from '../../packages/runtime/src/tracers/claude-code/session-manager.ts';
import type { HookEnvelope } from '../../packages/runtime/src/tracers/claude-code/hook-input.ts';
import { activityOf } from '../../packages/runtime/src/world/projector.ts';
import { deriveAttention } from '../../packages/runtime/src/agents/health.ts';
import { REPO_ROOT, arg, round, writeJson } from './lib.ts';

const FIXTURE_DIR = path.join(REPO_ROOT, 'packages', 'runtime', 'test', 'fixtures', 'claude-code');
const SCRATCH = process.env.FILM_SCRATCH ?? '/tmp';
const primary = arg('primary', 's1-basic')!;
const secondary = arg('secondary', 's2-subagents')!;

const world: CompiledWorld = loadWorld(JSON.parse(readFileSync(path.join(REPO_ROOT, 'worlds', 'research-campus', 'world.json'), 'utf8')));
const zoneOfStation = (id: string | null) => (id ? world.stationsById[id]?.zoneId ?? null : null);
const zoneLabel = (z: string | null) => (z ? world.zonesById[z]?.label ?? z : null);

interface Line { t: number; pid: number; ppid: number; argv: string[]; synthetic?: boolean; input: Record<string, unknown> }

/** Ingest a fixture through the runtime's tracer exactly as the tests do; return its recorded run. */
function record(name: string): RunEvent[] {
  // a fixture name (packages/runtime/test/fixtures/claude-code/<name>.jsonl) or a path to a capture's hook log
  const file = name.endsWith('.jsonl') ? path.resolve(name) : path.join(FIXTURE_DIR, `${name}.jsonl`);
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Line);
  if (lines.some((l) => l.synthetic)) throw new Error(`${name} is synthetic; the film uses real sessions only`);
  const dir = mkdtempSync(path.join(SCRATCH, 'film-session-'));
  try {
    const lastMs = lines.at(-1)!.t;
    const db = openDb(path.join(dir, 'runloop.db'));
    let n = 0;
    const recorder = new Recorder({ db, dataDir: dir, bus: new EventBus(() => {}), now: () => new Date(lastMs + 30 * 24 * 3600_000), newId: () => `00000001-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}` });
    const manager = new TraceSessionManager({ recorder, db, now: () => new Date(lastMs), onError: (err) => { throw err; } });
    lines.forEach((line, i) => {
      const env = { v: 1, deliveryId: `fx-${name}-${i}`, observedAt: new Date(line.t).toISOString(), ppid: line.ppid, plugin: { name: 'runloop-tracer', version: 'fixture' }, hook: line.input };
      manager.ingest([env as unknown as HookEnvelope]);
    });
    manager.sweepIdle(new Date(lastMs + 3 * 24 * 3600_000));
    const runs = recorder.listRuns().filter((r) => r.mode === 'traced');
    if (runs.length !== 1) throw new Error(`${name}: expected one traced run, got ${runs.length}`);
    const events = recorder.listAll(runs[0]!.runId);
    db.close();
    return events;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function exportSession(name: string) {
  const events = record(name);
  const t0 = Date.parse(events[0]!.timestamp);
  let s = initialRunState();
  const counts: Record<string, number> = {};
  const out: unknown[] = [];
  const hq: unknown[] = [];
  const characters: Record<string, { name: string; preset: string; segs: unknown[] }> = {};
  const lastMotion = new Map<string, string>();
  const callRoom = new Map<string, string | null>();
  let closed = false;
  let prevKey = '';
  for (const e of events) {
    s = reduceRun(s, e, world);
    const tMs = Date.parse(e.timestamp) - t0;
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'tool.call_started') counts[String(p.category)] = (counts[String(p.category)] ?? 0) + 1;
    if (e.type === 'run.completed') closed = true;

    // Characters in the HQ diorama (Layer 2): record each new motion (the engine's closed-form walk).
    for (const id of s.world.characterOrder) {
      const c = s.world.characters[id]!;
      const key = `${c.motion.startTick}|${c.motion.path.length}|${c.activity}|${c.stationId}`;
      if (lastMotion.get(id) === key) continue;
      lastMotion.set(id, key);
      const agent = s.exec.agents[id];
      characters[id] ??= { name: agent?.name ?? id, preset: c.presetId, segs: [] };
      characters[id].segs.push({ seq: e.sequence, tMs, tick: s.world.tick, activity: c.activity, station: c.stationId, room: zoneLabel(zoneOfStation(c.stationId)), startTick: c.motion.startTick, path: c.motion.path });
    }

    const actor = e.actorId ?? null;
    let room: string | null = null;
    if (e.type === 'tool.call_started' || e.type === 'tool.permission_requested') {
      const c = actor ? s.world.characters[actor] : undefined;
      room = zoneLabel(zoneOfStation(c?.stationId ?? null));
      if (e.type === 'tool.call_started') callRoom.set(String(p.callId), room);
    }
    if (e.type === 'tool.call_completed' || e.type === 'tool.call_failed') room = callRoom.get(String(p.callId)) ?? null;
    const row: Record<string, unknown> = { seq: e.sequence, tMs, type: e.type, actor, prov: e.provenance, vis: e.visibility };
    for (const k of ['callId', 'tool', 'category', 'inputSummary', 'target', 'status', 'exitCode', 'outputSummary', 'errorType', 'metrics', 'failingTests', 'durationMs', 'decision', 'state', 'name', 'role', 'taskId', 'title', 'outcome', 'model', 'totalTokens'] as const) {
      if (p[k] !== undefined && !(k === 'name' && e.type !== 'agent.registered')) row[k] = p[k];
    }
    if (e.type === 'agent.message_sent') row.chars = String(p.text ?? '').length; // the text itself is sensitive: left out
    if (room) row.room = room;
    out.push(row);

    // What the town shows on the agent's building after this event (projector + health rules).
    const a = activityOf(s.exec, counts as never, closed);
    const attention = deriveAttention({ pendingPermissions: Object.values(s.exec.permissions).filter((x) => x.status === 'pending').length, dispatchAwaitingApproval: false, openIncidents: selectOpenIncidents(s.exec).length });
    const health = closed ? 'offline' : 'live';
    const key = JSON.stringify([health, attention, a.execState, a.helpers, a.openIncidents, a.counts]);
    if (key !== prevKey) {
      prevKey = key;
      hq.push({ seq: e.sequence, tMs, health, attention, execState: a.execState, helpers: a.helpers, openIncidents: a.openIncidents, counts: a.counts });
    }
  }
  const exec = foldExecution(events);
  const digest = summarizeRun(exec);
  // Sample each character's position every 250 ms of the run (world-engine positionAt), for previews.
  const tickHz = world.def.tickHz;
  const endMs = Date.parse(events.at(-1)!.timestamp) - t0;
  const samples: Record<string, [number, number, number][]> = {};
  for (const [id, c] of Object.entries(characters)) {
    samples[id] = [];
    for (let ms = 0; ms <= endMs + 4000; ms += 250) {
      const tick = (ms / 1000) * tickHz;
      let cur = c.segs[0] as { tick: number; startTick: number; path: [number, number][] };
      for (const sg of c.segs as { tick: number; startTick: number; path: [number, number][] }[]) if (sg.tick <= tick) cur = sg;
      const pos = positionAt({ path: cur.path, startTick: cur.startTick }, tick, world.def.ticksPerCell);
      samples[id].push([ms, round(pos.x, 2), round(pos.y, 2)]);
    }
  }
  return {
    fixture: name,
    sessionId: (events[0]!.payload as { source?: { sessionId?: string } }).source?.sessionId ?? null,
    startedAt: events[0]!.timestamp,
    durationMs: endMs,
    events: out,
    hq,
    diorama: { world: 'research-campus', tickHz, ticksPerCell: world.def.ticksPerCell, characters, samplesEvery: 250, samples },
    digest: {
      status: digest.status,
      outcome: digest.outcome,
      durationMs: digest.durationMs,
      toolCalls: digest.toolCalls,
      tests: digest.tests,
      failures: digest.failures,
      agents: digest.agents,
      tokens: digest.tokens,
      permissions: digest.permissions,
    },
    _digest: digest,
  };
}

const A = exportSession(primary);
const B = exportSession(secondary);
const diff = diffRuns(A._digest, B._digest);
const strip = ({ _digest, ...rest }: typeof A) => rest;

const doc = {
  provenance: {
    kind: 'PLACEHOLDER: real recorded Claude Code sessions from the repo fixtures; the live capture replaces this file',
    fixtures: [primary, secondary],
    source: 'packages/runtime/test/fixtures/claude-code/*.jsonl: real `claude -p` sessions (Haiku, Claude Code 2.1.302, 2026-10-17), sanitised (absolute paths only)',
    path: 'hook envelopes -> TraceSessionManager + Recorder (runtime ingest) -> reduceRun on worlds/research-campus -> projector activityOf + deriveAttention; compare via core summarizeRun/diffRuns',
    exporter: 'film/tools/export-session.ts',
    truth: [
      'Every event here was reported by Claude Code hooks (prov "reported") or reconstructed by Runloop (prov "inferred", e.g. the denied permission). Nothing is invented.',
      'Replay in the product folds these same recorded events; it never re-executes anything.',
      'The main agent\'s tokens are "not reported" (hooks do not expose them); only subagent usage is reported.',
      `${primary} has the failing command (node --test, exit 1, 10 passed / 2 failed) but no subagents; ${secondary} has two Explore subagents but no failure. No single real fixture has both, so the live capture must be prompted to do both in one session (see docs/shotlist.md, Required real captures).`,
    ],
  },
  rooms: Object.fromEntries(world.def.zones.map((z) => [z.label, { id: z.id, kind: z.kind, rect: z.rect, color: z.color }])),
  activityRules: world.def.activityRules,
  primary: strip(A),
  secondary: strip(B),
  compare: {
    note: 'What the Lab would compute for baseline = primary, candidate = secondary (core diffRuns). The film may show only values that are reported; null / not comparable stay "not reported".',
    diff,
  },
};
const file = writeJson('session-events.json', doc);
const sum = (x: ReturnType<typeof exportSession>) => `${x.fixture}: ${x.events.length} events over ${(x.durationMs / 1000).toFixed(1)} s, calls ${JSON.stringify(x.digest.toolCalls.byCategory ?? x.digest.toolCalls)}, hq states ${x.hq.length}`;
console.log(sum(A));
console.log(sum(B));
console.log(`-> ${file}`);
