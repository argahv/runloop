/**
 * The in-world navigation (immersive contract §4.1, §5.4) over the world and
 * Studio stores, without React, so it is unit-tested in node. `nav.tsx`
 * wraps it in hooks; components never call it directly.
 */
import { createStore } from 'zustand/vanilla';
import type { ComparePair } from '../../state/baselines';
import { parseFilter } from '../../state/filters';
import type { StudioStore } from '../../state/store';
import { agentOfRun } from '../../world/selectors';
import type { WorldStore, WorldUiState } from '../../world/store';
import { inWorldTarget } from './routes';

export interface StudioNav {
  /** A run in Traces (in the world: the trace sheet), optionally at an event or an agent. */
  openTrace(runId: string, at?: { seq?: number | null; agentId?: string | null }): void;
  /** Two runs side by side (in the world: the compare sheet at the Lattice Lab). */
  openCompare(pair: { a: string | null; b: string | null }): void;
  /** A run's world: its agent's building (replay inside), else its Live World (in the world: the trace sheet's World tab). */
  openRunWorld(runId: string): void;
  /** Any Studio page (in the world: its sheet, or the Esc menu for Settings). */
  openPage(href: string): void;
  /** True when links open inside the world (links then keep their href only for new tabs). */
  readonly inWorld?: boolean;
}

/**
 * Requests the trace sheet reads: show the World tab (an unowned run's Live
 * World). A store rather than props, so a link anywhere can ask for it.
 */
export const traceSheetView = createStore<{ worldTab: boolean }>(() => ({ worldTab: false }));

/** The pair a link asked the compare view to show (an open compare sheet or page follows it). */
export const compareRequests = createStore<{ pair: ComparePair | null }>(() => ({ pair: null }));

/** The building of the agent a run belongs to (its sessions, or the run it has live now). */
export function ownerBuilding(w: Pick<WorldUiState, 'agents' | 'snapshot'>, runId: string): string | null {
  const owner = agentOfRun(w.agents, runId);
  if (owner?.agent.buildingId) return owner.agent.buildingId;
  return w.snapshot?.agents.find((a) => a.activeRunId === runId)?.buildingId ?? null;
}

/** Select a run and, when named, the event or agent to show (the same steps every link takes). */
export function focusRun(studio: StudioStore, runId: string, at?: { seq?: number | null; agentId?: string | null }): void {
  if (studio.getState().runId !== runId) studio.getState().openRun(runId);
  const seq = at?.seq ?? null;
  const agentId = at?.agentId ?? null;
  if (seq !== null || agentId !== null) studio.getState().focusDeepLink({ seq, agentId });
}

/** The in-world navigation over the two stores (exported for the host and for tests of the wiring). */
export function worldNav(world: WorldStore, studio: StudioStore, navigate: (href: string) => void): StudioNav {
  const leaveOtherBuilding = (runId: string) => {
    const w = world.getState();
    if (w.entered && ownerBuilding(w, runId) !== w.entered) w.enter(null);
  };
  const openTrace: StudioNav['openTrace'] = (runId, at) => {
    focusRun(studio, runId, at);
    // A trace link lands on the trace views, not on the World tab.
    traceSheetView.setState({ worldTab: false });
    leaveOtherBuilding(runId);
    const w = world.getState();
    if (w.menu) w.setMenu(null);
    w.setOverlay('trace');
  };
  const openCompare: StudioNav['openCompare'] = (pair) => {
    compareRequests.setState({ pair: { a: pair.a, b: pair.b } });
    // The sheet reads the pair from the URL when it opens (and keeps it there).
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('a');
      url.searchParams.delete('b');
      if (pair.a) url.searchParams.set('a', pair.a);
      if (pair.b) url.searchParams.set('b', pair.b);
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    }
    const w = world.getState();
    if (w.menu) w.setMenu(null);
    // Lab mode: the compare sheet, and the camera on the Lattice Lab.
    if (w.overlay !== 'compare') w.setMode('lab');
  };
  const openRunWorld: StudioNav['openRunWorld'] = (runId) => {
    const w = world.getState();
    const building = ownerBuilding(w, runId);
    focusRun(studio, runId);
    if (w.menu) w.setMenu(null);
    if (building) {
      // A real agent's run happened in its building: replay it there.
      w.setOverlay('none');
      if (w.entered !== building) w.enter(building);
      return;
    }
    // An unowned run (the scripted demo, an unclaimed session): its Live World in the trace sheet.
    traceSheetView.setState({ worldTab: true });
    leaveOtherBuilding(runId);
    w.setOverlay('trace');
  };
  const openPage: StudioNav['openPage'] = (href) => {
    const t = inWorldTarget(href);
    const w = world.getState();
    if (!t) return navigate(href);
    switch (t.kind) {
      case 'trace': {
        if ([...t.filter.keys()].length > 0) studio.getState().setFilter(parseFilter(t.filter));
        if (t.link.view === 'graph') studio.getState().setWorldView('graph');
        const { runId, seq, agentId } = t.link;
        // A run's Live World with nothing selected: its building (or the World tab of an unowned run).
        if (t.tab === 'world' && runId && seq === null && agentId === null) return openRunWorld(runId);
        if (runId) openTrace(runId, { seq, agentId });
        else w.setOverlay('trace');
        if (t.tab === 'world') traceSheetView.setState({ worldTab: true });
        return;
      }
      case 'compare':
        return openCompare(t.pair);
      case 'sheet':
        if (w.menu) w.setMenu(null);
        return w.setOverlay(t.sheet);
      case 'menu':
        return w.setMenu('display');
      case 'town':
        if (w.menu) w.setMenu(null);
        return w.setOverlay('none');
    }
  };
  return { inWorld: true, openTrace, openCompare, openRunWorld, openPage };
}
