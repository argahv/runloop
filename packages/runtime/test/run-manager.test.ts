import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapter';
import { createRuntime, type Runtime } from '../src/runtime';
import { REPO_ROOT, tempDir } from './helpers';

let rt: Runtime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

/** A missions dir with one mission run by `adapter`. */
function runtimeWith(adapter: AgentAdapter): Runtime {
  const missions = tempDir('missions');
  const dir = path.join(missions, 'probe');
  mkdirSync(path.join(dir, 'repo'), { recursive: true });
  writeFileSync(path.join(dir, 'repo', 'README.md'), '# probe\n');
  writeFileSync(
    path.join(dir, 'mission.json'),
    JSON.stringify({ id: 'probe', title: 'Probe', worldId: 'research-campus', seed: 1, adapter: adapter.info.id }),
  );
  rt = createRuntime({ repoRoot: REPO_ROOT, dataDir: tempDir('rm'), env: {}, missionsDir: missions, adapters: [adapter] });
  return rt;
}

describe('RunManager adapter guards', () => {
  it('refuses a task.completed that cites artifacts the run never recorded', async () => {
    const liar: AgentAdapter = {
      info: { id: 'liar', kind: 'llm', label: 'Never runs a tool' },
      async run(ctx) {
        ctx.emit('task.created', { taskId: 'T1', title: 'Tests', kind: 'test', dependsOn: [] });
        ctx.emit('task.started', { taskId: 'T1', agentId: 'tester' });
        ctx.emit('task.completed', { taskId: 'T1', summary: 'All 12 tests pass', artifactIds: ['art-99'] });
        return { outcome: 'succeeded', summary: '12/12 tests pass' };
      },
    };
    const r = runtimeWith(liar);
    const { runId } = r.manager.start({ missionId: 'probe', speed: 0 });
    const summary = await r.manager.whenDone(runId);
    const events = r.recorder.listAll(runId);
    expect(events.map((e) => e.type)).toEqual(['run.started', 'task.created', 'task.started', 'run.completed']);
    expect(summary.status).toBe('failed');
    expect(events.at(-1)!.payload).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('art-99') });
  });

  it('accepts a task.completed citing an artifact a real tool call produced', async () => {
    const honest: AgentAdapter = {
      info: { id: 'honest', kind: 'llm', label: 'Writes a file' },
      async run(ctx) {
        ctx.emit('task.created', { taskId: 'T1', title: 'Write', kind: 'code', dependsOn: [] });
        ctx.emit('task.started', { taskId: 'T1', agentId: 'builder' });
        const w = await ctx.tools.invoke('builder', 'T1', { tool: 'write_file', path: 'a.txt', content: 'hi\n' });
        ctx.emit('task.completed', { taskId: 'T1', summary: 'wrote a.txt', artifactIds: w.artifactIds });
        return { outcome: 'succeeded', summary: 'done' };
      },
    };
    const r = runtimeWith(honest);
    const { runId } = r.manager.start({ missionId: 'probe', speed: 0 });
    expect((await r.manager.whenDone(runId)).status).toBe('succeeded');
    const done = r.recorder.listAll(runId).find((e) => e.type === 'task.completed');
    expect(done?.payload).toMatchObject({ artifactIds: ['art-1'] });
  });
});
