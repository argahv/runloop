'use client';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { Command } from '../state/commands';
import { useStudio, useStudioStore } from '../state/context';
import { ROUTES, linkFromView, linkTo } from '../state/deeplink';
import { isRunPage } from '../state/format';
import { selectRun } from '../state/hooks';
import { isTracedRun, runSourceLabel, shortId } from '../state/runs';
import { runStatusView } from '../state/view';
import { baselineFor, compareHref, isPinned } from '../state/baselines';
import { toast } from '../ui/Toast';
import { usePinToggle } from './Baseline';
import { useStartDemo } from './useStartDemo';

/** Everything the ⌘K palette can do, built from the current state. */
export function useStudioCommands(pathname: string): Command[] {
  const store = useStudioStore();
  const router = useRouter();
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const lastSequence = useStudio((s) => s.lastSequence);
  const themePref = useStudio((s) => s.themePref);
  const motionPref = useStudio((s) => s.motionPref);
  const quality = useStudio((s) => s.quality);
  const cameraMode = useStudio((s) => s.cameraMode);
  const worldView = useStudio((s) => s.worldView);
  const follow = useStudio((s) => s.follow);
  const demo = useStartDemo();
  const pin = usePinToggle();

  return useMemo(() => {
    const s = () => store.getState();
    const go = (href: string) => router.push(href);
    const cmds: Command[] = [];

    const nav: [string, string, string][] = [
      [ROUTES.overview, 'Overview', 'home health runs'],
      [ROUTES.world, 'Live World', '3d world agents watch'],
      [ROUTES.traces, 'Traces', 'timeline logs inspect search filter'],
      [ROUTES.experiments, 'Experiments', 'compare diff baseline pin runs a/b'],
      [ROUTES.integrations, 'Integrations', 'claude code plugin connect install'],
      [ROUTES.settings, 'Settings', 'theme motion quality runtime url privacy shortcuts'],
    ];
    for (const [href, label, keywords] of nav) {
      cmds.push({ id: `nav:${href}`, group: 'Go to', label, keywords, hint: pathname.startsWith(href) ? 'current' : undefined, run: () => go(href) });
    }

    cmds.push({
      id: 'demo',
      group: 'Actions',
      label: 'Run demo mission',
      keywords: 'start scripted example',
      hint: demo.disabledReason ?? undefined,
      disabled: demo.disabledReason !== null || demo.starting,
      run: () => void demo.start(),
    });
    cmds.push({ id: 'connect', group: 'Actions', label: 'Connect Claude Code', keywords: 'plugin install tracer', run: () => go(ROUTES.integrations) });
    const liveTraced = runs.find((r) => r.status === 'running' && isTracedRun(r));
    if (liveTraced) {
      cmds.push({
        id: 'live-session',
        group: 'Actions',
        label: 'Watch the newest live Claude Code session',
        keywords: 'traced live follow session',
        hint: liveTraced.runId === runId ? 'open' : undefined,
        run: () => {
          selectRun(store, liveTraced.runId);
          go(ROUTES.world);
        },
      });
    }

    if (runId) {
      const hasEvents = lastSequence > 0;
      cmds.push(
        { id: 'live', group: 'Playback', label: 'Go live', keywords: 'latest follow', shortcut: ['L'], disabled: !hasEvents, run: () => s().goLive() },
        { id: 'play', group: 'Playback', label: 'Play / pause', keywords: 'replay', shortcut: ['Space'], disabled: !hasEvents, run: () => s().togglePlay() },
        {
          id: 'next-failure',
          group: 'Playback',
          label: 'Jump to the next failure',
          keywords: 'error incident',
          disabled: !hasEvents,
          run: () => {
            const st = s();
            const incidents = st.stateAt(st.lastSequence).exec.incidents;
            const next = incidents.find((i) => i.seq > st.playheadSeq) ?? incidents[0];
            if (!next) {
              toast({ tone: 'info', title: 'No failures in this run' });
              return;
            }
            st.selectEvent(next.seq, { seek: true });
            if (!isRunPage(pathname)) go(ROUTES.traces);
          },
        },
        ...(() => {
          const open = runs.find((r) => r.runId === runId);
          if (!open) return [];
          const base = baselineFor(runs, runId);
          const out: Command[] = [
            {
              id: 'pin',
              group: 'Actions',
              label: isPinned(open) ? 'Unpin this run as a baseline' : 'Pin this run as a baseline',
              keywords: 'baseline compare experiments pin unpin',
              run: () => void pin.toggle(open),
            },
          ];
          if (base) {
            out.push({
              id: 'compare',
              group: 'Actions',
              label: 'Compare this run with the baseline',
              keywords: `experiments diff ${base.title}`,
              run: () => go(compareHref({ a: base.runId, b: runId })),
            });
          }
          return out;
        })(),
        {
          id: 'copy-link',
          group: 'Actions',
          label: 'Copy link to this moment',
          keywords: 'share url deep link',
          run: () => {
            const st = s();
            const route = pathname.startsWith(ROUTES.traces) ? ROUTES.traces : ROUTES.world;
            // The event or agent on screen, and the playhead when it is paused (never an unrelated pair).
            const view = linkFromView(st);
            const at = view.at ?? (view.seq === null ? st.playheadSeq : null);
            const url = new URL(linkTo(route, { runId, ...view, at }), window.location.origin);
            navigator.clipboard.writeText(url.href).then(
              () => toast({ tone: 'ok', title: 'Link copied', description: 'It opens this run at this moment.' }),
              () => toast({ tone: 'err', title: 'Could not copy the link', description: url.href }),
            );
          },
        },
      );
    }

    cmds.push(
      { id: 'view-world', group: 'View', label: 'Show the 3D world', keywords: 'live world view', hint: worldView === 'world' ? 'current' : undefined, run: () => (s().setWorldView('world'), go(ROUTES.world)) },
      { id: 'view-table', group: 'View', label: 'Show the Network view (2D)', keywords: 'graph network table list view delegation', hint: worldView === 'graph' ? 'current' : undefined, run: () => (s().setWorldView('graph'), go(ROUTES.world)) },
      { id: 'camera-iso', group: 'View', label: 'Camera: isometric 3D', keywords: 'camera iso', hint: cameraMode === 'iso' ? 'current' : undefined, run: () => s().setCameraMode('iso') },
      { id: 'camera-top', group: 'View', label: 'Camera: top-down 2D', keywords: 'camera top map', hint: cameraMode === 'top' ? 'current' : undefined, run: () => s().setCameraMode('top') },
      { id: 'follow', group: 'View', label: follow ? 'Stop following the selected agent' : 'Follow the selected agent', keywords: 'camera', shortcut: ['F'], run: () => s().toggleFollow() },
      { id: 'quality', group: 'Preferences', label: quality === 'high' ? 'Render quality: low (faster)' : 'Render quality: high', keywords: 'performance glow', run: () => s().setQuality(quality === 'high' ? 'low' : 'high') },
    );
    for (const t of ['system', 'dark', 'light'] as const) {
      cmds.push({ id: `theme:${t}`, group: 'Preferences', label: `Theme: ${t}`, keywords: 'appearance dark light mode', hint: themePref === t ? 'current' : undefined, run: () => s().setThemePref(t) });
    }
    for (const [m, label] of [['system', 'follow the system'], ['reduce', 'reduced'], ['full', 'full']] as const) {
      cmds.push({ id: `motion:${m}`, group: 'Preferences', label: `Motion: ${label}`, keywords: 'animation reduce motion', hint: motionPref === m ? 'current' : undefined, run: () => s().setMotionPref(m) });
    }

    runs.forEach((r, i) => {
      const n = runs.length - i;
      cmds.push({
        id: `run:${r.runId}`,
        group: 'Runs',
        label: `Run #${n} · ${r.title}${r.source ? ` · ${shortId(r.source.sessionId)}` : ''}`,
        keywords: `${r.runId} ${r.status} ${runSourceLabel(r)} ${r.source?.sessionId ?? ''} ${r.source?.projectLabel ?? ''}`,
        hint: r.runId === runId ? 'open' : runStatusView(r.status, r.paused, isTracedRun(r)).text,
        run: () => {
          selectRun(store, r.runId);
          if (!isRunPage(pathname)) go(ROUTES.world);
        },
      });
    });
    return cmds;
  }, [store, router, pathname, runs, runId, lastSequence, themePref, motionPref, quality, cameraMode, worldView, follow, demo, pin]);
}
