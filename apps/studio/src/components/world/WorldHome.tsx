'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { attachWorldAudio, getAudio, SoundSettings, SoundToggle } from '../../audio';
import { useStudioStore } from '../../state/context';
import { linkFromView, SELECTION_PARAMS, writeDeepLink } from '../../state/deeplink';
import type { TownApi, TownListener } from '../../town/types';
import { useWorldStore } from '../../world/context';
import { legacyRedirect, modeForKey, parseOverlay, parseWorldLink, writeOverlay, writeWorldLink } from '../../world/link';
import { focusOf } from '../../world/store';
import { sendWorldCommand } from '../../world/send';
import { ConnectionsPanel } from '../pages/IntegrationsPage';
import { useShellActions } from '../shellActions';
import { useLastSeenTracker } from './CatchUpCard';
import { TownApiProvider } from './hud/context';
import { runEscape } from './hud/escape';
import { uiSound } from './hud/sound';
import WorldHud from './hud/WorldHud';
import styles from './hud/hud.module.css';
import TownStage from './TownStage';

const onFly = (ms: number, pan: number) => getAudio().whoosh(ms, pan);
const onListener = (l: TownListener) => getAudio().setListener(l);

/** World keys must not fire while typing or inside a modal (⌘K, the Esc menu, Assign task). */
function blocked(e: KeyboardEvent): boolean {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  const el = e.target instanceof Element ? e.target : null;
  // Esc still backs out of an input in a card or sheet (the directory filter, the lot form).
  if (e.key === 'Escape') return !!el?.closest('[role="dialog"]');
  return !!el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="tree"], [role="tablist"], [role="radiogroup"], [role="listbox"]');
}

/**
 * `/`: the town, edge to edge, and nothing else (immersive contract §0). The
 * game HUD floats over it; every page and action opens inside the world. Old
 * run links to `/` still go to their page (unless they name an `overlay`).
 */
