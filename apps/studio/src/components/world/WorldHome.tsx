'use client';
import type { EntityRef } from '@runloop-world/events';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { MOBILE_QUERY, useMediaQuery } from '../../ui/useMediaQuery';
import type { AttentionItem } from '../../world/attention';
import { useWorld, useWorldStore } from '../../world/context';
import { legacyRedirect, modeForKey, parseWorldLink, writeWorldLink } from '../../world/link';
import { focusOf } from '../../world/store';
import { sendWorldCommand } from '../../world/send';
import { useShellActions } from '../shellActions';
import AttentionTicker from './AttentionTicker';
import CatchUpCard, { useLastSeenTracker } from './CatchUpCard';
import ContextPanel, { useContextPanelOpen } from './ContextPanel';
import EntityDirectory from './EntityDirectory';
import TownStage, { useStageKind } from './TownStage';
import WorldMap from './WorldMap';
import WorldBar from './WorldBar';
import styles from './WorldHome.module.css';

/** Keys the world handles itself must not fire while typing or inside a dialog. */
function typing(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  // A modal (⌘K, Add to World) owns the keyboard even before its input has focus.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  return !!el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="tree"]');
}

/**
 * `/`: the town, full-bleed (plan §5). Signature chrome floats over it (the
 * clock and speed, live agents, Add to World, ⌘K), the context panel docks on
 * the right and the attention ticker runs along the bottom. Old run links to
 * `/` still go to their page.
 */
export default function WorldHome() {
  const { openPalette, openMenu } = useShellActions();
  const router = useRouter();
  const store = useWorldStore();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const panelOpen = useContextPanelOpen();
  const overlay = useWorld((s) => s.overlay);
  const stage = useStageKind();
  const [redirecting, setRedirecting] = useState(false);
  useLastSeenTracker();

  // Legacy deep links, then the world link (mode, focus, camera) once.
  const linked = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legacy = legacyRedirect(window.location.pathname, params);
    if (legacy) {
      setRedirecting(true);
      router.replace(legacy);
      return;
    }
    if (linked.current) return;
    linked.current = true;
    const link = parseWorldLink(params);
    const s = store.getState();
    s.setMode(link.mode);
    if (link.cam) s.setCam(link.cam);
    if (link.focus) s.focusEntity(link.focus, { camera: !link.cam, replace: true });
  }, [router, store]);

  // Keep the URL in step with the mode, the focused entity and the camera.
  useEffect(() => {
    const write = () => {
      if ((window.location.pathname.replace(/\/+$/, '') || '/') !== '/') return;
      const s = store.getState();
      const url = new URL(window.location.href);
      writeWorldLink(url.searchParams, { mode: s.mode, focus: focusOf(s), cam: s.cam });
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    };
    write();
    return store.subscribe((s, p) => {
      if (s.mode !== p.mode || s.panelStack !== p.panelStack || s.cam !== p.cam) write();
    });
  }, [store]);

  // World keys: 1–4 modes, Space pause/resume, M map, L list, F follow, Enter enter, Esc back out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const s = store.getState();
      const mode = modeForKey(e.key);
      if (mode) {
        e.preventDefault();
        if (mode === 'lab') router.push('/experiments');
        else s.setMode(mode);
        return;
      }
      const onControl = e.target instanceof Element && e.target.closest('button, a, summary, [role="radio"], [role="tab"]');
      const top = focusOf(s);
      switch (e.key) {
        case ' ': {
          if (onControl || !s.snapshot) return;
          e.preventDefault();
          const speed = s.snapshot.speed === 0 ? s.snapshot.prevSpeed : 0;
          void sendWorldCommand(store, { type: 'clock.set', speed }, speed === 0 ? 'Pausing…' : `Resuming at ${speed}×…`);
          return;
        }
        case 'm':
        case 'M':
          e.preventDefault();
          s.setOverlay(s.overlay === 'map' ? 'none' : 'map');
          return;
        case 'l':
        case 'L':
          e.preventDefault();
          s.setOverlay(s.overlay === 'list' ? 'none' : 'list');
          return;
        case 'f':
        case 'F':
          if (top?.kind === 'resident') {
            e.preventDefault();
            s.setFollow(s.follow?.id === top.id ? null : top);
          }
          return;
        case 'Enter':
          if (onControl) return;
          if (top?.kind === 'building' || top?.kind === 'agent') {
            e.preventDefault();
            const id = top.kind === 'building' ? top.id : (s.snapshot?.agents.find((a) => a.agentId === top.id)?.buildingId ?? null);
            if (id) s.enter(s.entered === id ? null : id);
          }
          return;
        case 'Escape':
          if (s.entered) {
            e.preventDefault();
            s.enter(null);
          } else if (s.overlay !== 'none') {
            e.preventDefault();
            s.setOverlay('none');
          } else if (s.follow) {
            e.preventDefault();
            s.setFollow(null);
          } else if (s.panelStack.length) {
            e.preventDefault();
            s.back();
          }
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, router]);

  const openItem = (item: AttentionItem) => {
    const s = store.getState();
    const ref: EntityRef | undefined = item.refs[0];
    if (item.kind === 'arrival') s.setMode('agents');
    else if (ref) s.focusEntity(ref);
    else if (item.events) s.showInLog({ seq: item.events.last });
  };
  const addToWorld = (fromSessionId?: string) => store.getState().openAddToWorld(fromSessionId ?? null);

  if (redirecting) return null;

  return (
    <div className={styles.home} data-panel={(!mobile && panelOpen) || undefined} data-mobile={mobile || undefined}>
      <h1 className="sr-only">Runloop · the town</h1>
      <div className={styles.stageWrap}>
        <TownStage />
        <div className={styles.topOverlay}>
          <WorldBar onAddToWorld={() => addToWorld()} onOpenPalette={openPalette} onOpenMenu={mobile ? openMenu : undefined} compact={mobile} />
          <CatchUpCard onOpen={openItem} />
        </div>
        {overlay === 'list' && (
          <div className={`${styles.overlayCard} ${styles.listCard}`} role="region" aria-label="Directory">
            <EntityDirectory />
          </div>
        )}
        {overlay === 'map' && stage === '3d' && (
          <div className={`${styles.overlayCard} ${styles.mapCard}`} role="region" aria-label="Town map">
            <WorldMap variant="overlay" />
          </div>
        )}
        <div className={styles.bottomOverlay}>
          <AttentionTicker onOpen={openItem} />
        </div>
      </div>
      {!mobile && panelOpen && (
        <aside className={styles.contextDock} aria-label="Context">
          <ContextPanel onAddToWorld={addToWorld} />
        </aside>
      )}
      {mobile && (
        <Dialog
          open={panelOpen}
          onClose={() => {
            const s = store.getState();
            if (s.panelStack.length) s.closePanels();
            else s.setMode('explore');
          }}
          labelledBy="context-sheet-title" placement="bottom" className={styles.sheet}>
          <h2 id="context-sheet-title" className="sr-only">
            Details
          </h2>
          <ContextPanel onAddToWorld={addToWorld} />
        </Dialog>
      )}
    </div>
  );
}
