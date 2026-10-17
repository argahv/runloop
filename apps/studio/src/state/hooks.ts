'use client';
import { useEffect, useReducer } from 'react';
import { getHealth, listRuns } from '../lib/api';
import { shortcutFor } from './keyboard';
import type { StudioStore } from './store';

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

/** Polls GET /api/health and the runs list; opens a run when none is open yet. */
export function useRuntimePolling(store: StudioStore): void {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const s = store.getState();
      try {
        const health = await getHealth(AbortSignal.timeout(2500));
        const runs = await listRuns();
        if (stopped) return;
        s.setRuntime({ status: 'online', version: health.version, activeRunId: health.activeRunId });
        s.setRuns(runs);
        const open = store.getState();
        if (open.runId === null && runs.length > 0) selectRun(store, health.activeRunId ?? runs[0]!.runId);
      } catch {
        if (!stopped) s.setRuntime({ status: 'offline' });
      }
      if (!stopped) timer = setTimeout(() => void poll(), HEALTH_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [store]);
}

/** Open a run and reflect it in the URL (?run=<id>). */
export function selectRun(store: StudioStore, runId: string): void {
  if (store.getState().runId === runId) return;
  store.getState().openRun(runId);
  const url = new URL(window.location.href);
  url.searchParams.set('run', runId);
  window.history.replaceState(null, '', url);
}

export function runIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('run');
}

/** Tracks prefers-reduced-motion. */
export function useReducedMotion(store: StudioStore): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => store.getState().setReducedMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [store]);
}

/** Space, ←/→, L, [ ], F. */
export function useKeyboardShortcuts(store: StudioStore): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store.getState();
      if (s.viewArtifactId) return;
      const action = shortcutFor(e, e.target instanceof Element ? e.target : null);
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
  }, [store]);
}
