import type { RunSummary } from '@runloop-world/events';
import { ROUTES } from './deeplink';

/** Run number as shown in the UI: #1 is the oldest run (the list is newest first). */
export function runNumber(runs: readonly RunSummary[], runId: string | null): number | null {
  const i = runId ? runs.findIndex((r) => r.runId === runId) : -1;
  return i >= 0 ? runs.length - i : null;
}

/** "17:42" today, "Oct 16 · 17:42" otherwise (local time). */
export function formatWhen(iso: string | null, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`;
}

/** Wall-clock length of a run from its summary (null while unknown). */
export function runDurationMs(run: RunSummary, nowMs = Date.now()): number | null {
  const start = Date.parse(run.createdAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : run.status === 'running' ? nowMs : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export const AREA_LABEL: Record<string, string> = {
  [ROUTES.overview]: 'Overview',
  [ROUTES.world]: 'Live World',
  [ROUTES.traces]: 'Traces',
  [ROUTES.experiments]: 'Experiments',
  [ROUTES.integrations]: 'Integrations',
  [ROUTES.settings]: 'Settings',
};

/** The area a pathname belongs to ('/world/' → '/world'). */
export function areaOf(pathname: string): string {
  const p = pathname.replace(/\/+$/, '') || '/';
  return Object.keys(AREA_LABEL).find((r) => p === r || p.startsWith(`${r}/`)) ?? p;
}

export function isRunPage(pathname: string): boolean {
  const a = areaOf(pathname);
  return a === ROUTES.world || a === ROUTES.traces;
}
