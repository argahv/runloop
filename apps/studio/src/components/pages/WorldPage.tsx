'use client';
import { useStudio, useStudioStore } from '../../state/context';
import { Dialog } from '../../ui/Dialog';
import { SplitGroup, SplitHandle, SplitPanel } from '../../ui/SplitPanels';
import { MOBILE_QUERY, useMediaQuery } from '../../ui/useMediaQuery';
import AgentFlow from '../AgentFlow';
import AgentsTable from '../AgentsTable';
import FilterBar from '../FilterBar';
import Inspector from '../Inspector';
import ReplayBar from '../ReplayBar';
import RunHeader from '../RunHeader';
import { OfflineBanner, RunGate } from '../RunStates';
import TimelinePanel from '../TimelinePanel';
import { useTraceModel, type TraceModel } from '../useTraceModel';
import WorldStage from '../WorldStage';
import styles from './Pages.module.css';

/** Live World: watch execution (3D world or the 2D Network view), scrub it, and inspect the selection. */
export default function WorldPage() {
  const mobile = useMediaQuery(MOBILE_QUERY);
  return (
    <div className={styles.runPage}>
      <RunGate>
        <RunHeader page="world" />
        <OfflineBanner />
        {mobile ? <MobileWorld /> : <DesktopWorld />}
      </RunGate>
    </div>
  );
}

function TimelineCard({ model }: { model: TraceModel }) {
  return (
    <section className={styles.timelineCard} aria-labelledby="world-timeline">
      <div className={styles.timelineHead}>
        <h2 id="world-timeline" className={styles.cardLabel}>
          Timeline
        </h2>
        <AgentFlow />
      </div>
      <div className={styles.filters}>
        <FilterBar compact facets={model.rowFacets} agents={model.agents} shown={model.visibleRows.length} total={model.rows.length} noun="events" />
      </div>
      <TimelinePanel model={model} />
    </section>
  );
}

function DesktopWorld() {
  const model = useTraceModel();
  return (
    <SplitGroup id="world-main" className={styles.split}>
      <SplitPanel id="world-left" minSize="440px">
        <SplitGroup id="world-stage" orientation="vertical" className={styles.split}>
          <SplitPanel id="world-stage-top" minSize="220px" defaultSize="60%">
            <div className={styles.stageColumn}>
              <WorldStage />
              <ReplayBar />
            </div>
          </SplitPanel>
          <SplitHandle orientation="vertical" label="Resize the timeline" />
          <SplitPanel id="world-timeline" minSize="160px">
            <TimelineCard model={model} />
          </SplitPanel>
        </SplitGroup>
      </SplitPanel>
      <SplitHandle label="Resize the inspector" />
      <SplitPanel id="world-inspector" defaultSize="380px" minSize="300px" maxSize="600px" groupResizeBehavior="preserve-pixel-size">
        <Inspector />
      </SplitPanel>
    </SplitGroup>
  );
}

/** Phones get traces, summaries and inspectors, never a desktop-sized 3D scene. */
function MobileWorld() {
  const model = useTraceModel();
  return (
    <div className={styles.mobileStack}>
      <ReplayBar />
      <p className={styles.mobileNote}>The 3D world opens on wider screens. Everything it shows is in the agents table and timeline below.</p>
      <section className={styles.mobileCard} aria-label="Agents">
        <AgentsTable />
      </section>
      <TimelineCard model={model} />
      <MobileInspector />
    </div>
  );
}

/** On phones the inspector is a bottom sheet that opens with a selection. */
export function MobileInspector() {
  const store = useStudioStore();
  const open = useStudio((s) => s.selectedSeq !== null || s.selectedAgentId !== null);
  const close = () => store.getState().clearSelection();
  return (
    <Dialog open={open} onClose={close} labelledBy="inspector-tab-event" placement="bottom" className={styles.sheet}>
      <Inspector onClose={close} />
    </Dialog>
  );
}
