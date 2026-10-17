import { SequenceGapError, reduceExecution } from '@runloop-world/core';
import type { TaskKind } from '@runloop-world/events';
import { codingMissionFixture, mulberry32 } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { loadWorld } from './compile';
import type { Cell } from './definition';
import { arrivalTick, enteringCell, positionAt } from './motion';
import { presentationAt } from './presentation';
import { reduceWorld } from './reduce-world';
import { campus, campusJson, finalWorld, foldSteps, startRun, stateAtTick, type Step } from './test-utils';
import type { CompiledWorld, WorldState } from './types';

const TPC = 3;
const world = campus();
const pos = (w: WorldState, id: string, tick: number) => {
  const p = presentationAt(w.characters[id]!, tick, world);
  return [p.x, p.y];
};

/** Every character's position, sampled every `dt` ticks, never jumps more than one step allows. */
function expectContinuous(steps: readonly Step[], w: CompiledWorld, ids: string[], dt = 0.25) {
  const end = Math.max(...steps.map((s) => s.world.tick)) + 60;
  for (const id of ids) {
    const first = steps.find((s) => s.world.characters[id])!.world.tick;
    let prev: { x: number; y: number } | null = null;
    for (let t = first; t <= end; t += dt) {
      const c = stateAtTick(steps, t).characters[id]!;
      const p = presentationAt(c, t, w);
      if (prev) {
        const d = Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
        expect(d, `${id} jumped ${d} at tick ${t}`).toBeLessThanOrEqual(dt / w.def.ticksPerCell + 1e-9);
      }
      prev = p;
    }
  }
}

/** Motion paths are chains of 4-adjacent walkable cells. */
function expectValidPaths(steps: readonly Step[], w: CompiledWorld) {
  for (const s of steps) {
    for (const id of s.world.characterOrder) {
      const path = s.world.characters[id]!.motion.path;
      path.forEach((c, i) => {
        expect(w.isWalkable(...c), `[${c}] walkable`).toBe(true);
        if (i > 0) expect(Math.abs(c[0] - path[i - 1]![0]) + Math.abs(c[1] - path[i - 1]![1])).toBe(1);
      });
    }
  }
}

describe('reduceWorld — characters', () => {
  it('creates characters only for embodied agents, at their preset homes', () => {
    const w = finalWorld(codingMissionFixture(), world);
    expect(w.characterOrder).toEqual(['researcher', 'builder', 'tester']);
    expect(w.characters.coordinator).toBeUndefined();
    expect(w.characters.researcher!.home).toEqual(world.presetsById.researcher!.home);
    expect(w.characters.tester!.presetId).toBe('tester');
  });

  it('uses the default preset and offsets shared homes deterministically', () => {
    const b = startRun([
      { id: 'b1', preset: 'builder' },
      { id: 'b2', preset: 'builder' },
      { id: 'b3', preset: 'builder' },
      { id: 'x', preset: 'wizard' },
      { id: 'y' },
    ]);
    const w = finalWorld(b.events, world);
    const homes = w.characterOrder.map((id) => w.characters[id]!.home);
    // Offsets skip every preset's home (the subagent presets reserve the cells around the Atrium).
    expect(homes).toEqual([
      [13, 8],
      [13, 7],
      [13, 9],
      [13, 11],
      [13, 10],
    ]);
    expect(w.characters.x!.presetId).toBe('operator');
    expect(w.characters.y!.presetId).toBe('operator');
    expect(finalWorld(b.events, world)).toEqual(w);
    for (const h of homes) expect(world.isWalkable(...h)).toBe(true);
  });
});

