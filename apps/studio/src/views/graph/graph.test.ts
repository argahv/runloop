import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture, runBuilder } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { edgeAnchors, edgePath, layerOf, layoutGraph, layoutGraphDown, DEFAULT_LAYOUT } from './layout';
import { buildAgentGraph, runtimeStatusView } from './model';

/** A small traced session: the user, Claude, and two parallel Explore subagents (shape of fixture s2). */
function tracedSession() {
  const b = runBuilder({ namespace: 0x5e });
  b.add('run.started', {
    title: 'Claude Code · demo',
    missionId: 'claude-code',
    worldId: 'research-campus',
    adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code (traced via hooks)' },
    mode: 'traced',
    source: { kind: 'claude-code', sessionId: 'session-1', segment: 1, projectLabel: 'demo' },
  });
  b.add('agent.registered', { agentId: 'user', name: 'You', role: 'user', model: null, tools: [], embodied: false });
  b.add('agent.registered', { agentId: 'main', name: 'Claude', role: 'main agent', model: null, tools: [], embodied: true, characterPreset: 'claude' });
  b.add('task.created', { taskId: 'turn-1', title: 'Turn 1', kind: 'turn', dependsOn: [] }, { actorId: 'user' });
  b.add('task.started', { taskId: 'turn-1', agentId: 'main' });
  b.add('agent.message_sent', { messageId: 'msg-1', fromAgentId: 'user', to: 'main', text: 'Do two things' }, { visibility: 'sensitive' });
  for (const k of [1, 2]) {
    const id = `sa-${k}`;
    b.add('tool.call_started', { callId: `agent-${k}`, agentId: 'main', taskId: 'turn-1', tool: 'Agent', category: 'delegate', inputSummary: 'Explore' });
    b.add('agent.registered', { agentId: id, name: `Explore #${k}`, role: 'Explore', model: null, tools: [], embodied: true, characterPreset: `subagent-${k}` });
    b.add('task.created', { taskId: `delegate-${k}`, title: `Job ${k}`, kind: 'delegated', dependsOn: [] }, { actorId: 'main' });
    b.add('task.assigned', { taskId: `delegate-${k}`, agentId: id }, { actorId: 'main' });
    b.add('task.started', { taskId: `delegate-${k}`, agentId: id });
  }
  b.add('tool.call_started', { callId: 'read-1', agentId: 'sa-1', taskId: 'delegate-1', tool: 'Read', category: 'read', inputSummary: 'src/a.js' });
  b.add('agent.message_sent', { messageId: 'msg-2', fromAgentId: 'sa-2', to: 'main', text: '12 tests' });
  b.add('task.completed', { taskId: 'delegate-2', summary: '12 tests', artifactIds: [] });
  b.add('agent.usage_reported', {
    agentId: 'sa-2',
    model: 'claude-haiku',
    inputTokens: 2,
    outputTokens: 577,
    totalTokens: 21820,
    source: 'claude-code.agent_result',
  });
  return b.events;
}

describe('agent network model', () => {
  it('builds delegation and message edges for the scripted demo', () => {
    const g = buildAgentGraph(foldExecution(codingMissionFixture()));
    expect(g.nodes.map((n) => n.id)).toEqual(['coordinator', 'researcher', 'builder', 'tester']);
    const d = Object.fromEntries(g.delegations.map((e) => [`${e.from}>${e.to}`, e.tasks.map((t) => t.kind)]));
    expect(d).toEqual({ 'coordinator>researcher': ['research'], 'coordinator>builder': ['code', 'fix'], 'coordinator>tester': ['test'] });
    const m = Object.fromEntries(g.messages.map((e) => [`${e.a}~${e.b}`, [e.count, e.aToB, e.bToA]]));
    expect(m).toEqual({ 'researcher~builder': [1, 1, 0], 'builder~tester': [1, 0, 1] });
    expect(g.nodes.find((n) => n.id === 'coordinator')!.identity).toBeNull();
    expect(g.nodes.find((n) => n.id === 'builder')!.identity).toBe(2);
    // Nothing reported usage in the scripted demo: none is shown (never zero).
    expect(g.nodes.every((n) => n.usage === null)).toBe(true);
  });

  it('shows a traced session: user → Claude → subagents, running calls, reported usage only', () => {
    const exec = foldExecution(tracedSession());
    const g = buildAgentGraph(exec);
    expect(g.delegations.map((e) => `${e.from}>${e.to}`)).toEqual(['user>main', 'main>sa-1', 'main>sa-2']);
    expect(g.delegations.find((e) => e.to === 'sa-1')!.active).toBe(true);
    expect(g.delegations.find((e) => e.to === 'sa-2')!.active).toBe(false);
    const sa1 = g.nodes.find((n) => n.id === 'sa-1')!;
    expect(sa1.call).toEqual({ tool: 'Read', category: 'read' });
    expect(sa1.usage).toBeNull();
    // Formatted by the shared helper (state/labels.ts), as in the inspector and agents table.
    expect(g.nodes.find((n) => n.id === 'sa-2')!.usage).toBe('21.8k tokens · haiku');
    expect(g.nodes.find((n) => n.id === 'main')!.usage).toBeNull();
    expect(g.messages.map((e) => [e.a, e.b, e.count])).toEqual([
      ['user', 'main', 1],
      ['main', 'sa-2', 1],
    ]);
    // Identity hues follow embodied registration order, as in the world and timeline.
    expect(['main', 'sa-1', 'sa-2'].map((id) => g.nodes.find((n) => n.id === id)!.identity)).toEqual([1, 2, 3]);
  });

});

