/**
 * Game-style notifications (immersive contract §4.1, attention ticker row):
 * critical and attention items pop, and so do notables about real agents;
 * simulated notables only go to the bell's list (no popup, no sound). One
 * popup every 4 s (critical skips the wait and stays until acted on); at most
 * three on screen. Pure; the timing is injected.
 */
import { nextTickerItem, type AttentionItem } from '../../../world/attention';

export const MAX_VISIBLE = 3;
/** Non-critical popups leave after this long (hovering keeps them). */
export const POPUP_MS = 8000;

/** Does this item pop up, or only wait in the bell's list? */
export function popupEligible(item: AttentionItem): boolean {
  if (item.resolved || item.severity === 'ambient') return false;
  if (item.severity === 'critical' || item.severity === 'attention') return true;
  // Notables: real agents only (a session started, an agent came online, a task finished).
  return item.prov === 'external-agent' || item.prov === 'inferred' || item.refs.some((r) => r.kind === 'agent');
}

/** The next popup, or null (same pacing as the old ticker, eligible items only). */
export function nextPopup(items: readonly AttentionItem[], nowMs: number, lastShownMs: number, shown: ReadonlyMap<string, number>): AttentionItem | null {
  return nextTickerItem(items.filter(popupEligible), nowMs, lastShownMs, shown);
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