describe('reduceWorld — ordering', () => {
  const events = codingMissionFixture();
  const steps = foldSteps(events, world);

  it('ignores already-folded sequences (same reference) and throws on gaps', () => {
    const s = steps[10]!;
    expect(reduceWorld(s.world, s.exec, events[10]!, world)).toBe(s.world);
    expect(reduceWorld(s.world, s.exec, events[2]!, world)).toBe(s.world);
    expect(() => reduceWorld(s.world, s.exec, events[12]!, world)).toThrow(SequenceGapError);
  });

  it('derives ticks from timestamps with a monotonic clamp', () => {
    const b = startRun([{ id: 'r', preset: 'researcher' }]);
    b.wait(1000).add('agent.state_changed', { agentId: 'r', state: 'working' });
    b.wait(-700).add('agent.state_changed', { agentId: 'r', state: 'idle' }); // clock went backwards
    b.wait(1200).add('agent.state_changed', { agentId: 'r', state: 'working' });
    expect(foldSteps(b.events, world).map((s) => s.world.tick)).toEqual([0, 1, 11, 11, 16]);
  });

  it('is deterministic: two folds give identical JSON', () => {
    expect(JSON.stringify(foldSteps(events, world).at(-1)!.world)).toBe(JSON.stringify(steps.at(-1)!.world));
  });
});

