/**
 * Screen rectangles the HUD puts over the town that change every frame (the
 * anchored card), for the renderer's labels to keep clear of. Written by the
 * card's frame loop, read by `Town3D`'s `obstacles`; no React state.
 */
import type { ScreenRect } from '../../../town/types';

export const floatingRects: { card: ScreenRect | null } = { card: null };
