'use client';
/**
 * The in-world sheets' host (contract §1.1 O, §4, §5.4): Traces, compare,
 * the World Log, sessions and connections open here, over the right side of
 * the town, which stays visible and live to the left. A non-modal region:
 * focus moves into it when it opens and back to the opener when it closes;
 * Esc first lets the trace clear its selection, then closes the sheet. Its
 * links open other sheets and buildings (in-world navigation), never pages,
 * except "Full page", the escape hatch to the legacy page.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { parseComparePair } from '../../state/baselines';
import { useStudioStore } from '../../state/context';
import { linkFromView } from '../../state/deeplink';
import { buttonClass, Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import WorldLog from '../world/WorldLog';
import { ComparePanel } from '../pages/ExperimentsPage';
import { ConnectionsPanel } from '../pages/IntegrationsPage';
import { SessionsPanel } from '../pages/OverviewPage';
import { plainClick, StudioNavProvider, traceSheetView, useWorldNav } from './nav';
import { fullPageHref } from './routes';
import SheetScroll from './SheetScroll';
import { SHEETS, sheetWidth, type SheetFrame, type SheetId } from './sheets';
import TraceSheet from './TraceSheet';
import styles from './overlays.module.css';

/** Phones: the sheet starts under the top bar, leaving a strip of the world in view. */
const PHONE_TOP = 96;

function useViewportWidth(): number {
  const [w, setW] = useState(1440);
  useEffect(() => {
    const read = () => setW(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return w;
}

/** What a sheet shows (the same panels the legacy pages show, in their sheet form). */
export function SheetContent({ sheet }: { sheet: SheetId }): ReactNode {
  switch (sheet) {
    case 'trace':
      return <TraceSheet />;
    case 'compare':
      return (
        <SheetScroll>
          <ComparePanel variant="sheet" />
        </SheetScroll>
      );
    case 'log':
      return <WorldLog embedded />;
    case 'sessions':
      return (
        <SheetScroll>
          <SessionsPanel compact />
        </SheetScroll>
      );
    case 'connect':
      return (
        <SheetScroll>
          <ConnectionsPanel />
        </SheetScroll>
      );
  }
}

export function OverlayHost({ sheet, onClose, mobile, insets }: { sheet: SheetId | null; onClose(): void; mobile: boolean; insets: { top: number; bottom: number } }) {
  const nav = useWorldNav();
  const vw = useViewportWidth();
  if (!sheet) return null;
  const frame = SHEETS[sheet];
  return (
    <StudioNavProvider nav={nav}>
      <SheetFrameView key={sheet} frame={frame} width={mobile ? null : sheetWidth(sheet, vw)} top={mobile ? PHONE_TOP : insets.top} bottom={insets.bottom} onClose={onClose}>
        <SheetContent sheet={sheet} />
      </SheetFrameView>
    </StudioNavProvider>
  );
}

function SheetFrameView({ frame, width, top, bottom, onClose, children }: { frame: SheetFrame; width: number | null; top: number; bottom: number; onClose(): void; children: ReactNode }) {
  const studio = useStudioStore();
  const root = useRef<HTMLElement>(null);
  const titleId = useId();

  // Focus: into the sheet's content when it opens, back to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && !root.current?.contains(document.activeElement) ? document.activeElement : null;
    const body = root.current?.querySelector<HTMLElement>('[data-sheet-body]');
    const first = body?.querySelector<HTMLElement>('input, select, button:not([disabled]), [href], [tabindex="0"]');
    (first ?? root.current)?.focus({ preventScroll: true });
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (opener?.isConnected && lost) opener.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Keys from portalled dialogs (Stop run, the phone inspector) belong to them.
    if (e.key !== 'Escape' || e.defaultPrevented || !root.current?.contains(e.target as Node)) return;
    e.preventDefault();
    const s = studio.getState();
    if (frame.id === 'trace' && (s.selectedSeq !== null || s.selectedAgentId !== null || s.selectedStationId !== null)) s.clearSelection();
    else onClose();
  };

  return (
    <section
      ref={root}
      className={styles.sheet}
      data-sheet={frame.id}
      data-mobile={width === null || undefined}
      style={{ top, bottom, width: width ?? undefined }}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-keys="own"
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          {frame.title}
          {frame.where && (
            <span className={styles.where}>
              <Icon name="map" size={12} />
              at the {frame.where}
            </span>
          )}
        </h2>
        <span className={styles.headActions}>
          <FullPageLink frame={frame} />
          <Button size="sm" variant="ghost" iconOnly icon="x" aria-label={`Close ${frame.title}`} title="Close (Esc)" onClick={onClose} />
        </span>
      </header>
      <div className={styles.body} data-sheet-body>
        {children}
      </div>
    </section>
  );
}

/** "Full page": the legacy page showing the same run, event or pair (computed when used, since the sheet's selection moves). */
function FullPageLink({ frame }: { frame: SheetFrame }) {
  const router = useRouter();
  const studio = useStudioStore();
  const compute = useCallback(() => {
    const s = studio.getState();
    const link = linkFromView(s);
    return fullPageHref(frame.id, {
      runId: s.runId,
      seq: link.seq,
      agentId: link.agentId,
      at: link.at,
      worldTab: traceSheetView.getState().worldTab,
      pair: parseComparePair(new URLSearchParams(window.location.search)),
    });
  }, [frame.id, studio]);
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => setHref(compute()), [compute]);
  if (frame.id === 'log') return null; // the World Log lives on `/`: no page to open
  const refresh = () => setHref(compute());
  return (
    <a
      href={href ?? '/'}
      className={buttonClass('ghost', 'sm')}
      title="Open the full page (leaves the town)"
      onPointerEnter={refresh}
      onFocus={refresh}
      onClick={(e) => {
        const next = compute();
        if (!next || !plainClick(e)) return refresh();
        e.preventDefault();
        router.push(next);
      }}
    >
      <Icon name="external" size={14} />
      Full page
    </a>
  );
}