describe('reduceWorld — stations and motion', () => {
  function assignResearch() {
    const b = startRun([{ id: 'r', preset: 'researcher' }]); // ticks 0, 1
    b.wait(100).add('task.created', { taskId: 'T1', title: 't', kind: 'research', dependsOn: [] }); // 2
    b.wait(100).add('task.assigned', { taskId: 'T1', agentId: 'r' }); // 3
    return b;
  }

  it('reserves a slot at event time, walks there, then works on arrival', () => {
    const w = finalWorld(assignResearch().events, world);
    const c = w.characters.r!;
    expect(c).toMatchObject({ activity: 'working', taskId: 'T1', stationId: 'archive', sinceTick: 3 });
    expect(c.target).toEqual({ kind: 'slot', stationId: 'archive', index: 0 });
    expect(w.stations.archive!.slots).toEqual(['r']);
    expect(c.motion.startTick).toBe(3);
    const arrive = arrivalTick(c.motion, TPC);
    expect(arrive).toBe(3 + 11 * TPC);
    expect(presentationAt(c, 3, world).state).toBe('moving');
    expect(presentationAt(c, arrive - 0.5, world).state).toBe('moving');
    const there = presentationAt(c, arrive, world);
    expect(there).toMatchObject({ state: 'working', x: 3, y: 4, moving: false });
    expect(there.heading).toBeCloseTo(-Math.PI / 2); // facing the terminal to the north
  });

  it('failure while walking stops at the entering cell and releases the slot', () => {
    const b = assignResearch();
    b.wait(400).add('task.failed', { taskId: 'T1', reason: 'crashed' }); // tick 7: 4 ticks in → mid-step
    const steps = foldSteps(b.events, world);
    const before = steps.at(-2)!.world.characters.r!;
    const after = steps.at(-1)!.world;
    const c = after.characters.r!;
    expect(after.tick).toBe(7);
    expect(c).toMatchObject({ activity: 'failed', target: { kind: 'stay' }, stationId: null });
    expect(after.stations.archive!.slots).toEqual([null]);

    const entering = enteringCell(before.motion, 7, TPC);
    expect(positionAt(before.motion, 7, TPC).frac).toBeGreaterThan(0);
    expect(positionAt(c.motion, 1e6, TPC)).toMatchObject({ x: entering[0], y: entering[1], arrived: true });
    expect(pos(after, 'r', 7)).toEqual(pos(steps.at(-2)!.world, 'r', 7)); // no teleport
    expect(presentationAt(c, 7.5, world)).toMatchObject({ state: 'failed', moving: true }); // failed overrides moving
    expect(presentationAt(c, 100, world)).toMatchObject({ state: 'failed', moving: false });

    // The freed slot is available to the next researcher.
    b.wait(100).add('agent.registered', {
      agentId: 'r2',
      name: 'r2',
      role: 'r',
      model: null,
      tools: [],
      embodied: true,
      characterPreset: 'researcher',
    });
    b.wait(100).add('task.created', { taskId: 'T2', title: 't', kind: 'research', dependsOn: [] });
    b.wait(100).add('task.assigned', { taskId: 'T2', agentId: 'r2' });
    const w = finalWorld(b.events, world);
    expect(w.characters.r2!.target).toEqual({ kind: 'slot', stationId: 'archive', index: 0 });
    expect(w.characters.r!.activity).toBe('failed'); // still frozen in place
  });

  it('queues at the overflow cell when every slot is taken and promotes on release', () => {
    const b = startRun([
      { id: 'b1', preset: 'builder' },
      { id: 'b2', preset: 'builder' },
      { id: 'b3', preset: 'builder' },
    ]);
    for (const t of ['T1', 'T2', 'T3']) b.wait(100).add('task.created', { taskId: t, title: t, kind: 'code', dependsOn: [] });
    b.wait(100).add('task.assigned', { taskId: 'T1', agentId: 'b1' });
    b.wait(100).add('task.assigned', { taskId: 'T2', agentId: 'b2' });
    b.wait(100).add('task.assigned', { taskId: 'T3', agentId: 'b3' });
    let w = finalWorld(b.events, world);
    expect(w.characters.b1!.target).toEqual({ kind: 'slot', stationId: 'assembler', index: 0 });
    expect(w.characters.b2!.target).toEqual({ kind: 'slot', stationId: 'forge', index: 0 });
    expect(w.characters.b3!.target).toEqual({ kind: 'overflow', stationId: 'assembler' });
    expect(w.stations.assembler).toEqual({ slots: ['b1'], overflow: ['b3'] });
    const queued = w.characters.b3!;
    expect(presentationAt(queued, arrivalTick(queued.motion, TPC), world).state).toBe('waiting');

    b.wait(5000).add('task.completed', { taskId: 'T1', summary: 'ok', artifactIds: [] });
    const steps = foldSteps(b.events, world);
    w = steps.at(-1)!.world;
    expect(w.stations.assembler).toEqual({ slots: ['b3'], overflow: [] });
    expect(w.characters.b1).toMatchObject({ activity: 'succeeded', target: { kind: 'home' }, stationId: null });
    const promoted = w.characters.b3!;
    expect(promoted).toMatchObject({ activity: 'working', stationId: 'assembler' });
    expect(promoted.target).toEqual({ kind: 'slot', stationId: 'assembler', index: 0 });
    expect(promoted.motion.path.at(-1)).toEqual([20, 4]);
    expect(presentationAt(promoted, arrivalTick(promoted.motion, TPC), world).state).toBe('working');
    expectContinuous(steps, world, ['b1', 'b2', 'b3']);
  });

  it('mid-walk reassignments never move a character more than one cell per tick', () => {
    const rand = mulberry32(1234);
    const kinds: TaskKind[] = ['research', 'code', 'test', 'fix', 'deploy', 'approval'];
    const b = startRun([
      { id: 'r', preset: 'researcher' },
      { id: 't', preset: 'tester' },
    ]);
    for (let i = 1; i <= 40; i++) {
      const agentId = rand() < 0.7 ? 'r' : 't';
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      b.wait(100 + Math.floor(rand() * 1400)).add('task.created', { taskId: `T${i}`, title: '', kind, dependsOn: [] });
      b.wait(100).add('task.assigned', { taskId: `T${i}`, agentId });
      if (rand() < 0.2) b.wait(Math.floor(rand() * 500)).add('task.blocked', { taskId: `T${i}`, reason: 'wait' });
    }
    const steps = foldSteps(b.events, world);
    expect(steps.at(-1)!.exec.anomalies).toEqual([]);
    // Several interruptions really happened mid-step.
    let midStep = 0;
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1]!.world.characters.r;
      if (prev && steps[i]!.world.characters.r!.motion !== prev.motion && positionAt(prev.motion, steps[i]!.world.tick, TPC).frac > 0) midStep++;
    }
    expect(midStep).toBeGreaterThan(3);
    expectContinuous(steps, world, ['r', 't']);
    expectValidPaths(steps, world);
  });

  it('swapping activityRules changes the target station', () => {
    const def = campusJson();
    def.activityRules = def.activityRules.map((r) =>
      r.when.taskKind?.includes('research') ? { ...r, stationKind: 'build' as const } : r,
    );
    const swapped = loadWorld(def);
    const events = assignResearch().events;
    expect(finalWorld(events, world).characters.r!.stationId).toBe('archive');
    expect(finalWorld(events, swapped).characters.r!.stationId).toBe('assembler');
    expect(finalWorld(events, swapped).characters.r!.motion.path.at(-1)).toEqual([20, 4]);
  });
});

