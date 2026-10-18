import type { RunSummary } from '@runloop-world/events';
import { ROUTES } from './deeplink';

/**
 * Baselines and the compare pair (Milestone C). A baseline is a run the
 * runtime has pinned (`pinnedAt`, persisted in its database). Experiments
 * compares a baseline (A) with a candidate (B): `?a=<runId>&b=<runId>`.
 */

export const isPinned = (run: RunSummary | null | undefined): boolean => typeof run?.pinnedAt === 'string';

/** Pinned runs, most recently pinned first. */
export function pinnedRuns(runs: readonly RunSummary[]): RunSummary[] {
  return runs.filter(isPinned).sort((x, y) => Date.parse(y.pinnedAt!) - Date.parse(x.pinnedAt!));
}

export interface ComparePair {
  a: string | null;
  b: string | null;
}

/** `?a=&b=` from a query string (empty values are absent). */
export function parseComparePair(params: URLSearchParams): ComparePair {
  return { a: params.get('a') || null, b: params.get('b') || null };
}

/** The Experiments URL for a pair (absent sides are left out). */
export function compareHref(pair: ComparePair): string {
  const params = new URLSearchParams();
  if (pair.a) params.set('a', pair.a);
  if (pair.b) params.set('b', pair.b);
  const q = params.toString();
  return q ? `${ROUTES.experiments}?${q}` : ROUTES.experiments;
}

/** Runs of the same task: the same mission and, for traced runs, the same project. */
export function sameTask(x: RunSummary, y: RunSummary): boolean {
  return x.missionId === y.missionId && (x.source?.projectLabel ?? null) === (y.source?.projectLabel ?? null);
}

/**
 * The pair to show. Ids the URL names are kept as they are (an unknown one
 * shows as "not found"). Missing sides are filled: A with the most recently
 * pinned run, B with the newest other run of the same task, else the newest
 * other run (`runs` is newest first).
 */
export function resolvePair(runs: readonly RunSummary[], requested: ComparePair): ComparePair {
  const a = requested.a ?? pinnedRuns(runs)[0]?.runId ?? null;
  const base = runs.find((r) => r.runId === a);
  const others = runs.filter((r) => r.runId !== a);
  const b = requested.b ?? (base ? others.find((r) => sameTask(r, base)) : undefined)?.runId ?? others[0]?.runId ?? null;
  return { a, b };
}

/**
 * The baseline to compare a run against: the newest pinned run of the same
 * task (null when there is none; a pin of another task is not its baseline,
 * so "Compare" never pairs a demo run with a Claude Code session).
 */
export function baselineFor(runs: readonly RunSummary[], runId: string): RunSummary | null {
  const run = runs.find((r) => r.runId === runId);
  if (!run) return null;
  return pinnedRuns(runs).find((r) => r.runId !== runId && sameTask(r, run)) ?? null;
}
