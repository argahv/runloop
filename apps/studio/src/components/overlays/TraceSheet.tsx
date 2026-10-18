'use client';
/**
 * The trace sheet (contract §4.1): Traces inside the world. A compact run
 * header (pin, compare, switch run), the replay bar, the tabs World ·
 * Timeline · Logs · Metrics · State · Metadata and the inspector, beside the
 * live town. The World tab is the run's Live World (3D or the Network view);
 * while its 3D canvas is on screen the town stops drawing (one WebGL scene
 * at a time) and resumes when the tab or the sheet closes.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useStudio, useStudioStore } from '../../state/context';
import { FILTER_PARAMS, writeFilter } from '../../state/filters';
import { MOBILE_QUERY, useMediaQuery } from '../../ui/useMediaQuery';
import { useWorldStore } from '../../world/context';
import { useTownApi } from '../world/hud/context';
import { agentOfRun } from '../../world/selectors';
import { TraceView } from '../pages/TraceView';
import ReplayBar from '../ReplayBar';
import RunHeader from '../RunHeader';
import { OfflineBanner, RunGate } from '../RunStates';
import WorldStage from '../WorldStage';
import { traceSheetView } from './nav';
import { parseSheetTab, SHEET_TAB_PARAM } from './routes';
import styles from './overlays.module.css';

const INSPECTOR = { defaultSize: '340px', minSize: '280px', maxSize: '520px' };
/** Frames the town draws before it pauses behind the World tab. */
const DRAWN_FRAMES = 30;

function replaceUrl(edit: (p: URLSearchParams) => void): void {
  const url = new URL(window.location.href);
  edit(url.searchParams);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

export default function TraceSheet() {
  const studio = useStudioStore();
  const world = useWorldStore();
  const worldTab = useStore(traceSheetView, (s) => s.worldTab);
  const runId = useStudio((s) => s.runId);
  const view = useStudio((s) => s.worldView);
  // Phones: the World tab is the Network view (never a second, desktop-sized 3D scene over the town).
  const mobile = useMediaQuery(MOBILE_QUERY);

  // A link may name the World tab (`tab=world`, or a /world link opened in the world). Read before any effect rewrites the URL.
  const [linkedWorld] = useState(() => typeof window !== 'undefined' && parseSheetTab(new URLSearchParams(window.location.search)) === 'world');
  useEffect(() => {
    if (linkedWorld) traceSheetView.setState({ worldTab: true });
  }, [linkedWorld]);

  // While open, `tab=world` and the trace filter live in the URL (the selection is written by the town); they leave with the sheet.
  useEffect(() => {
    const write = () =>
      replaceUrl((p) => {
        if (traceSheetView.getState().worldTab) p.set(SHEET_TAB_PARAM, 'world');
        else p.delete(SHEET_TAB_PARAM);
        writeFilter(p, studio.getState().filter);
      });
    write();
    const offTab = traceSheetView.subscribe(write);
    const offFilter = studio.subscribe((s, prev) => s.filter !== prev.filter && write());
    return () => {
      offTab();
      offFilter();
      // Closing (not a remount): the sheet's parameters leave with it, and it next opens on the trace views.
      setTimeout(() => {
        if (world.getState().overlay === 'trace') return;
        replaceUrl((p) => {
          p.delete(SHEET_TAB_PARAM);
          for (const k of FILTER_PARAMS) p.delete(k);
        });
        traceSheetView.setState({ worldTab: false });
      }, 0);
    };
  }, [studio, world]);

  // One 3D scene at a time: the town pauses while the World tab shows the 3D world. It pauses once it has
  // drawn a few frames (a link may land here before the town ever drew), so it stays in view, frozen.
  const pauseTown = worldTab && view === 'world' && !mobile;
  const town = useTownApi();
  useEffect(() => {
    if (!pauseTown || !town) return;
    let paused = false;
    let frames = 0;
    const off = town.onFrame(() => {
      if (paused || ++frames < DRAWN_FRAMES) return;
      paused = true;
      world.getState().setTownPaused(true);
    });
    return () => {
      off();
      if (paused) world.getState().setTownPaused(false);
    };
  }, [pauseTown, town, world]);

  // Frame the building of the agent whose run this is (outside; inside, the building already is the frame).
  useEffect(() => {
    if (!runId) return;
    const w = world.getState();
    if (w.entered) return;
    const agentId = agentOfRun(w.agents, runId)?.agent.agentId ?? w.snapshot?.agents.find((a) => a.activeRunId === runId)?.agentId;
    if (agentId) w.requestCamera('focus', { kind: 'agent', id: agentId });
  }, [runId, world]);

  return (
    <div className={styles.trace}>
      <RunGate>
        <div className={styles.traceTop}>
          <RunHeader page="traces" variant="sheet" />
          <OfflineBanner />
          <ReplayBar />
        </div>
        <div className={styles.traceMain}>
          <TraceView
            idPrefix="sheet-trace"
            inspector={INSPECTOR}
            world={{ active: worldTab, set: (active) => traceSheetView.setState({ worldTab: active }), content: <WorldStage allow3d={!mobile} /> }}
          />
        </div>
      </RunGate>
    </div>
  );
}