describe('reduceWorld — intents', () => {
  it('blocked → waiting at home; permission → awaiting approval at the gate', () => {
    const b = startRun([{ id: 't', preset: 'tester' }]);
    b.wait(100).add('task.created', { taskId: 'T1', title: '', kind: 'test', dependsOn: [] });
    b.wait(100).add('task.started', { taskId: 'T1', agentId: 't' });
    let w = finalWorld(b.events, world);
    expect(w.characters.t).toMatchObject({ activity: 'working', stationId: 'probe' });

    b.wait(500).add('tool.permission_requested', { permissionId: 'p1', agentId: 't', action: 'deploy', scope: 'prod' });
    w = finalWorld(b.events, world);
    expect(w.characters.t).toMatchObject({ activity: 'awaiting_approval', stationId: 'gate', taskId: 'T1' });
    expect(w.stations.probe!.slots).toEqual([null]);
    expect(w.stations.gate!.slots).toEqual(['t']);
    expect(presentationAt(w.characters.t!, w.tick + 1, world).state).toBe('awaiting_approval'); // even while walking

    b.wait(3000).add('tool.permission_resolved', { permissionId: 'p1', decision: 'approved', by: 'user' });
    w = finalWorld(b.events, world);
    expect(w.characters.t).toMatchObject({ activity: 'working', stationId: 'probe' });

    b.wait(3000).add('task.blocked', { taskId: 'T1', reason: 'needs fix' });
    const steps = foldSteps(b.events, world);
    w = steps.at(-1)!.world;
    const c = w.characters.t!;
    expect(c).toMatchObject({ activity: 'waiting', target: { kind: 'home' }, stationId: null });
    expect(c.motion.path.at(-1)).toEqual(c.home);
    expect(presentationAt(c, arrivalTick(c.motion, TPC), world).state).toBe('waiting');
    expectContinuous(steps, world, ['t']);
  });

  it('pause freezes intents and stops walkers at the entering cell; resume carries on', () => {
    const b = startRun([{ id: 'r', preset: 'researcher' }]);
    b.wait(100).add('task.created', { taskId: 'T1', title: '', kind: 'research', dependsOn: [] });
    b.wait(100).add('task.assigned', { taskId: 'T1', agentId: 'r' }); // tick 3
    b.wait(400).add('run.paused', {}); // tick 7, mid-step
    b.wait(1000).add('task.completed', { taskId: 'T1', summary: '', artifactIds: [] }); // tick 17
    let steps = foldSteps(b.events, world);
    const walking = steps.at(-3)!.world.characters.r!;
    let w = steps.at(-1)!.world;
    expect(w.paused).toBe(true);
    const c = w.characters.r!;
    expect(c.activity).toBe('working'); // frozen: the completion is not applied while paused
    expect(positionAt(c.motion, 1e6, TPC)).toMatchObject({ arrived: true });
    expect(c.motion.path.at(-1)).toEqual(enteringCell(walking.motion, 7, TPC));
    expect(presentationAt(c, 17, world, { paused: true }).state).toBe('paused');

    b.wait(1000).add('run.resumed', {}); // tick 27
    steps = foldSteps(b.events, world);
    w = steps.at(-1)!.world;
    expect(w.paused).toBe(false);
    // The completion happened during the pause, so there is no success reaction now: just idle.
    expect(w.characters.r).toMatchObject({ activity: 'idle', target: { kind: 'home' } });
    expect(w.characters.r!.motion.path.at(-1)).toEqual(w.characters.r!.home);
    expect(w.stations.archive!.slots).toEqual([null]);
    expectContinuous(steps, world, ['r']);
  });

  it('a pause without pending changes resumes the walk to the same slot', () => {
    const b = startRun([{ id: 'r', preset: 'researcher' }]);
    b.wait(100).add('task.created', { taskId: 'T1', title: '', kind: 'research', dependsOn: [] });
    b.wait(100).add('task.assigned', { taskId: 'T1', agentId: 'r' });
    b.wait(400).add('run.paused', {});
    b.wait(2000).add('run.resumed', {});
    const steps = foldSteps(b.events, world);
    const c = steps.at(-1)!.world.characters.r!;
    expect(c.motion.path.at(-1)).toEqual([3, 4] satisfies Cell);
    expect(presentationAt(c, arrivalTick(c.motion, TPC), world).state).toBe('working');
    expectContinuous(steps, world, ['r']);
  });
});

