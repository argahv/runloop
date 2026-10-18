'use client';
import { useEffect, useReducer } from 'react';
import { getHealth, listRuns } from '../lib/api';
import { ROUTES, linkFromView, parseDeepLink, writeDeepLink } from './deeplink';
import { parseFilter, writeFilter } from './filters';
import { shortcutFor } from './keyboard';
import { effectiveReducedMotion, loadPrefs, resolveTheme, safeStorage, savePrefs, type Prefs } from './prefs';
import { pickRunToOpen } from './runs';
import { ONBOARDING_KEY, parseOnboarding } from './onboarding';
import { isRunPage } from './format';
import type { IngestStatus, StudioStore } from './store';

const HEALTH_POLL_MS = 3000;

/** Re-render every `ms` while `active` (for clocks that move without store updates). */
export function useTicker(active: boolean, ms = 250): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

/** Drives replay playback from animation frames. */
export function usePlaybackDriver(store: StudioStore): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const s = store.getState();
      if (s.cursor.mode === 'replay' && s.cursor.playing) s.advance(t - last);
      last = t;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);
}

/** Fields newer runtimes add to /api/health, read defensively (older runtimes omit them). */
export function healthExtras(health: unknown): { ingest: IngestStatus | null; tracedRunIds: string[] } {
  const h = (health ?? {}) as { ingest?: unknown; tracedRunIds?: unknown };
  const traced = Array.isArray(h.tracedRunIds) ? h.tracedRunIds.filter((x): x is string => typeof x === 'string') : [];
  const cc = (h.ingest as { claudeCode?: { protocol?: unknown } } | null | undefined)?.claudeCode;
  const ingest: IngestStatus | null =
    h.ingest && typeof h.ingest === 'object' ? { claudeCode: typeof cc?.protocol === 'number' ? { protocol: cc.protocol } : null } : null;
  return { ingest, tracedRunIds: traced };
}

/**
 * Polls GET /api/health and the runs list. When no run is open it opens the
 * active scripted run, else the newest open traced session, else the newest run.
 * `apiKey` restarts polling when the runtime URL changes.
 */
export function useRuntimePolling(store: StudioStore, apiKey: string): void {
  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const s = store.getState();
      try {
        const health = await getHealth(AbortSignal.timeout(2500));
        const runs = await listRuns();
        if (stopped) return;
        failures = 0;
        s.setRuntime({ status: 'online', version: health.version, activeRunId: health.activeRunId, ...healthExtras(health) });
        s.setRuns(runs);
        const open = store.getState();
        const next = pickRunToOpen(health.activeRunId, open.runtime.tracedRunIds, runs);
        if (open.runId === null && next !== null) selectRun(store, next);
      } catch {
        // Once online, one slow or failed poll (a busy machine) is not an outage: wait for a second.
        failures += 1;
        if (!stopped && (failures >= 2 || s.runtime.status !== 'online')) s.setRuntime({ status: 'offline' });
      }
      if (!stopped) timer = setTimeout(() => void poll(), HEALTH_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [store, apiKey]);
}

/** Open a run (the URL sync reflects it as ?run=<id> on run pages). */
export function selectRun(store: StudioStore, runId: string): void {
  if (store.getState().runId === runId) return;
  store.getState().openRun(runId);
}

/**
 * Viewer preferences: load once, apply theme and motion to <html>, follow the
 * system settings while on "system", and persist every change.
 */
export function usePrefs(store: StudioStore): void {
  useEffect(() => {
    const p = loadPrefs();
    const s = store.getState();
    s.setThemePref(p.theme);
    s.setMotionPref(p.motion);
    s.setQuality(p.quality);
    if (p.apiBase && p.apiBase !== s.apiBaseOverride) s.setApiBase(p.apiBase);

    const light = window.matchMedia('(prefers-color-scheme: light)');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const st = store.getState();
      const root = document.documentElement;
      root.setAttribute('data-theme', resolveTheme(st.themePref, light.matches));
      if (st.motionPref === 'system') root.removeAttribute('data-motion');
      else root.setAttribute('data-motion', st.motionPref);
      const rm = effectiveReducedMotion(st.motionPref, reduce.matches);
      if (rm !== st.reducedMotion) st.setReducedMotion(rm);
    };
    apply();
    light.addEventListener('change', apply);
    reduce.addEventListener('change', apply);
    const unsub = store.subscribe((st, prev) => {
      if (st.themePref !== prev.themePref || st.motionPref !== prev.motionPref) apply();
      if (st.themePref !== prev.themePref || st.motionPref !== prev.motionPref || st.quality !== prev.quality || st.apiBaseOverride !== prev.apiBaseOverride) {
        const next: Prefs = { theme: st.themePref, motion: st.motionPref, quality: st.quality, apiBase: st.apiBaseOverride };
        savePrefs(next);
      }
    });
    return () => {
      light.removeEventListener('change', apply);
      reduce.removeEventListener('change', apply);
      unsub();
    };
  }, [store]);
}

