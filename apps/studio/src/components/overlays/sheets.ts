/**
 * The in-world sheets (immersive contract §1.1 O, §4.1, §5.4): the pages that
 * open over the town instead of leaving it. Pure data and geometry, so the
 * HUD can size its insets with the same numbers the host draws with.
 */
import type { EntityRef } from '@runloop-world/events';

export type SheetId = 'trace' | 'compare' | 'log' | 'sessions' | 'connect';
export const SHEET_IDS: readonly SheetId[] = ['trace', 'compare', 'log', 'sessions', 'connect'];

export interface SheetFrame {
  id: SheetId;
  title: string;
  width: 'wide' | 'narrow';
  /** The place the camera frames while the sheet is open (an eye anchor: nothing in the sim changes). */
  place: EntityRef | null;
  /** The place's name for the sheet header ("at the Lattice Lab"); null when the sheet has no place. */
  where: string | null;
}

export const SHEETS: Record<SheetId, SheetFrame> = {
  trace: { id: 'trace', title: 'Trace', width: 'wide', place: null, where: null },
  compare: { id: 'compare', title: 'Compare runs', width: 'wide', place: { kind: 'building', id: 'bld_lattice_lab' }, where: 'Lattice Lab' },
  log: { id: 'log', title: 'World Log', width: 'narrow', place: { kind: 'building', id: 'bld_library' }, where: 'Commons Library' },
  sessions: { id: 'sessions', title: 'Sessions', width: 'narrow', place: null, where: null },
  connect: { id: 'connect', title: 'Connect Claude Code', width: 'narrow', place: null, where: null },
};

export const isSheetId = (v: string | null | undefined): v is SheetId => v != null && (SHEET_IDS as readonly string[]).includes(v);

/** Phones (≤ 760 px) get full-width sheets. */
export const PHONE_MAX_W = 760;
export const NARROW_SHEET_W = 440;
const WIDE_MIN = 720;
const WIDE_MAX = 1180;
/** The world keeps at least this much of the screen beside a wide sheet. */
const WORLD_MIN = 32;

/** Width in px: narrow 440; wide clamp(720, 60vw, 1180) and never wider than the viewport minus 32; phones the whole width. */
export function sheetWidth(id: SheetId, viewportW: number): number {
  if (viewportW <= PHONE_MAX_W) return viewportW;
  if (SHEETS[id].width === 'narrow') return NARROW_SHEET_W;
  return Math.round(Math.min(WIDE_MAX, Math.max(WIDE_MIN, viewportW * 0.6), viewportW - WORLD_MIN));
}
