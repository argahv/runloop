'use client';
/**
 * Sheets over the town (contract §1.1 O, §4.1): the directory (L, the 2D
 * route to every entity) on the left, the 2D map (M) in the middle, and the
 * in-world pages on the right (World Log, a trace, compare, sessions,
 * connections) in the overlays module's `OverlayHost`. The world stays
 * visible and live beside them.
 */
import { useEffect, useRef } from 'react';
import { useWorld, useWorldStore } from '../../../world/context';
import type { Overlay } from '../../../world/store';
import { Button } from '../../../ui/Button';
import { isSheetId, OverlayHost, sheetWidth, type SheetId } from '../../overlays';
import EntityDirectory from '../EntityDirectory';
import WorldMap from '../WorldMap';
import type { HudLayout } from './layout';
import styles from './hud.module.css';

export const isSheet = (o: Overlay): o is SheetId => isSheetId(o);

export const DIRECTORY_W = 380;
/** Where sheets start (under the top row of controls). */
export const SHEET_TOP = 84;

/** What the open sheet covers on each side (px), for cards and camera insets. */
export function useSheetWidths(vw: number): { right: number; left: number } {
  const overlay = useWorld((s) => s.overlay);
  if (vw <= 760) return { right: 0, left: 0 };
  return { right: isSheet(overlay) ? sheetWidth(overlay, vw) : 0, left: overlay === 'list' ? DIRECTORY_W : 0 };
}

export default function Sheets({ phone, layout }: { phone: boolean; layout: HudLayout & { vw: number; vh: number } }) {
  const store = useWorldStore();
  const overlay = useWorld((s) => s.overlay);
  const stage = useWorld((s) => s.stage);
  const close = () => store.getState().setOverlay('none');
  const bottom = layout.hotbar.height + layout.hotbar.bottom + 16;
  return (
    <>
      {overlay === 'list' && (
        <Sheet side="left" width={phone ? layout.vw : DIRECTORY_W} label="Directory" onClose={close} bottom={bottom} phone={phone}>
          <EntityDirectory embedded />
        </Sheet>
      )}
      {overlay === 'map' && stage === '3d' && (
        <Sheet side="center" width={Math.min(layout.vw - 32, 960)} label="Town map" onClose={close} bottom={bottom} phone={phone}>
          <WorldMap variant="overlay" />
        </Sheet>
      )}
      {/* The in-world pages (Traces, compare, the World Log, sessions, connections), beside the live town. */}
      <div className={styles.overlayWrap}>
        <OverlayHost sheet={isSheet(overlay) ? overlay : null} onClose={close} mobile={phone} insets={{ top: SHEET_TOP, bottom }} />
      </div>
    </>
  );
}

/** A sheet frame: a labelled, non-modal region with a close button; Esc closes it through the town's cascade. */
export function Sheet({
  side,
  width,
  label,
  onClose,
  bottom,
  phone,
  children,
}: {
  side: 'left' | 'right' | 'center';
  width: number;
  label: string;
  onClose: () => void;
  bottom: number;
  phone: boolean;
  children: React.ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keyboard users land in the sheet's content (its first control), not on Close.
    body.current?.querySelector<HTMLElement>('input, select, button, [tabindex="0"]')?.focus({ preventScroll: true });
  }, []);
  return (
    <section className={styles.sheet} data-side={side} data-phone={phone || undefined} style={{ width, bottom }} role="region" aria-label={label} data-keys="own">
      <header className={styles.sheetHead}>
        <h2 className={styles.sheetTitle}>{label}</h2>
        <Button size="sm" variant="ghost" iconOnly icon="x" aria-label={`Close ${label}`} title="Close (Esc)" onClick={onClose} />
      </header>
      <div ref={body} className={styles.sheetBody}>
        {children}
      </div>
    </section>
  );
}