describe('reduceWorld — ended runs and success reactions', () => {
  /** Tester working on T1 at the probe, mid tool call. */
  function testerAtWork() {
    const b = startRun([{ id: 't', preset: 'tester' }]);
    b.wait(100).add('task.created', { taskId: 'T1', title: '', kind: 'test', dependsOn: [] });
    b.wait(100).add('task.started', { taskId: 'T1', agentId: 't' });
    b.wait(3000).add('tool.call_started', { callId: 'c1', agentId: 't', taskId: 'T1', tool: 'run_command', inputSummary: 'node --test' });
    return b;
  }

  function expectSentHome(steps: Step[]) {
    const w = steps.at(-1)!.world;
    const c = w.characters.t!;
    expect(steps.at(-1)!.exec.tasks.T1!.status).toBe('in_progress'); // Layer 1 still records the unfinished task
    expect(c).toMatchObject({ activity: 'idle', taskId: null, stationId: null, target: { kind: 'home' } });
    expect(w.stations.probe!.slots).toEqual([null]);
    expect(c.motion.path.at(-1)).toEqual(c.home);
    expect(presentationAt(c, w.tick + 600, world).state).toBe('idle');
    expectContinuous(steps, world, ['t']);
  }

  it('a stopped run sends a working character home idle and frees its slot', () => {
    const b = testerAtWork();
    expect(finalWorld(b.events, world).characters.t).toMatchObject({ activity: 'working', stationId: 'probe' });
    b.wait(250).add('tool.call_failed', { callId: 'c1', errorType: 'aborted', message: 'stopped', durationMs: 250 });
    b.wait(10).add('run.completed', { outcome: 'stopped', summary: 'Stopped by user' });
    expectSentHome(foldSteps(b.events, world));
  });

  it('an interrupted run (boot recovery) does the same', () => {
    const b = testerAtWork();
    b.wait(1).add('tool.call_failed', { callId: 'c1', errorType: 'runtime_restarted', message: 'restarted', durationMs: 0 });
    b.add('run.completed', { outcome: 'interrupted', summary: 'The runtime restarted' });
    expectSentHome(foldSteps(b.events, world));
  });

  it('shows succeeded only on the completing event, never for an old completion', () => {
    const b = startRun([{ id: 'a', preset: 'builder' }, { id: 'b', preset: 'researcher' }]);
    b.wait(100).add('task.created', { taskId: 'T1', title: '', kind: 'code', dependsOn: [] });
    b.wait(100).add('task.started', { taskId: 'T1', agentId: 'a' });
    b.wait(3000).add('task.completed', { taskId: 'T1', summary: '', artifactIds: [] });
    let w = finalWorld(b.events, world);
    expect(w.characters.a).toMatchObject({ activity: 'succeeded', taskId: 'T1', sinceTick: w.tick });
    expect(presentationAt(w.characters.a!, w.tick + 1, world).state).toBe('succeeded');

    // A later unrelated event keeps the reaction (and its start tick) until presentation fades it.
    b.wait(500).add('agent.state_changed', { agentId: 'b', state: 'idle' });
    const kept = finalWorld(b.events, world).characters.a!;
    expect(kept).toMatchObject({ activity: 'succeeded', sinceTick: w.tick });

    // 10 s later a new task is assigned, then reassigned away: back to idle, not a fresh ✓.
    b.wait(10_000).add('task.created', { taskId: 'T2', title: '', kind: 'code', dependsOn: [] });
    b.wait(100).add('task.assigned', { taskId: 'T2', agentId: 'a' });
    expect(finalWorld(b.events, world).characters.a!.activity).toBe('working');
    b.wait(2000).add('task.assigned', { taskId: 'T2', agentId: 'b' });
    w = finalWorld(b.events, world);
    expect(w.characters.a).toMatchObject({ activity: 'idle', taskId: null });
    expect(presentationAt(w.characters.a!, w.tick + 1, world).state).not.toBe('succeeded');

    // A denied permission long after a completion is not a success either.
    b.wait(100).add('tool.permission_requested', { permissionId: 'p1', agentId: 'a', action: 'deploy', scope: 'prod' });
    expect(finalWorld(b.events, world).characters.a!.activity).toBe('awaiting_approval');
    b.wait(60_000).add('tool.permission_resolved', { permissionId: 'p1', decision: 'denied', by: 'user' });
    w = finalWorld(b.events, world);
    expect(w.characters.a).toMatchObject({ activity: 'idle', taskId: null });
  });
});

