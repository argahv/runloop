import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { categoryLabel, describeEvent, formatTokens, shortModel, usageParts, usageText } from './labels';
import { tracedFixture } from './test-utils';
import { buildTimelineRows } from './timeline';

const events = tracedFixture();
const exec = foldExecution(events);
const first = (type: string, pred: (e: (typeof events)[number]) => boolean = () => true) => events.find((e) => e.type === type && pred(e))!;

describe('token and model formatting', () => {
  it('abbreviates token counts with a fixed locale', () => {
    expect(formatTokens(830)).toBe('830');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1234)).toBe('1.23k');
    expect(formatTokens(20520)).toBe('20.5k');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(1_234_567)).toBe('1.23M');
  });

  it('shortens model ids to their family and keeps unknown ids', () => {
    expect(shortModel('claude-haiku-5-5')).toBe('haiku');
    expect(shortModel('claude-opus-5-5')).toBe('opus');
    expect(shortModel('gpt-x')).toBe('gpt-x');
  });

  it('words usage from the reported fields only', () => {
    const p = { model: 'claude-haiku-5-5', inputTokens: 2, outputTokens: 193, cacheReadTokens: 19620, totalTokens: 20520 };
    expect(usageText(p)).toBe('20.5k tokens · haiku');
    expect(usageText({ ...p, model: null })).toBe('20.5k tokens');
    expect(usageParts(p)).toBe('in 2 · out 193 · cache read 19,620'); // no cache write: not reported, not "0"
  });

  it('labels categories', () => {
    expect(categoryLabel('execute')).toBe('Command');
    expect(categoryLabel('something-new')).toBe('something-new');
  });
});

describe('event labels', () => {
  it('uses agent and task names instead of ids', () => {
    expect(describeEvent(first('task.assigned'), exec).label).toBe('Assigned Summarize task-store.js to Explore #1');
    expect(describeEvent(first('agent.message_sent'), exec).label).toBe('You → Claude');
    expect(describeEvent(first('task.completed'), exec).label).toBe('Completed Summarize task-store.js');
  });

  it('words traced sessions, delegation, usage and inferred answers', () => {
    expect(describeEvent(first('run.started'), exec)).toMatchObject({ label: 'Session started · demo', detail: 'Claude Code session 448e50c5' });
    expect(describeEvent(events.at(-1)!, exec)).toMatchObject({ label: 'Session ended', detail: 'Session ended (other)', severity: 'info' });
    expect(describeEvent(first('task.created', (e) => e.taskId === 'delegate-1'), exec).label).toBe('Delegated to Explore #1: Summarize task-store.js');
    expect(describeEvent(first('agent.registered', (e) => (e.payload as { agentId: string }).agentId === 'sa-1'), exec)).toMatchObject({
      label: 'Explore #1 joined',
      detail: 'subagent (Explore)',
    });
    const usage = describeEvent(first('agent.usage_reported'), exec);
    expect(usage.label).toBe('Usage: 20.5k tokens · haiku');
    expect(usage.detail).toBe('in 2 · out 193 · cache read 19,620 · cache write 705 · reported by Claude Code (Agent tool result)');
    expect(describeEvent(first('tool.permission_resolved'), exec)).toMatchObject({ label: 'Permission denied', detail: 'Who answered was not reported' });
    expect(describeEvent(first('tool.call_failed'), exec).label).toBe('Bash: denied');
    expect(describeEvent(first('run.marker'), exec).label).toBe('Compaction started (manual)');
  });

  it('leaves executed runs in the core wording apart from names', () => {
    const demo = codingMissionFixture();
    const demoExec = foldExecution(demo);
    const done = demo.find((e) => e.type === 'run.completed')!;
    expect(describeEvent(done, demoExec).label).toBe('Run succeeded');
    const started = demo.find((e) => e.type === 'run.started')!;
    expect(describeEvent(started, demoExec).label).toMatch(/^Run started: /);
  });
});

describe('timeline rows for a traced run', () => {
  const t0 = Date.parse(events[0]!.timestamp);
  const rows = buildTimelineRows(events, (seq) => Date.parse(events[seq - 1]!.timestamp) - t0, exec);

  it('folds a delegation into one row that names the subagent', () => {
    const row = rows.find((r) => r.taskId === 'delegate-1' && r.type === 'task.created')!;
    expect(row.title).toBe('Delegated to Explore #1: Summarize task-store.js');
    expect(row.types).toEqual(['task.created', 'task.assigned', 'task.started']);
    expect(row.delegateId).toBe('sa-1');
    expect(row.actorId).toBe('main');
    expect(rows.some((r) => r.type === 'task.assigned' || r.type === 'task.started')).toBe(false);
  });

  it('links the Agent call to the subagent it started', () => {
    const call = rows.find((r) => r.tool === 'Agent')!;
    expect(call.delegateId).toBe('sa-1');
    expect(call.category).toBe('delegate');
    expect(rows.find((r) => r.tool === 'Read')!.delegateId).toBeNull();
  });

  it('shows a turn as one row attributed to the agent that works it', () => {
    const turn = rows.find((r) => r.taskId === 'turn-1' && r.type === 'task.created')!;
    expect(turn).toMatchObject({ title: 'Turn 1 started', actorId: 'main', types: ['task.created', 'task.started'] });
  });

  it('marks inferred rows and words failures', () => {
    const denied = rows.find((r) => r.callId === 'c-perm')!;
    expect(denied).toMatchObject({ status: 'error', inferred: true });
    expect(denied.detail).toMatch(/^Denied: /);
    expect(rows.find((r) => r.type === 'tool.permission_resolved')!.inferred).toBe(true);
  });

  it('gives markers and usage rows their own icons', () => {
    expect(rows.find((r) => r.type === 'run.marker')!.icon).toBe('◫');
    expect(rows.find((r) => r.type === 'agent.usage_reported')!.icon).toBe('¤');
  });
});
