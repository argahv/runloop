import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { collectEnvSecrets } from '../src/config';
import { EventValidationError, RunClosedError } from '../src/recorder';
import { MANIFEST, openRecorder, tempDir } from './helpers';

const RUN = '11111111-1111-4111-8111-111111111111';

describe('Recorder', () => {
  it('assigns contiguous sequences from 1 and derives actor/task refs from the payload', () => {
    const { recorder } = openRecorder(tempDir());
    const started = recorder.createRun({ runId: RUN, manifest: MANIFEST });
    const a = recorder.append(RUN, { type: 'task.assigned', payload: { taskId: 'T1', agentId: 'builder' }, actorId: 'coordinator' });
    const b = recorder.append(RUN, { type: 'task.started', payload: { taskId: 'T1', agentId: 'builder' } });
    expect([started.sequence, a.sequence, b.sequence]).toEqual([1, 2, 3]);
    expect(started.actorId).toBe('system');
    expect(a).toMatchObject({ actorId: 'coordinator', taskId: 'T1', visibility: 'public', schemaVersion: 1 });
    expect(b).toMatchObject({ actorId: 'builder', taskId: 'T1' });
    expect(recorder.list(RUN).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(recorder.getRun(RUN)).toMatchObject({ status: 'running', lastSequence: 3, paused: false });
  });

  it('persists before publishing (a second connection sees each event inside the listener)', () => {
    const { recorder, file } = openRecorder(tempDir());
    const second = new DatabaseSync(file, { readOnly: true });
    const seen: { seq: number; persisted: boolean; lastSequence: number }[] = [];
    recorder.subscribe(RUN, (e) => {
      const row = second.prepare('SELECT sequence FROM events WHERE run_id = ? AND sequence = ?').get(RUN, e.sequence);
      const run = second.prepare('SELECT last_sequence FROM runs WHERE run_id = ?').get(RUN) as { last_sequence: number };
      seen.push({ seq: e.sequence, persisted: row !== undefined, lastSequence: run.last_sequence });
    });
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'working' } });
    recorder.append(RUN, { type: 'run.completed', payload: { outcome: 'succeeded' } });
    expect(seen).toEqual([
      { seq: 1, persisted: true, lastSequence: 1 },
      { seq: 2, persisted: true, lastSequence: 2 },
      { seq: 3, persisted: true, lastSequence: 3 },
    ]);
    second.close();
  });

  it('keeps appending when a subscriber throws', () => {
    const { recorder } = openRecorder(tempDir());
    const got: number[] = [];
    recorder.subscribe(RUN, () => {
      throw new Error('boom');
    });
    recorder.subscribe(RUN, (e) => got.push(e.sequence));
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'idle' } });
    expect(got).toEqual([1, 2]);
  });

  it('rejects an invalid draft without consuming a sequence', () => {
    const { recorder } = openRecorder(tempDir());
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    const bad = { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'dancing' } };
    expect(() => recorder.append(RUN, bad as never)).toThrow(EventValidationError);
    expect(() => recorder.append(RUN, { type: 'no.such_type', payload: {} } as never)).toThrow(EventValidationError);
    const next = recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'idle' } });
    expect(next.sequence).toBe(2);
    expect(recorder.getRun(RUN)?.lastSequence).toBe(2);
  });

  it('redacts env secrets in payloads and artifacts, and marks the event redacted', () => {
    const secret = 'hunter2-super-secret-value';
    const secrets = collectEnvSecrets({ MY_API_TOKEN: secret, HOME: '/home/someone/very/long', SHORT_KEY: 'abc' });
    expect(secrets).toEqual([secret]);
    const dir = tempDir();
    const { recorder, db, file } = openRecorder(dir, { secrets });
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    const e = recorder.append(RUN, {
      type: 'agent.message_sent',
      payload: { messageId: 'msg-1', fromAgentId: 'builder', to: 'tester', text: `token is ${secret}, ok?` },
    });
    expect(e.visibility).toBe('redacted');
    expect(e.type === 'agent.message_sent' && e.payload.text).toBe('token is [REDACTED], ok?');
    const clean = recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'idle' } });
    expect(clean.visibility).toBe('public');

    const { bytes } = recorder.putArtifactContent(RUN, 'art-1', `log line with ${secret}\n`);
    expect(bytes).toBe(Buffer.byteLength('log line with [REDACTED]\n'));

    db.close();
    for (const f of [file, `${file}-wal`, `${dir}/artifacts/${RUN}/art-1`]) {
      if (existsSync(f)) expect(readFileSync(f).includes(secret)).toBe(false);
    }
  });

  it('continues the sequence after the database is reopened', () => {
    const dir = tempDir();
    const first = openRecorder(dir);
    first.recorder.createRun({ runId: RUN, manifest: MANIFEST });
    first.recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'working' } });
    const before = first.recorder.list(RUN);
    first.db.close();

    const second = openRecorder(dir);
    expect(second.recorder.list(RUN)).toEqual(before);
    const next = second.recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'idle' } });
    expect(next.sequence).toBe(3);
    expect(second.recorder.listRuns().map((r) => r.runId)).toEqual([RUN]);
  });

  it('marks runs left running as interrupted, failing dangling tool calls first', () => {
    const dir = tempDir();
    const crashed = openRecorder(dir);
    crashed.recorder.createRun({ runId: RUN, manifest: MANIFEST });
    const done = crashed.recorder.append(RUN, {
      type: 'tool.call_started',
      payload: { callId: 'call-1', agentId: 'builder', taskId: 'T2', tool: 'read_file', inputSummary: 'a.js' },
    });
    crashed.recorder.append(RUN, {
      type: 'tool.call_completed',
      payload: { callId: 'call-1', status: 'success', durationMs: 1, outputSummary: 'read 1 bytes' },
      parentEventId: done.eventId,
    });
    const dangling = crashed.recorder.append(RUN, {
      type: 'tool.call_started',
      payload: { callId: 'call-2', agentId: 'tester', taskId: 'T3', tool: 'run_command', inputSummary: 'node --test' },
    });
    crashed.db.close(); // the process "dies" here

    const rebooted = openRecorder(dir);
    expect(rebooted.recorder.recoverInterrupted()).toEqual([RUN]);
    const tail = rebooted.recorder.list(RUN, { after: 4 });
    expect(tail.map((e) => e.type)).toEqual(['tool.call_failed', 'run.completed']);
    expect(tail[0]).toMatchObject({
      sequence: 5,
      parentEventId: dangling.eventId,
      actorId: 'tester',
      taskId: 'T3',
      payload: { callId: 'call-2', errorType: 'runtime_restarted' },
    });
    expect(tail[1]).toMatchObject({ payload: { outcome: 'interrupted' } });
    expect(rebooted.recorder.getRun(RUN)).toMatchObject({ status: 'interrupted', lastSequence: 6 });
    // Recovery is idempotent.
    expect(rebooted.recorder.recoverInterrupted()).toEqual([]);
  });

  it('refuses events after run.completed', () => {
    const { recorder } = openRecorder(tempDir());
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    recorder.append(RUN, { type: 'run.completed', payload: { outcome: 'stopped' } });
    expect(() =>
      recorder.append(RUN, { type: 'agent.state_changed', payload: { agentId: 'builder', state: 'idle' } }),
    ).toThrow(RunClosedError);
    expect(recorder.getRun(RUN)).toMatchObject({ status: 'stopped', lastSequence: 2 });
    expect(recorder.getRun(RUN)?.endedAt).not.toBeNull();
  });

  it('tracks paused state and indexes artifacts from artifact.created', () => {
    const { recorder } = openRecorder(tempDir());
    recorder.createRun({ runId: RUN, manifest: MANIFEST });
    recorder.append(RUN, { type: 'run.paused', payload: {} });
    expect(recorder.getRun(RUN)?.paused).toBe(true);
    recorder.append(RUN, { type: 'run.resumed', payload: {} });
    expect(recorder.getRun(RUN)?.paused).toBe(false);

    const { bytes, sha256 } = recorder.putArtifactContent(RUN, 'art-1', '# pass 1\n');
    expect(recorder.getArtifact(RUN, 'art-1')).toBeNull(); // not indexed until the event is recorded
    recorder.append(RUN, {
      type: 'artifact.created',
      payload: { artifactId: 'art-1', kind: 'log', name: 'out.log', mediaType: 'text/plain', bytes, sha256, summary: 'log' },
    });
    const a = recorder.getArtifact(RUN, 'art-1');
    expect(a).toMatchObject({ name: 'out.log', mediaType: 'text/plain', bytes, sha256 });
    expect(a?.content.toString()).toBe('# pass 1\n');
    expect(recorder.getArtifact(RUN, '../runloop.db')).toBeNull();
  });
});
