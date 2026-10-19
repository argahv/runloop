/**
 * Where an entity card sits (immersive contract §1.4): beside what it
 * describes, never on it. Right of the entity's screen box (or of its anchor,
 * the head or roof, for small things), flipped left near the right edge with
 * 40 px of hysteresis, clamped vertically clear of the HUD bands and of the
 * minimap corner, and docked top-right when the anchor is off-screen, behind
 * the camera or under the HUD, or when neither side has room. Pure.
 */
import type { ScreenBox, ScreenPoint } from '../../../town/types';

export interface CardBox {
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
  /** Covered on the right (an open sheet) and on the left (the directory), px. */
  right: number;
  left: number;
  /** HUD bands at the top and the bottom where an anchor counts as hidden, px. */
  top: number;
  bottom: number;
  /** The bottom-left corner the minimap holds (width and height from that corner, px); a card above it stays clear. */
  corner?: { w: number; h: number };
}

export type Side = 'right' | 'left';

export interface CardPlacement {
  docked: boolean;
  side: Side;
  /** Card top-left, px. */
  x: number;
  y: number;
  /** Tail centre, px from the card top (when not docked). */
  tailY: number;
}

export const CARD_GAP = 28;
/** Room between an entity's screen box and the card (the tail is 8 px). */
export const BOX_GAP = 14;
export const CARD_RAISE = 24;
export const FLIP_HYSTERESIS = 40;
const MARGIN = 16;
const CLAMP = 92;
const TAIL_MIN = 18;
const CORNER_GAP = 8;

export function dockedPlacement(card: CardBox, vp: Viewport): CardPlacement {
  return { docked: true, side: 'right', x: vp.w - vp.right - MARGIN - card.w, y: CLAMP, tailY: 0 };
}

/** Is the anchor somewhere the card can point at? */
export function anchorUsable(a: ScreenPoint | null, vp: Viewport): a is ScreenPoint {
  if (!a || !a.visible || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return false;
  return a.x >= vp.left && a.x <= vp.w - vp.right && a.y >= vp.top && a.y <= vp.h - vp.bottom;
}

/**
 * `box` is the entity's screen box (TownApi.projectBounds) when it has one:
 * the card keeps clear of all of it, so a building or interior stays visible.
 */
export function placeCard(anchor: ScreenPoint | null, card: CardBox, vp: Viewport, prev: Side = 'right', box: ScreenBox | null = null): CardPlacement {
  if (!anchorUsable(anchor, vp)) return dockedPlacement(card, vp);
  const limitRight = vp.w - MARGIN - vp.right;
  const rightX = Math.max(anchor.x + CARD_GAP, box ? box.right + BOX_GAP : -Infinity);
  const leftX = Math.min(anchor.x - CARD_GAP, box ? box.left - BOX_GAP : Infinity) - card.w;
  const rightEdge = rightX + card.w;
  // Flip left near the right edge; come back only with 40 px to spare (no flicker while panning).
  const side: Side = prev === 'right' ? (rightEdge > limitRight ? 'left' : 'right') : rightEdge > limitRight - FLIP_HYSTERESIS ? 'left' : 'right';
  let x = side === 'right' ? rightX : leftX;
  // Neither side fits (a narrow free area, or the entity fills the view): dock instead of covering it.
  if (x < vp.left + MARGIN) {
    if (side === 'left' && rightEdge <= limitRight) x = rightX;
    else return dockedPlacement(card, vp);
  }
  const minY = CLAMP;
  let maxY = Math.max(minY, vp.h - Math.max(CLAMP, vp.bottom) - card.h);
  // Over the minimap's column, stay above it (its buttons stay reachable); too tall for that: beside it, or docked.
  if (vp.corner && x < vp.corner.w) {
    const above = vp.h - vp.corner.h - CORNER_GAP - card.h;
    if (above >= minY) maxY = Math.min(maxY, above);
    else if (x >= rightX && vp.corner.w + card.w <= limitRight) x = vp.corner.w;
    else return dockedPlacement(card, vp);
  }
  const y = Math.min(maxY, Math.max(minY, anchor.y - CARD_RAISE));
  const tailY = Math.min(card.h - TAIL_MIN, Math.max(TAIL_MIN, anchor.y - y));
  return { docked: false, side: x > anchor.x ? 'right' : 'left', x: Math.round(x), y: Math.round(y), tailY: Math.round(tailY) };
}

/** The session strip's widest size, its narrowest beside the minimap, and the room it keeps from the edges of the free area. */
const STRIP_MAX_W = 760;
const STRIP_MIN_W = 560;
const STRIP_EDGE = 16;
const STRIP_GAP = 8;

/**
 * Where the session strip goes (contract §1.1 S): centred in the area the open
 * sheets leave free, narrowed when that is under 760 px, and clear of the
 * minimap corner it shares the bottom band with. When beside the minimap it
 * would be narrower than 560 px, it rises above the minimap instead
 * (`bottom`, px from the bottom edge; null = its usual band). Pure.
 */
export function stripBox(vp: Pick<Viewport, 'w' | 'left' | 'right' | 'corner'>): { x: number; w: number; bottom: number | null } {
  const l = vp.left;
  const r = vp.w - vp.right;
  const w = Math.max(0, Math.min(STRIP_MAX_W, r - l - 2 * STRIP_EDGE));
  const x = Math.round((l + r - w) / 2);
  const cornerRight = vp.corner ? vp.corner.w : 0;
  if (x >= cornerRight) return { x, w, bottom: null };
  const beside = Math.min(w, r - STRIP_EDGE - cornerRight);
  if (beside >= STRIP_MIN_W) return { x: cornerRight, w: beside, bottom: null };
  return { x: l + STRIP_EDGE, w, bottom: (vp.corner?.h ?? 0) + STRIP_GAP };
}
