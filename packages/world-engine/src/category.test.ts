import type { ToolCategory } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { matchActivityRule } from './intent';
import { campus, foldSteps } from './test-utils';
import { runBuilder } from '@runloop-world/testkit';

const world = campus();
const rules = world.def.activityRules;

/** A traced run: main (preset claude) working on turn-1. */
function tracedTurn() {
  const b = runBuilder({ startIso: '2026-10-17T09:00:00.000Z' });
  b.add('run.started', {
    title: 'Claude Code · demo',
    missionId: 'claude-code',
    worldId: 'research-campus',
    adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code' },
    mode: 'traced',
    source: { kind: 'claude-code', sessionId: 's', segment: 1, projectLabel: 'demo' },
  });
  b.wait(100).add('agent.registered', { agentId: 'main', name: 'Claude', role: 'main', model: null, tools: [], embodied: true, characterPreset: 'claude' });
  b.wait(100).add('task.created', { taskId: 'turn-1', title: 'Turn 1', kind: 'turn', dependsOn: [] });
  b.wait(100).add('task.started', { taskId: 'turn-1', agentId: 'main' });
  let n = 0;
  const call = (category: ToolCategory, ms = 100) => {
    const callId = `c${++n}`;
    b.wait(ms).add('tool.call_started', { callId, agentId: 'main', taskId: 'turn-1', tool: 'T', category, inputSummary: '' });
    return callId;
  };
  const done = (callId: string, ms = 100) => b.wait(ms).add('tool.call_completed', { callId, status: 'success', durationMs: 1, outputSummary: '' });
  return { b, call, done };
}

const stationOf = (steps: ReturnType<typeof foldSteps>, i: number) => {
  const c = steps[i]!.world.characters.main!;
  return { activity: c.activity, stationKind: c.stationKind, stationId: c.stationId, target: c.target.kind };
};

describe('toolCategory activity rules', () => {
  it('maps categories to stations; permission still wins; uncategorised calls use task kinds', () => {
    const m = (toolCategory: ToolCategory | null, taskKind: 'turn' | 'research' | 'delegated' = 'turn', permission = false) =>
      matchActivityRule(rules, { taskKind, toolCategory, permission });
    expect(['read', 'search', 'web'].map((c) => m(c as ToolCategory))).toEqual(['library', 'library', 'library']);
    expect([m('edit'), m('execute'), m('test'), m('deploy'), m('mcp')]).toEqual(['build', 'build', 'test', 'ops', 'ops']);
    expect([m('delegate'), m('plan'), m('other'), m(null)]).toEqual([null, null, null, null]);
    expect(m('read', 'turn', true)).toBe('gate');
    expect(m('read', 'delegated')).toBe('library');
    // The scripted demo: no category, the task kind decides (and the old call signature still works).
    expect(m(null, 'research')).toBe('library');
    expect(matchActivityRule(rules, { taskKind: 'research', permission: false })).toBe('library');
  });

  it('a category rule needs both conditions when it also names task kinds', () => {
    const custom = [{ when: { toolCategory: ['test' as const], taskKind: ['fix' as const] }, stationKind: 'ops' as const }];
    expect(matchActivityRule(custom, { taskKind: 'fix', toolCategory: 'test', permission: false })).toBe('ops');
    expect(matchActivityRule(custom, { taskKind: 'code', toolCategory: 'test', permission: false })).toBeNull();
  });
});

describe('reduceWorld — tool categories', () => {
  it('keeps the station between calls of a task, moves when the category changes, goes home while delegating', () => {
    const { b, call, done } = tracedTurn();
    const read = call('read'); // 5
    done(read); // 6: between calls → sticky library
    const edit = call('edit', 2000); // 7
    done(edit); // 8
    const agent = call('delegate', 2000); // 9: no station for delegation
    done(agent, 5000); // 10
    b.wait(100).add('task.completed', { taskId: 'turn-1', summary: 'ok', artifactIds: [] }); // 11
    const steps = foldSteps(b.events, world);
    expect(stationOf(steps, 3)).toMatchObject({ activity: 'working', stationKind: null, target: 'home' });
    expect(stationOf(steps, 4)).toMatchObject({ activity: 'working', stationKind: 'library', target: 'slot' });
    expect(stationOf(steps, 5)).toEqual(stationOf(steps, 4));
    expect(steps[5]!.world.characters.main).toBe(steps[4]!.world.characters.main); // nothing changed at all
    expect(stationOf(steps, 6)).toMatchObject({ stationKind: 'build', target: 'slot' });
    expect(stationOf(steps, 7)).toMatchObject({ stationKind: 'build' });
    expect(stationOf(steps, 8)).toMatchObject({ activity: 'working', stationKind: null, target: 'home' });
    expect(stationOf(steps, 10)).toMatchObject({ activity: 'succeeded', target: 'home' });
    // The library slot was released when it moved on.
    expect(steps[6]!.world.stations.archive!.slots).toEqual([null]);
  });

  it('places a categorised call made while a permission is pending at the gate', () => {
    const { b, call } = tracedTurn();
    const callId = call('execute');
    b.wait(100).add('tool.permission_requested', { permissionId: 'perm-1', agentId: 'main', callId, action: 'Bash', scope: 'default' });
    const steps = foldSteps(b.events, world);
    expect(stationOf(steps, steps.length - 1)).toMatchObject({ activity: 'awaiting_approval', stationKind: 'gate', stationId: 'gate' });
  });

  it('gives the claude and subagent presets distinct homes in or beside the Atrium', () => {
    const ids = ['claude', ...Array.from({ length: 8 }, (_, i) => `subagent-${i + 1}`)];
    const homes = ids.map((id) => world.presetsById[id]!.home.join(','));
    expect(new Set(homes).size).toBe(ids.length);
    for (const id of ids) expect(world.presetsById[id]!.icon).toBe('bot');
    expect(world.zonesById.hub!.label).toBe('Atrium');
  });
});
