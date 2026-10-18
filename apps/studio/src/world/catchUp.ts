/**
 * "While you were away" (UX draft §5): a templated summary of the world
 * events since the viewer last looked. No model writes it: every line is an
 * attention group over the raw events, cites its seq range, and its count is
 * a recount of those events.
 */
import type { AgentPresence, EntityRef, WorldEvent } from '@runloop-world/events';
import { compareItems, foldAttentionLog, SEVERITY_RANK, type AttentionItem } from './attention';

export interface CatchUp {
  fromSeq: number;
  toSeq: number;
  /** Events read (seqs can have gaps where ambient events were pruned). */
  eventCount: number;
  simMinutes: number;
  /** Lines about the viewer's agents, first. */
  agents: AttentionItem[];
  /** The top town groups (at most 5). */
  town: AttentionItem[];
}

/** Shown when the viewer missed at least an hour of sim time, or 5 notable things. */
export const CATCH_UP_MIN_TICKS = 60;
export const CATCH_UP_MIN_ITEMS = 5;
export const CATCH_UP_TOWN_LINES = 5;

type Presence = Pick<AgentPresence, 'health' | 'attention' | 'activeRunId'>;

/**
 * Summarise `events` after `fromSeq` (events at or before it are ignored), or
 * null when there is not enough to say. `presence` is each agent's state at
 * `fromSeq` when known (it tells "went offline mid-session" apart).
 */
export function summarizeSince(events: readonly WorldEvent[], fromSeq: number, presence: ReadonlyMap<string, Presence> = new Map()): CatchUp | null {
  const since = events.filter((e) => e.seq > fromSeq);
  if (since.length === 0) return null;
  // One group per subject for the whole gap (no 10-minute window).
  const items = foldAttentionLog([], since, presence, Number.POSITIVE_INFINITY);
  const shown = items.filter((it) => it.severity !== 'ambient');
  const first = since[0]!;
  const last = since[since.length - 1]!;
  const simMinutes = last.tick - first.tick;
  const notable = shown.filter((it) => SEVERITY_RANK[it.severity] <= SEVERITY_RANK.notable).length;
  if (simMinutes < CATCH_UP_MIN_TICKS && notable < CATCH_UP_MIN_ITEMS) return null;
  const isAgent = (it: AttentionItem) => it.refs[0]?.kind === 'agent';
  const byImportance = (a: AttentionItem, b: AttentionItem) => compareItems(a, b) || (b.events?.count ?? 0) - (a.events?.count ?? 0);
  return {
    fromSeq: first.seq,
    toSeq: last.seq,
    eventCount: since.length,
    simMinutes,
    agents: shown.filter(isAgent).sort(byImportance),
    town: shown
      .filter((it) => !isAgent(it))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.events?.count ?? 0) - (a.events?.count ?? 0) || compareItems(a, b))
      .slice(0, CATCH_UP_TOWN_LINES),
  };
}

/** "From 1,284 recorded events (seq 5,120–6,404)" */
export function catchUpFooter(c: CatchUp): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return `From ${n(c.eventCount)} recorded ${c.eventCount === 1 ? 'event' : 'events'} (seq ${n(c.fromSeq)}–${n(c.toSeq)})`;
}

/** The entity a line is about, if any (for links). */
export const lineSubject = (it: AttentionItem): EntityRef | null => it.refs[0] ?? null;
