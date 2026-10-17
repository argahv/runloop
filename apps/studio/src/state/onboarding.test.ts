import type { RunSummary } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { EMPTY_ONBOARDING, nextStep, parseOnboarding, stepsDone } from './onboarding';

const base: RunSummary = {
  runId: 'r1',
  title: 't',
  missionId: 'coding-mission',
  worldId: 'research-campus',
  status: 'succeeded',
  createdAt: '2026-10-17T10:00:00.000Z',
  endedAt: null,
  lastSequence: 1,
  adapterLabel: 'Scripted',
  paused: false,
};
const traced: RunSummary = { ...base, runId: 'r2', mode: 'traced', source: { kind: 'claude-code', sessionId: 's', segment: 1, projectLabel: 'p' } };

describe('getting-started checklist', () => {
  it('parses stored progress tolerantly', () => {
    expect(parseOnboarding(null)).toEqual(EMPTY_ONBOARDING);
    expect(parseOnboarding('not json')).toEqual(EMPTY_ONBOARDING);
    expect(parseOnboarding('{"opened":true,"replayed":"yes"}')).toEqual({ ...EMPTY_ONBOARDING, opened: true });
  });

  it('reads the first two steps from the runtime, the rest from this viewer', () => {
    expect(stepsDone(EMPTY_ONBOARDING, [])).toEqual({ demo: false, connect: false, open: false, failure: false, replay: false });
    expect(stepsDone({ ...EMPTY_ONBOARDING, replayed: true }, [base, traced])).toEqual({ demo: true, connect: true, open: false, failure: false, replay: true });
  });

  it('points at the first step not done, in order', () => {
    expect(nextStep(stepsDone(EMPTY_ONBOARDING, [traced]))).toBe('demo');
    expect(nextStep(stepsDone(EMPTY_ONBOARDING, [base]))).toBe('connect');
    expect(nextStep(stepsDone({ opened: true, inspectedFailure: true, replayed: true, dismissed: false }, [base, traced]))).toBeNull();
  });
});