describe('agent network layout', () => {
  it('puts delegators left of their delegates (longest path) and survives cycles', () => {
    const layers = layerOf(['u', 'm', 'a', 'b'], [
      { from: 'u', to: 'm' },
      { from: 'm', to: 'a' },
      { from: 'm', to: 'b' },
      { from: 'u', to: 'b' },
    ]);
    expect(Object.fromEntries(layers)).toEqual({ u: 0, m: 1, a: 2, b: 2 });
    const cyc = layerOf(['x', 'y'], [
      { from: 'x', to: 'y' },
      { from: 'y', to: 'x' },
    ]);
    expect([...cyc.values()].every((d) => d >= 0 && d < 2)).toBe(true);
  });

  it('lays out nodes without overlaps and wraps tall columns', () => {
    const ids = ['main', ...Array.from({ length: 9 }, (_, i) => `sa-${i}`)];
    const edges = ids.slice(1).map((to) => ({ from: 'main', to }));
    const { nodeW, nodeH } = DEFAULT_LAYOUT;
    for (const maxColumnHeight of [2000, 400]) {
      const l = layoutGraph(ids, edges, { ...DEFAULT_LAYOUT, maxColumnHeight });
      const boxes = ids.map((id) => l.positions.get(id)!);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          expect(Math.abs(a.x - b.x) >= nodeW || Math.abs(a.y - b.y) >= nodeH).toBe(true);
        }
      for (const p of boxes) {
        expect(p.x - nodeW / 2).toBeGreaterThanOrEqual(0);
        expect(p.x + nodeW / 2).toBeLessThanOrEqual(l.width);
        expect(p.y + nodeH / 2).toBeLessThanOrEqual(l.height);
      }
      expect(l.layers).toEqual([['main'], ids.slice(1)]);
    }
    // 400 px holds 3 nodes per column: 9 subagents wrap into 3 sub-columns.
    const wrapped = layoutGraph(ids, edges, { ...DEFAULT_LAYOUT, maxColumnHeight: 400 });
    const xs = [...new Set(ids.slice(1).map((id) => wrapped.positions.get(id)!.x))].sort((a, b) => a - b);
    expect(xs).toHaveLength(3);
    // Sub-columns keep room for a message label between them (not just the 16 px node gap).
    expect(xs[1]! - xs[0]! - DEFAULT_LAYOUT.nodeW).toBeGreaterThanOrEqual(40);
  });

  it('routes edges between columns side to side, and within a column around the right', () => {
    const h = edgeAnchors({ x: 100, y: 100 }, { x: 500, y: 300 }, 200);
    expect(h.mode).toBe('horizontal');
    expect(h.p0).toEqual({ x: 200, y: 100 });
    expect(h.p1).toEqual({ x: 400, y: 300 });
    const s = edgeAnchors({ x: 100, y: 100 }, { x: 100, y: 300 }, 200);
    expect(s.mode).toBe('side');
    const { mid } = edgePath(s.p0, s.p1, s.mode);
    expect(mid.x).toBeGreaterThan(200);
    expect(edgePath(h.p0, h.p1, h.mode).d.startsWith('M200.0,100.0 C')).toBe(true);
  });
});

describe('row layout (narrow panels: text is never scaled down)', () => {
  const ids = ['user', 'main', 'sa-1', 'sa-2'];
  const edges = [
    { from: 'user', to: 'main' },
    { from: 'main', to: 'sa-1' },
    { from: 'main', to: 'sa-2' },
  ];

  it('puts layers in rows, top to bottom, without overlaps, and is narrower than columns', () => {
    const { nodeW, nodeH } = DEFAULT_LAYOUT;
    const rows = layoutGraphDown(ids, edges, { ...DEFAULT_LAYOUT, gapX: 76, gapY: 24, maxColumnHeight: 700 });
    const cols = layoutGraph(ids, edges, DEFAULT_LAYOUT);
    const p = (id: string) => rows.positions.get(id)!;
    expect(p('user').y).toBeLessThan(p('main').y);
    expect(p('main').y).toBeLessThan(p('sa-1').y);
    expect(p('sa-1').y).toBe(p('sa-2').y);
    expect(Math.abs(p('sa-1').x - p('sa-2').x)).toBeGreaterThanOrEqual(nodeW);
    for (const id of ids) {
      expect(p(id).x - nodeW / 2).toBeGreaterThanOrEqual(0);
      expect(p(id).x + nodeW / 2).toBeLessThanOrEqual(rows.width);
      expect(p(id).y + nodeH / 2).toBeLessThanOrEqual(rows.height);
    }
    expect(rows.width).toBeLessThan(cols.width);
  });

  it('routes edges between rows bottom to top, and within a row under the cards', () => {
    const v = edgeAnchors({ x: 100, y: 100 }, { x: 300, y: 400 }, 232, 104, true);
    expect(v).toMatchObject({ mode: 'vertical', p0: { x: 100, y: 152 }, p1: { x: 300, y: 348 } });
    const u = edgeAnchors({ x: 100, y: 100 }, { x: 400, y: 100 }, 232, 104, true);
    expect(u.mode).toBe('under');
    expect(edgePath(u.p0, u.p1, u.mode).mid.y).toBeGreaterThan(152);
  });
});

describe('agent state after the run ended', () => {
  it('shows work left open as unfinished, not as working', () => {
    expect(runtimeStatusView('working')).toMatchObject({ text: 'working', tone: 'live' });
    for (const s of ['working', 'waiting', 'blocked'] as const) expect(runtimeStatusView(s, true)).toMatchObject({ text: 'unfinished', tone: 'muted' });
    expect(runtimeStatusView('done', true).text).toBe('done');
  });
});