/** Read ?run, ?event, ?agent, ?view and the filter once, when the Studio opens. */
export function useDeepLinkOnce(store: StudioStore): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const link = parseDeepLink(params);
    const s = store.getState();
    if (link.runId) selectRun(store, link.runId);
    if (link.view === 'graph') s.setWorldView('graph');
    s.setFilter(parseFilter(params));
    if (link.runId && (link.seq !== null || link.agentId !== null || link.at !== null)) s.focusDeepLink({ seq: link.seq, agentId: link.agentId, at: link.at });
  }, [store]);
}

/**
 * Mirror the selection (run, event or agent, paused playhead, view) and the
 * filter into the URL on the run pages, so a reload or a shared link restores
 * what was on screen. Other params are kept.
 */
export function useUrlSync(store: StudioStore, pathname: string): void {
  useEffect(() => {
    const page = pathname.replace(/\/+$/, '');
    if (page !== ROUTES.world && page !== ROUTES.traces) return;
    const write = () => {
      const s = store.getState();
      const url = new URL(window.location.href);
      // A deep-link target still waiting for its events stays in the URL.
      const p = s.pendingFocus;
      writeDeepLink(url.searchParams, {
        runId: s.runId,
        view: page === ROUTES.world && s.worldView === 'graph' ? 'graph' : null,
        ...(p ? { seq: p.seq, agentId: p.agentId, at: p.at ?? null } : linkFromView(s)),
      });
      writeFilter(url.searchParams, s.filter);
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    };
    write();
    return store.subscribe((s, prev) => {
      if (
        s.runId !== prev.runId ||
        s.selectedSeq !== prev.selectedSeq ||
        s.selectedAgentId !== prev.selectedAgentId ||
        s.inspectorTab !== prev.inspectorTab ||
        s.playheadSeq !== prev.playheadSeq ||
        (s.cursor.mode === 'replay') !== (prev.cursor.mode === 'replay') ||
        (s.cursor.mode === 'replay' && prev.cursor.mode === 'replay' && s.cursor.playing !== prev.cursor.playing) ||
        s.pendingFocus !== prev.pendingFocus ||
        s.worldView !== prev.worldView ||
        s.filter !== prev.filter
      ) {
        write();
      }
    });
  }, [store, pathname]);
}

/** Space, ←/→, L, [ ], F, and Escape to clear the selection. Off on the town (`/`), which has its own keys. */
export function useKeyboardShortcuts(store: StudioStore, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const s = store.getState();
      if (s.viewArtifactId) return;
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === 'Escape' && !e.defaultPrevented && !target?.closest('input, textarea, select, [role="dialog"]')) {
        if (s.selectedSeq !== null || s.selectedAgentId !== null || s.selectedStationId !== null) s.clearSelection();
        return;
      }
      const action = shortcutFor(e, target);
      if (!action) return;
      e.preventDefault();
      if (action === 'togglePlay') s.togglePlay();
      else if (action === 'stepPrev') s.stepPrev();
      else if (action === 'stepNext') s.stepNext();
      else if (action === 'goLive') s.goLive();
      else if (action === 'prevAgent') s.cycleAgent(-1);
      else if (action === 'nextAgent') s.cycleAgent(1);
      else s.toggleFollow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, enabled]);
}

/**
 * Getting-started progress for this viewer: load it once, then mark "opened a
 * run", "inspected a failure" and "replayed" as they happen, and persist.
 */
export function useOnboardingTracker(store: StudioStore, pathname: string): void {
  useEffect(() => {
    store.getState().setOnboarding(parseOnboarding(safeStorage.getItem(ONBOARDING_KEY)));
    return store.subscribe((s, prev) => {
      if (s.onboarding !== prev.onboarding) safeStorage.setItem(ONBOARDING_KEY, JSON.stringify(s.onboarding));
    });
  }, [store]);

  useEffect(() => {
    const check = (s: ReturnType<StudioStore['getState']>) => {
      const o = s.onboarding;
      if (!o.opened && isRunPage(pathname) && s.runId && s.lastSequence > 0) s.setOnboarding({ opened: true });
      if (!o.replayed && s.cursor.mode === 'replay') s.setOnboarding({ replayed: true });
      if (!o.inspectedFailure && s.selectedSeq !== null) {
        const seq = s.selectedSeq;
        if (s.stateAt(s.lastSequence).exec.incidents.some((i) => i.seq === seq)) s.setOnboarding({ inspectedFailure: true });
      }
    };
    check(store.getState());
    return store.subscribe((s, prev) => {
      if (s.runId !== prev.runId || s.lastSequence !== prev.lastSequence || s.cursor !== prev.cursor || s.selectedSeq !== prev.selectedSeq) check(s);
    });
  }, [store, pathname]);
}