export default function WorldHome() {
  const { openPalette } = useShellActions();
  const router = useRouter();
  const store = useWorldStore();
  const studio = useStudioStore();
  const [redirecting, setRedirecting] = useState(false);
  const [api, setApi] = useState<TownApi | null>(null);
  const apiRef = useCallback((a: TownApi | null) => setApi(a), []);
  useLastSeenTracker();

  // Sound (contract §4b): cues for live, real agent events only; the first gesture unlocks it.
  useEffect(() => attachWorldAudio(store), [store]);

  // Legacy deep links, then the world link (mode, focus, camera, overlay) once.
  const linked = useRef(false);
  const leaving = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legacy = legacyRedirect(window.location.pathname, params);
    if (legacy) {
      leaving.current = true;
      setRedirecting(true);
      router.replace(legacy);
      return;
    }
    if (linked.current) return;
    linked.current = true;
    const link = parseWorldLink(params);
    const s = store.getState();
    // A link names exactly what to show: the mode's sheet opens, but the camera stays on the link.
    s.setMode(link.mode, { camera: false });
    if (link.cam) s.setCam(link.cam);
    if (link.focus) {
      s.focusEntity(link.focus, { camera: false, replace: true });
      // A link lands on its subject at once (no flight on load).
      if (!link.cam) s.requestCamera('focus', link.focus, 'cut');
    }
    const overlay = parseOverlay(params);
    if (overlay && overlay !== 'add') s.setOverlay(overlay);
  }, [router, store]);

  // Add to World from a link (`overlay=add[&lot=]`) waits until the stage knows whether lots can be picked in 3D.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (parseOverlay(params) !== 'add') return;
    const lot = params.get('lot');
    return store.subscribe((s, p) => {
      if (!s.stage || p.stage) return;
      s.openAddToWorld();
      if (lot && store.getState().lotPick) store.getState().pickLot(lot);
    });
  }, [store]);

  // Keep the URL in step with the mode, the focused entity, the camera and the open sheet.
  // A sheet's own parameters (the trace's run and event, compare's a and b) leave with it,
  // so a reload never turns into an old run redirect.
  useEffect(() => {
    const write = () => {
      if (leaving.current || (window.location.pathname.replace(/\/+$/, '') || '/') !== '/') return;
      const s = store.getState();
      const url = new URL(window.location.href);
      writeWorldLink(url.searchParams, { mode: s.mode, focus: focusOf(s), cam: s.cam });
      // The mode's own sheet is implied by `mode=` (Intelligence, Lab); others are named.
      const implied = (s.mode === 'intelligence' && s.overlay === 'log') || (s.mode === 'lab' && s.overlay === 'compare');
      writeOverlay(url.searchParams, implied ? null : s.overlay);
      if (s.overlay === 'trace') {
        const st = studio.getState();
        if (st.runId) writeDeepLink(url.searchParams, { runId: st.runId, view: null, ...(st.pendingFocus ? { seq: st.pendingFocus.seq, agentId: st.pendingFocus.agentId, at: st.pendingFocus.at ?? null } : linkFromView(st)) });
      } else for (const k of SELECTION_PARAMS) url.searchParams.delete(k);
      if (s.overlay !== 'compare') {
        url.searchParams.delete('a');
        url.searchParams.delete('b');
      }
      if (s.lotPick?.selected) url.searchParams.set('lot', s.lotPick.selected);
      else url.searchParams.delete('lot');
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    };
    write();
    const offWorld = store.subscribe((s, p) => {
      if (s.mode !== p.mode || s.panelStack !== p.panelStack || s.cam !== p.cam || s.overlay !== p.overlay || s.lotPick !== p.lotPick) write();
    });
    const offStudio = studio.subscribe((s, p) => {
      if (store.getState().overlay === 'trace' && (s.runId !== p.runId || s.selectedSeq !== p.selectedSeq || s.selectedAgentId !== p.selectedAgentId || s.inspectorTab !== p.inspectorTab || s.pendingFocus !== p.pendingFocus || s.playheadSeq !== p.playheadSeq)) write();
    });
    return () => {
      offWorld();
      offStudio();
    };
  }, [store, studio]);

  // The HUD's keys (contract §2.2); the camera's keys (WASD, Q E Z X, + −, 0, R) belong to the renderer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || blocked(e)) return;
      const s = store.getState();
      // With the trace sheet open, its run shortcuts (Space, L, F, arrows, [ ]) belong to the trace.
      if (s.overlay === 'trace' && [' ', 'l', 'L', 'f', 'F', '[', ']', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const mode = modeForKey(e.key);
      if (mode) {
        e.preventDefault();
        if (s.overlay === 'add') s.cancelLotPick();
        uiSound('select');
        s.setMode(mode);
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
        case 'n':
        case 'N':
          e.preventDefault();
          if (s.overlay === 'add') s.cancelLotPick();
          else s.openAddToWorld();
          return;
        case 'h':
        case 'H':
          e.preventDefault();
          s.setHudHidden(!s.hud.hidden);
          return;
        case '?':
          e.preventDefault();
          uiSound('menu');
          s.setMenu(s.menu === 'controls' ? null : 'controls');
          return;
        case '/':
          e.preventDefault();
          openPalette();
          return;
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
          if (top?.kind === 'resident' || top?.kind === 'agent') {
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
        case 'Escape': {
          e.preventDefault();
          // The trace sheet's own Esc first: clear its selection, then close it.
          const st = studio.getState();
          if (s.overlay === 'trace' && !s.menu && (st.selectedSeq !== null || st.selectedAgentId !== null || st.selectedStationId !== null)) {
            st.clearSelection();
            return;
          }
          const a = runEscape(s);
          uiSound(a === 'openMenu' ? 'menu' : 'close');
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, studio, openPalette]);

  if (redirecting) return null;

  return (
    <TownApiProvider api={api}>
      <div className={styles.home}>
        <h1 className="sr-only">Runloop · the town</h1>
        {/* The HUD first in the tab order; the town draws underneath it. */}
        <WorldHud onOpenPalette={openPalette} sound={<SoundToggle compact />} soundSettings={<SoundSettings />} menuExtras={{ connections: <MenuConnections /> }} />
        <TownStage apiRef={apiRef} onFly={onFly} onListener={onListener} />
      </div>
    </TownApiProvider>
  );
}

/** The Esc menu's Connections tab: the Integrations page's content (connect Claude Code, the scripted demo). */
function MenuConnections() {
  return (
    <div className={styles.menuConnections}>
      <ConnectionsPanel />
    </div>
  );
}
