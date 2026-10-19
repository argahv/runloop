/** The two hooks the agent layer needs: TraceSessionManager.onSessionSeen and Recorder.subscribeAll. */
import type { RunEvent } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { TraceSessionManager, type SessionSeen } from '../src/tracers/claude-code/session-manager';
import { comparable, envelopeOf, readFixture, recordFixture } from './claude-code-helpers';
import { MANIFEST, openRecorder, tempDir } from './helpers';

describe('Recorder.subscribeAll', () => {
  it('delivers every run’s events after the commit, in order', () => {
    const { recorder, db } = openRecorder(tempDir('suball'));
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const seen: string[] = [];
    let durable = true;
    const off = recorder.subscribeAll((e) => {
      // Published only once durable (listener errors are swallowed, so record and assert after).
      durable &&= recorder.list(e.runId, { after: e.sequence - 1, limit: 1 })[0]?.eventId === e.eventId;
      seen.push(`${e.runId === A ? 'a' : 'b'}:${e.sequence}`);
    });
    recorder.createRun({ runId: A, manifest: MANIFEST });
    recorder.createRun({ runId: B, manifest: MANIFEST });
    recorder.append(A, { type: 'run.marker', payload: { kind: 'other', label: 'x' } });
    off();
    recorder.append(B, { type: 'run.marker', payload: { kind: 'other', label: 'y' } });
    expect(seen).toEqual(['a:1', 'b:1', 'a:2']);
    expect(durable).toBe(true);
    db.close();
  });
});

describe('TraceSessionManager.onSessionSeen', () => {
  it('fires for every accepted delivery, before its events are published, with the reported cwd', () => {
    const name = 's1-basic';
    const lines = readFixture(name);
    const { recorder, db } = openRecorder(tempDir('seen'));
    const log: string[] = [];
    recorder.subscribeAll((e) => log.push(`event ${e.sequence}`));
    const seen: SessionSeen[] = [];
    const manager = new TraceSessionManager({
      recorder,
      db,
      onError: (err) => {
        throw err;
      },
      onSessionSeen: (s) => {
        seen.push(s);
        log.push('seen');
      },
    });
    let accepted = 0;
    lines.forEach((line, i) => {
      const before = log.length;
      accepted += manager.ingest([envelopeOf(name, line, i)]).accepted;
      const added = log.slice(before);
      // The hook comes first; the delivery's events follow it.
      if (added.length > 0) expect(added[0]).toBe('seen');
    });
    expect(seen).toHaveLength(accepted);
    expect(seen[0]).toEqual({ sessionId: String(lines[0]!.input.session_id), runId: null, cwd: '/home/dev/demo' });
    const runId = recorder.listRuns()[0]!.runId;
    expect(seen.at(-1)).toEqual({ sessionId: String(lines[0]!.input.session_id), runId, cwd: '/home/dev/demo' });
    // Duplicates are not "seen" again.
    expect(manager.ingest([envelopeOf(name, lines[3]!, 3)]).duplicates).toBe(1);
    expect(seen).toHaveLength(accepted);
    db.close();
  });

  it('a throwing hook is reported and changes nothing that is recorded', () => {
    const name = 's2-subagents';
    const lines = readFixture(name);
    const golden = recordFixture(name, tempDir('hooks-golden')).runs;
    const { recorder, db } = openRecorder(tempDir('hooks-throw'), { now: () => new Date(lines.at(-1)!.t + 30 * 24 * 3600_000) });
    const errors: unknown[] = [];
    const manager = new TraceSessionManager({
      recorder,
      db,
      now: () => new Date(lines.at(-1)!.t),
      onError: (err) => errors.push(err),
      onSessionSeen: () => {
        throw new Error('hook failed');
      },
    });
    lines.forEach((line, i) => manager.ingest([envelopeOf(name, line, i)]));
    manager.sweepIdle(new Date(lines.at(-1)!.t + 3 * 24 * 3600_000));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e instanceof Error && e.message === 'hook failed')).toBe(true);
    const runs: RunEvent[][] = recorder
      .listRuns()
      .filter((r) => r.mode === 'traced')
      .sort((a, b) => (a.source?.segment ?? 0) - (b.source?.segment ?? 0))
      .map((r) => recorder.listAll(r.runId));
    expect(runs.map(comparable)).toEqual(golden.map(comparable));
    db.close();
  });
});