describe('reduceWorld — coding mission', () => {
  const events = codingMissionFixture();
  const steps = foldSteps(events, world);
  const w = steps.at(-1)!.world;

  it('sends each agent to the station for its task kind', () => {
    const stationOf = (agentId: string, taskId: string) =>
      steps.find((s) => s.world.characters[agentId]?.taskId === taskId && s.world.characters[agentId]!.activity === 'working')
        ?.world.characters[agentId]!.stationId;
    expect(stationOf('researcher', 'T1')).toBe('archive');
    expect(stationOf('builder', 'T2')).toBe('assembler');
    expect(stationOf('tester', 'T3')).toBe('probe');
    expect(stationOf('builder', 'T4')).toBe('assembler');
    const blocked = steps.find((s) => s.event.type === 'task.blocked')!.world.characters.tester!;
    expect(blocked).toMatchObject({ activity: 'waiting', target: { kind: 'home' } });
  });

  it('ends with every slot free and everyone heading home', () => {
    for (const st of Object.values(w.stations)) {
      expect(st.slots.every((s) => s === null)).toBe(true);
      expect(st.overflow).toEqual([]);
    }
    for (const id of w.characterOrder) {
      const c = w.characters[id]!;
      expect(c.activity).toBe('succeeded');
      expect(c.motion.path.at(-1)).toEqual(c.home);
    }
  });

  it('moves continuously along walkable paths', () => {
    expectContinuous(steps, world, w.characterOrder, 0.5);
    expectValidPaths(steps, world);
  });

  it('matches a fold that starts from a mid-run snapshot', () => {
    let exec = steps[29]!.exec;
    let ws = steps[29]!.world;
    for (const e of events.slice(30)) {
      exec = reduceExecution(exec, e);
      ws = reduceWorld(ws, exec, e, world);
    }
    expect(ws).toEqual(w);
  });
});
