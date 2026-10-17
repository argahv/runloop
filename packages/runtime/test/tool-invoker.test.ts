import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAbortError } from '../src/adapter';
import { ToolInvoker } from '../src/tool-invoker';
import { MANIFEST, openRecorder, tempDir } from './helpers';

const RUN = '55555555-5555-4555-8555-555555555555';

function setup(secrets: string[] = []) {
  const dir = tempDir('invoker');
  const ws = path.join(dir, 'ws');
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  writeFileSync(path.join(ws, 'src', 'a.js'), 'export const a = 1;\n');
  const { recorder } = openRecorder(dir, { secrets });
  recorder.createRun({ runId: RUN, manifest: MANIFEST });
  const ac = new AbortController();
  const invoker = new ToolInvoker({ recorder, runId: RUN, workspaceDir: ws, signal: ac.signal });
  return { dir, ws, recorder, invoker, ac };
}

describe('ToolInvoker', () => {
  it('records started → completed for a read, and returns the content to the agent', async () => {
    const { recorder, invoker } = setup();
    const r = await invoker.invoke('builder', 'T2', { tool: 'read_file', path: 'src/a.js' });
    expect(r).toMatchObject({ callId: 'call-1', status: 'success', outputSummary: 'read 20 bytes', output: 'export const a = 1;\n' });
    const [, started, done] = recorder.list(RUN);
    expect(started).toMatchObject({ type: 'tool.call_started', actorId: 'builder', taskId: 'T2', payload: { tool: 'read_file', inputSummary: 'src/a.js' } });
    expect(done).toMatchObject({ type: 'tool.call_completed', parentEventId: started!.eventId, actorId: 'builder', taskId: 'T2' });
    expect(JSON.stringify(done)).not.toContain('export const'); // file content is not put in events
  });

  it('records a sandbox denial as tool.call_failed{denied}', async () => {
    const { recorder, invoker } = setup();
    const r = await invoker.invoke('builder', 'T2', { tool: 'write_file', path: '../escape.js', content: 'x' });
    expect(r).toMatchObject({ status: 'failed', errorType: 'denied' });
    const cmd = await invoker.invoke('tester', 'T3', { tool: 'run_command', argv: ['node', '-e', '1'] });
    expect(cmd).toMatchObject({ callId: 'call-2', status: 'failed', errorType: 'denied' });
    const types = recorder.list(RUN).map((e) => e.type);
    expect(types).toEqual(['run.started', 'tool.call_started', 'tool.call_failed', 'tool.call_started', 'tool.call_failed']);
  });

  it('records a missing file as a completed call with status error', async () => {
    const { recorder, invoker } = setup();
    const r = await invoker.invoke('builder', 'T2', { tool: 'read_file', path: 'src/missing.js' });
    expect(r).toMatchObject({ status: 'error', errorType: 'not_found' });
    expect(recorder.list(RUN).at(-1)).toMatchObject({ type: 'tool.call_completed', payload: { status: 'error', errorType: 'not_found' } });
  });

  it('stores written files as redacted artifacts linked to the call', async () => {
    const secret = 'sk-live-0123456789abcdefXYZ';
    const { ws, recorder, invoker } = setup();
    const r = await invoker.invoke('builder', 'T2', { tool: 'write_file', path: 'src/b.js', content: `const key = "${secret}";\n`, summary: 'b' });
    expect(readFileSync(path.join(ws, 'src', 'b.js'), 'utf8')).toContain(secret); // the workspace file is the real one
    const [, started, artifact, done] = recorder.list(RUN);
    expect(artifact).toMatchObject({
      type: 'artifact.created',
      parentEventId: started!.eventId,
      payload: { artifactId: 'art-1', kind: 'file', name: 'b.js', path: 'src/b.js', mediaType: 'text/javascript', producedByCallId: 'call-1' },
    });
    expect(done).toMatchObject({ payload: { outputArtifactIds: ['art-1'] } });
    expect(r.artifactIds).toEqual(['art-1']);
    expect(recorder.getArtifact(RUN, 'art-1')!.content.toString()).toBe('const key = "[REDACTED]";\n');
  });

  it('refuses to start a call once the run is stopped', async () => {
    const { recorder, invoker, ac } = setup();
    ac.abort();
    await expect(invoker.invoke('builder', 'T2', { tool: 'list_files' })).rejects.toSatisfy(isAbortError);
    expect(recorder.list(RUN)).toHaveLength(1);
  });
});
