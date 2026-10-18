/**
 * HUD sizes per viewport (immersive contract §1.1–1.2): one place for the
 * numbers the CSS and the camera insets share. Pure; unit-tested.
 */
import type { Insets } from '../../../town/types';

export type HudSize = 'phone' | 's' | 'm' | 'l';

export interface HudLayout {
  size: HudSize;
  /** Minimap canvas (null on phones: Map is in the menu, M). */
  minimap: { w: number; h: number } | null;
  hotbar: { btnW: number; btnH: number; height: number; bottom: number };
  card: { compact: number; expanded: number };
  notifications: number;
  find: number;
  /** The speed caption row under the clock (hidden at 1280: tooltip instead). */
  captionRow: boolean;
  /** Top HUD row height (A–D) including its margin. */
  top: number;
  /** Labels kept per frame (12 on phones). */
  labelBudget: number;
}

export const PHONE_MAX = 760;

export function hudSize(w: number): HudSize {
  if (w <= PHONE_MAX) return 'phone';
  if (w < 1366) return 's';
  if (w < 1700) return 'm';
  return 'l';
}

export function hudLayout(w: number): HudLayout {
  const size = hudSize(w);
  switch (size) {
    case 'phone':
      return {
        size,
        minimap: null,
        hotbar: { btnW: 58, btnH: 52, height: 60, bottom: 0 },
        card: { compact: Math.min(w, 520), expanded: Math.min(w, 520) },
        notifications: w - 24,
        find: 44,
        captionRow: false,
        top: 12 + 48,
        labelBudget: 12,
      };
    case 's':
      return { size, minimap: { w: 200, h: 150 }, hotbar: { btnW: 64, btnH: 48, height: 60, bottom: 16 }, card: { compact: 320, expanded: 400 }, notifications: 320, find: 156, captionRow: false, top: 16 + 44, labelBudget: 24 };
    case 'm':
      return { size, minimap: { w: 232, h: 174 }, hotbar: { btnW: 72, btnH: 48, height: 60, bottom: 16 }, card: { compact: 320, expanded: 400 }, notifications: 340, find: 156, captionRow: true, top: 16 + 64, labelBudget: 24 };
    case 'l':
      return { size, minimap: { w: 264, h: 198 }, hotbar: { btnW: 80, btnH: 52, height: 64, bottom: 16 }, card: { compact: 340, expanded: 440 }, notifications: 360, find: 180, captionRow: true, top: 16 + 64, labelBudget: 24 };
  }
}

/**
 * What the HUD covers, for the camera's framing (`viewInsets`): the top row,
 * the hotbar, an open sheet on the right (its width + 16) and the directory on
 * the left. The minimap corner is small enough to frame over.
 */
export function hudInsets(layout: HudLayout, open: { right?: number; left?: number; hidden?: boolean }): Insets {
  if (open.hidden) return { top: 0, right: 0, bottom: 0, left: 0 };
  const bottom = layout.hotbar.height + layout.hotbar.bottom + 8;
  return {
    top: layout.top,
    right: open.right ? open.right + 16 : 0,
    bottom,
    left: open.left ? open.left + 16 : 0,
  };
}
