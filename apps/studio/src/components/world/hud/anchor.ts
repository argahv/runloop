/**
 * Where an entity card sits (immersive contract §1.4): to the right of its
 * anchor (head or roof), flipped left near the right edge with 40 px of
 * hysteresis, clamped vertically clear of the HUD, and docked top-right when
 * the anchor is off-screen, behind the camera or under the HUD. Pure.
 */
import type { ScreenPoint } from '../../../town/types';

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
export const CARD_RAISE = 24;
export const FLIP_HYSTERESIS = 40;
const MARGIN = 16;
const CLAMP = 92;
const TAIL_MIN = 18;

export function dockedPlacement(card: CardBox, vp: Viewport): CardPlacement {
  return { docked: true, side: 'right', x: vp.w - vp.right - MARGIN - card.w, y: CLAMP, tailY: 0 };
}

/** Is the anchor somewhere the card can point at? */
export function anchorUsable(a: ScreenPoint | null, vp: Viewport): a is ScreenPoint {
  if (!a || !a.visible || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return false;
  return a.x >= vp.left && a.x <= vp.w - vp.right && a.y >= vp.top && a.y <= vp.h - vp.bottom;
}

export function placeCard(anchor: ScreenPoint | null, card: CardBox, vp: Viewport, prev: Side = 'right'): CardPlacement {
  if (!anchorUsable(anchor, vp)) return dockedPlacement(card, vp);
  const limitRight = vp.w - MARGIN - vp.right;
  const rightEdge = anchor.x + CARD_GAP + card.w;
  // Flip left near the right edge; come back only with 40 px to spare (no flicker while panning).
  const side: Side = prev === 'right' ? (rightEdge > limitRight ? 'left' : 'right') : rightEdge > limitRight - FLIP_HYSTERESIS ? 'left' : 'right';
  let x = side === 'right' ? anchor.x + CARD_GAP : anchor.x - CARD_GAP - card.w;
  // Neither side fits (a narrow free area): dock instead of covering the anchor.
  if (x < vp.left + MARGIN) {
    if (side === 'left' && rightEdge <= limitRight) x = anchor.x + CARD_GAP;
    else return dockedPlacement(card, vp);
  }
  const minY = CLAMP;
  const maxY = Math.max(minY, vp.h - Math.max(CLAMP, vp.bottom) - card.h);
  const y = Math.min(maxY, Math.max(minY, anchor.y - CARD_RAISE));
  const tailY = Math.min(card.h - TAIL_MIN, Math.max(TAIL_MIN, anchor.y - y));
  return { docked: false, side: x > anchor.x ? 'right' : 'left', x: Math.round(x), y: Math.round(y), tailY: Math.round(tailY) };
}
