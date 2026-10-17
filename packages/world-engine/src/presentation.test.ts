import { describe, expect, it } from 'vitest';
import { gridToScene, presentationAt, stationWorkCell, SUCCESS_DECAY_TICKS } from './presentation';
import { campus } from './test-utils';
import type { CharacterWorld } from './types';

const world = campus();

function character(patch: Partial<CharacterWorld>): CharacterWorld {
  return {
    agentId: 'a',
    presetId: 'builder',
    home: [13, 8],
    activity: 'idle',
    taskId: null,
    stationId: null,
    target: { kind: 'home' },
    motion: { path: [[13, 8]], startTick: 0 },
    sinceTick: 0,
    ...patch,
  };
}

const walking = { path: [[13, 8], [14, 8], [15, 8]] as [number, number][], startTick: 10 };

describe('presentationAt', () => {
  it('shows moving while walking and the activity once arrived', () => {
    const c = character({ activity: 'working', motion: walking, target: { kind: 'slot', stationId: 'forge', index: 0 } });
    expect(presentationAt(c, 11, world)).toMatchObject({ state: 'moving', moving: true, cell: [14, 8], heading: 0 });
    expect(presentationAt(c, 11, world).x).toBeCloseTo(13 + 1 / 3);
    expect(presentationAt(c, 16, world)).toMatchObject({ state: 'working', moving: false, x: 15, y: 8 });
  });

  it('lets failed and awaiting_approval override moving', () => {
    expect(presentationAt(character({ activity: 'failed', motion: walking }), 11, world)).toMatchObject({
      state: 'failed',
      moving: true,
    });
    expect(presentationAt(character({ activity: 'awaiting_approval', motion: walking }), 11, world).state).toBe(
      'awaiting_approval',
    );
  });

  it('shows paused when the run is paused', () => {
    expect(presentationAt(character({ activity: 'working', motion: walking }), 11, world, { paused: true }).state).toBe(
      'paused',
    );
    expect(presentationAt(character({ activity: 'failed' }), 11, world, { paused: true }).state).toBe('failed');
  });

  it('shows waiting when queued at an overflow cell', () => {
    const c = character({ activity: 'working', target: { kind: 'overflow', stationId: 'assembler' } });
    expect(presentationAt(c, 5, world).state).toBe('waiting');
  });

  it('shows succeeded briefly, then idle (or moving while still walking home)', () => {
    const c = character({ activity: 'succeeded', sinceTick: 10, motion: { ...walking, path: [...walking.path, [16, 8], [17, 8], [18, 8], [19, 8], [20, 8], [21, 8], [22, 8], [23, 8]] } });
    expect(presentationAt(c, 12, world)).toMatchObject({ state: 'succeeded', moving: true });
    expect(presentationAt(c, 10 + SUCCESS_DECAY_TICKS + 1, world).state).toBe('moving');
    expect(presentationAt(c, 100, world).state).toBe('idle');
    expect(presentationAt(character({ activity: 'succeeded', sinceTick: 0 }), 5, world).state).toBe('succeeded');
  });

  it('faces the station when working and the hub when idle at home', () => {
    const atForge = character({ activity: 'working', motion: { path: [[17, 4]], startTick: 0 }, target: { kind: 'slot', stationId: 'forge', index: 0 } });
    expect(presentationAt(atForge, 5, world).heading).toBeCloseTo(-Math.PI / 2);
    const idle = presentationAt(character({}), 5, world).heading;
    expect(idle).toBeCloseTo(Math.atan2(9.5 - 8, 11.5 - 13));
  });
});

describe('gridToScene / stationWorkCell', () => {
  it('centres the grid on the origin with 1 unit per cell', () => {
    expect(gridToScene(0, 0, world)).toEqual({ x: -11.5, z: -9.5 });
    expect(gridToScene(23, 19, world)).toEqual({ x: 11.5, z: 9.5 });
    expect(gridToScene(11.5, 9.5, world)).toEqual({ x: 0, z: 0 });
  });

  it('returns slot cells and falls back to the overflow cell', () => {
    expect(stationWorkCell(world, 'archive', 0)).toEqual([3, 4]);
    expect(stationWorkCell(world, 'archive', 3)).toEqual([4, 5]);
    expect(() => stationWorkCell(world, 'nope', 0)).toThrow();
  });
});
