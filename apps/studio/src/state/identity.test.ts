import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import { identityColor, identityIndex } from './identity';

describe('agent identity hues', () => {
  const exec = foldExecution(codingMissionFixture());
  it('gives embodied agents hues in registration order and others a neutral colour', () => {
    expect(['researcher', 'builder', 'tester'].map((id) => identityIndex(exec, id))).toEqual([1, 2, 3]);
    expect(identityIndex(exec, 'coordinator')).toBeNull();
    expect(identityColor(exec, 'builder')).toBe('var(--rl-id-2)');
    expect(identityColor(exec, 'system')).toBe('var(--rl-id-neutral)');
  });
});
