import type { RunSummary } from '@runloop-world/events';

/**
 * Run-list helpers that work from summaries alone (the lists never load each
 * run's events). Newer runtime fields (mode, source, lastEventAt) are read
 * defensively so older runtimes still work.
 */

/** Recorded from an external agent (Claude Code), as opposed to executed by Runloop. */
export function isTracedRun(run: RunSummary | null | undefined): boolean {
  return !!run && (run.mode === 'traced' || (run.source !== undefined && run.source !== null));
}

const SOURCE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code' };

/** "Traced · Claude Code" or "Executed" (design-system.md, Provenance labelling). */
export function runSourceLabel(run: RunSummary): string {
  if (!isTracedRun(run)) return 'Executed';
  const kind = run.source?.kind;
  return `Traced · ${kind ? (SOURCE_LABEL[kind] ?? kind) : 'external source'}`;
}

/** First 8 characters of a session id (enough to tell sessions apart). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A second line that tells same-titled runs apart: "demo · session 448e50c5 · part 2". */
export function runSubtitle(run: RunSummary): string | null {
  const src = run.source;
  if (!src) return null;
  return `${src.projectLabel} · session ${shortId(src.sessionId)}${src.segment > 1 ? ` · part ${src.segment}` : ''}`;
}

/** Time since the run's last recorded event; null when the runtime does not report it. */
export function idleMs(run: RunSummary, nowMs: number): number | null {
  const t = run.lastEventAt ? Date.parse(run.lastEventAt) : NaN;
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

/** 42 s → "<1m", 5 min → "5m", 125 min → "2h 05m", 50 h → "2d". */
export function formatAgo(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Idle this long or more reads as "idle"; shorter means events are still arriving. */
export const IDLE_AFTER_MS = 60_000;

/** "active" while events keep arriving, "idle 5m" after a minute without any; null if unknown. */
export function activityText(run: RunSummary, nowMs: number): string | null {
  const idle = idleMs(run, nowMs);
  if (idle === null) return null;
  return idle < IDLE_AFTER_MS ? 'active' : `idle ${formatAgo(idle)}`;
}

export interface RunGroups {
  /** Recording right now (traced sessions first, then a running demo). */
  live: RunSummary[];
  /** Finished Claude Code sessions. */
  traced: RunSummary[];
  /** Finished scripted demo runs (executed by Runloop). */
  demo: RunSummary[];
}

/** Split runs (newest first) into live sessions, traced history and demo history; order is kept. */
export function groupRuns(runs: readonly RunSummary[]): RunGroups {
  const live = runs.filter((r) => r.status === 'running');
  return {
    live: [...live.filter(isTracedRun), ...live.filter((r) => !isTracedRun(r))],
    traced: runs.filter((r) => r.status !== 'running' && isTracedRun(r)),
    demo: runs.filter((r) => r.status !== 'running' && !isTracedRun(r)),
  };
}

/**
 * The run to open when nothing is open (plan §7.4): the active scripted run,
 * else the newest live traced session, else the newest run.
 */
export function pickRunToOpen(activeRunId: string | null, tracedRunIds: readonly string[], runs: readonly RunSummary[]): string | null {
  return activeRunId ?? tracedRunIds[0] ?? runs[0]?.runId ?? null;
}

/** Newest lastEventAt among traced runs (when Claude Code last sent anything recorded). */
export function lastTracedEventAt(runs: readonly RunSummary[]): string | null {
  let best: string | null = null;
  for (const r of runs) {
    if (!isTracedRun(r) || !r.lastEventAt) continue;
    if (best === null || Date.parse(r.lastEventAt) > Date.parse(best)) best = r.lastEventAt;
  }
  return best;
}
