export type ShortcutAction = 'togglePlay' | 'stepPrev' | 'stepNext' | 'goLive' | 'prevAgent' | 'nextAgent' | 'toggleFollow';

const KEYS: Record<string, ShortcutAction> = {
  ' ': 'togglePlay',
  ArrowLeft: 'stepPrev',
  ArrowRight: 'stepNext',
  l: 'goLive',
  L: 'goLive',
  '[': 'prevAgent',
  ']': 'nextAgent',
  f: 'toggleFollow',
  F: 'toggleFollow',
};

/** Keys that controls handle themselves when focused (Space on a button, arrows in a slider/tab list). */
const NATIVE: Record<string, string> = {
  ' ': 'button, a, summary, [role="tab"], input, select, textarea',
  ArrowLeft: 'input, select, textarea, [role="tablist"]',
  ArrowRight: 'input, select, textarea, [role="tablist"]',
};

/** Global shortcut for a key press, or null when the focused control should get it. */
export function shortcutFor(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented'>,
  target: Element | null,
): ShortcutAction | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const action = KEYS[e.key];
  if (!action || !target) return action ?? null;
  if (target.closest('input[type="text"], input[type="search"], textarea, select, [contenteditable="true"], [role="dialog"]')) return null;
  const native = NATIVE[e.key];
  if (native && target.closest(native)) return null;
  return action;
}
