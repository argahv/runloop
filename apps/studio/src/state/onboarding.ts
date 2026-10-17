import type { RunSummary } from '@runloop-world/events';
import { isTracedRun } from './runs';

/**
 * The Overview's getting-started checklist. Steps 1–2 are read from the
 * runtime's runs; steps 3–5 are what this viewer has done in this browser
 * (a convenience kept in localStorage, never shared).
 */
export const ONBOARDING_STEPS = ['demo', 'connect', 'open', 'failure', 'replay'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingProgress {
  opened: boolean;
  inspectedFailure: boolean;
  replayed: boolean;
  dismissed: boolean;
}

export const EMPTY_ONBOARDING: OnboardingProgress = { opened: false, inspectedFailure: false, replayed: false, dismissed: false };
export const ONBOARDING_KEY = 'runloop.onboarding.v1';

export function parseOnboarding(raw: string | null): OnboardingProgress {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return EMPTY_ONBOARDING;
    const o = v as Record<string, unknown>;
    return { opened: o.opened === true, inspectedFailure: o.inspectedFailure === true, replayed: o.replayed === true, dismissed: o.dismissed === true };
  } catch {
    return EMPTY_ONBOARDING;
  }
}

export function stepsDone(p: OnboardingProgress, runs: readonly RunSummary[]): Record<OnboardingStep, boolean> {
  return {
    demo: runs.some((r) => !isTracedRun(r)),
    connect: runs.some(isTracedRun),
    open: p.opened,
    failure: p.inspectedFailure,
    replay: p.replayed,
  };
}

/** The first step not done yet, in order; null when all are done. */
export function nextStep(done: Record<OnboardingStep, boolean>): OnboardingStep | null {
  return ONBOARDING_STEPS.find((s) => !done[s]) ?? null;
}
