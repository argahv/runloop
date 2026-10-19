/**
 * Game-style notifications (immersive contract §4.1, attention ticker row):
 * critical and attention items pop, and so do notables about real agents;
 * simulated notables only go to the bell's list (no popup, no sound). A real
 * agent's cue fact shows at once, with its sound; the rest one popup every 4 s
 * (critical skips the wait and stays until acted on); at most three on screen.
 * Pure; the timing is injected.
 */
import { nextTickerItem, type AttentionItem } from '../../../world/attention';

export const MAX_VISIBLE = 3;
/** Non-critical popups leave after this long (hovering keeps them). */
export const POPUP_MS = 8000;

/** Does this item pop up, or only wait in the bell's list? */
export function popupEligible(item: AttentionItem): boolean {
  if (item.resolved || item.severity === 'ambient') return false;
  if (item.severity === 'critical' || item.severity === 'attention') return true;
  // An agent going offline after its session closed is the normal end of work: the bell's list only.
  if (item.kind === 'agent_offline') return false;
  // Notables: real agents only (a session started, an agent came online, a task finished).
  return item.prov === 'external-agent' || item.prov === 'inferred' || item.refs.some((r) => r.kind === 'agent');
}

const FINISHED_DISPATCH = new Set(['completed', 'failed', 'timed_out', 'budget_exceeded', 'lost']);

/**
 * The fact behind a real-agent event cue (contract §4b: agent live, incident,
 * task done, needs approval). A cue never stands alone, so its notification
 * never waits behind the pacing: it shows with the sound.
 */
export function cueMatched(item: AttentionItem): boolean {
  switch (item.kind) {
    case 'agent_live':
    case 'incident':
    case 'permission':
    case 'dispatch_approval':
    case 'session_failed':
      return true;
    case 'session_ended':
      return item.detail === 'succeeded';
    case 'dispatch':
      return FINISHED_DISPATCH.has(item.detail ?? '');
    default:
      return false;
  }
}

/** Connection facts about one agent: a newer one makes an older notable stale. */
const CONNECTION = new Set<AttentionItem['kind']>(['agent_live', 'agent_offline', 'incident', 'permission', 'dispatch_approval', 'lost_mid_task']);

/**
 * A queued notable about an agent that newer facts have overtaken: a cue's
 * fact ("is live") once a newer connection fact arrived ("reported a
 * failure"); any other notable ("started a session") once a newer popup about
 * the same agent exists. It stays in the bell's list; it just never pops late.
 */
export function superseded(item: AttentionItem, items: readonly AttentionItem[]): boolean {
  const agent = item.refs[0]?.kind === 'agent' ? item.refs[0].id : null;
  if (!agent || item.severity !== 'notable') return false;
  const at = item.events?.last ?? 0;
  const newer = (o: AttentionItem) => o !== item && o.refs[0]?.id === agent && (o.events?.last ?? 0) > at;
  if (cueMatched(item)) return items.some((o) => newer(o) && CONNECTION.has(o.kind));
  return items.some((o) => newer(o) && popupEligible(o));
}

/**
 * The next popup, or null. Cue facts first and at once (with their sound);
 * the rest at most one every 4 s (critical skips the wait). Stale notables
 * never pop.
 */
export function nextPopup(items: readonly AttentionItem[], nowMs: number, lastShownMs: number, shown: ReadonlyMap<string, number>): AttentionItem | null {
  const eligible = items.filter((i) => popupEligible(i) && !superseded(i, items));
  return nextTickerItem(eligible.filter(cueMatched), nowMs, Number.NEGATIVE_INFINITY, shown) ?? nextTickerItem(eligible, nowMs, lastShownMs, shown);
}

/** Unresolved items that need the viewer (the bell's "⚠ n need you"). */
export function needsYou(items: readonly AttentionItem[]): number {
  return items.filter((i) => !i.resolved && (i.severity === 'critical' || i.severity === 'attention')).length;
}

/** Any unresolved critical item (it keeps a warning dot even with the HUD hidden). */
export const hasCritical = (items: readonly AttentionItem[]) => items.some((i) => !i.resolved && i.severity === 'critical');

export interface Popup {
  item: AttentionItem;
  shownAt: number;
}

/** Add a popup (newest first), drop expired non-critical ones, keep at most three (critical ones win). */
export function pushPopup(list: readonly Popup[], item: AttentionItem, nowMs: number): Popup[] {
  const rest = list.filter((p) => p.item.key !== item.key);
  return trimPopups([{ item, shownAt: nowMs }, ...rest], nowMs);
}

export function trimPopups(list: readonly Popup[], nowMs: number, holdKey: string | null = null): Popup[] {
  const alive = list.filter((p) => p.item.severity === 'critical' || p.item.key === holdKey || nowMs - p.shownAt < POPUP_MS);
  if (alive.length <= MAX_VISIBLE) return alive;
  const critical = alive.filter((p) => p.item.severity === 'critical');
  const other = alive.filter((p) => p.item.severity !== 'critical');
  return [...critical, ...other].slice(0, MAX_VISIBLE).sort((a, b) => b.shownAt - a.shownAt);
}
