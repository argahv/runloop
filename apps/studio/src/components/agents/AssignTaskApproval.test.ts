import { describe, expect, it } from 'vitest';
import { approvalOutcomeText } from './AssignTaskView';

describe('approval on the runtime page', () => {
  it('waits while the person reviews, and says nothing once a task started', () => {
    expect(approvalOutcomeText({ state: 'awaiting_approval', code: null, dispatchId: null })).toBeNull();
    expect(approvalOutcomeText({ state: 'approved', code: null, dispatchId: 'dsp_1' })).toBeNull();
  });

  it('says why nothing started, in words', () => {
    expect(approvalOutcomeText({ state: 'declined', code: null, dispatchId: null })).toMatch(/declined/);
    expect(approvalOutcomeText({ state: 'expired', code: null, dispatchId: null })).toMatch(/expired/);
    expect(approvalOutcomeText({ state: 'refused', code: 'workspace_moved', dispatchId: null })).toBe('The runtime refused it (workspace moved).');
    expect(approvalOutcomeText({ state: 'unknown', code: null, dispatchId: null })).toMatch(/no longer knows/);
    expect(approvalOutcomeText({ state: 'approved', code: null, dispatchId: null })).toMatch(/did not say which task/);
  });
});
