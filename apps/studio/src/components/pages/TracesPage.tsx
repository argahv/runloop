'use client';
import { useStudio, useStudioStore } from '../../state/context';
import type { Tab } from '../../state/store';
import { SplitGroup, SplitHandle, SplitPanel } from '../../ui/SplitPanels';
import { Tabs } from '../../ui/Tabs';
import { MOBILE_QUERY, useMediaQuery } from '../../ui/useMediaQuery';
import FilterBar from '../FilterBar';
import Inspector from '../Inspector';
import LogsPanel from '../LogsPanel';
import MetadataPanel from '../MetadataPanel';
import ReplayBar from '../ReplayBar';
import RunHeader from '../RunHeader';
import RunMetrics from '../RunMetrics';
import { OfflineBanner, RunGate } from '../RunStates';
import StatePanel from '../StatePanel';
import TimelinePanel from '../TimelinePanel';
import { useTraceModel } from '../useTraceModel';
import styles from './Pages.module.css';
import { MobileInspector } from './WorldPage';

/** Traces: investigate one run (timeline, logs, state, metadata) with search, filters and the inspector; no world. */
export default function TracesPage() {
  const mobile = useMediaQuery(MOBILE_QUERY);
  return (
    <div className={styles.runPage}>
      <RunGate>
        <RunHeader page="traces" />
        <OfflineBanner />
        <ReplayBar />
        {mobile ? (
          <>
            <TraceContent />
            <MobileInspector />
          </>
        ) : (
          <SplitGroup id="traces-main" className={styles.split}>
            <SplitPanel id="traces-content" minSize="420px">
              <TraceContent />
            </SplitPanel>
            <SplitHandle label="Resize the inspector" />
            <SplitPanel id="traces-inspector" defaultSize="420px" minSize="300px" maxSize="680px" groupResizeBehavior="preserve-pixel-size">
              <Inspector />
            </SplitPanel>
          </SplitGroup>
        )}
      </RunGate>
    </div>
  );
}

function TraceContent() {
  const store = useStudioStore();
  const tab = useStudio((s) => s.tab);
  const model = useTraceModel();
  const filterable = tab === 'timeline' || tab === 'logs';
  const items: { id: Tab; label: string; count?: number }[] = [
    { id: 'timeline', label: 'Timeline', count: model.visibleRows.length },
    { id: 'logs', label: 'Logs', count: model.visibleEvents.length },
    { id: 'metrics', label: 'Metrics' },
    { id: 'state', label: 'State' },
    { id: 'metadata', label: 'Metadata' },
  ];
  return (
    <section className={styles.traceCard} aria-label="Trace">
      <div className={styles.traceHead}>
        <Tabs items={items} value={tab} onChange={(t) => store.getState().setTab(t)} label="Trace views" idPrefix="trace" />
      </div>
      {filterable && (
        <div className={styles.filters}>
          {tab === 'timeline' ? (
            <FilterBar facets={model.rowFacets} agents={model.agents} shown={model.visibleRows.length} total={model.rows.length} noun="rows" />
          ) : (
            <FilterBar facets={model.eventFacets} agents={model.agents} shown={model.visibleEvents.length} total={model.events.length} noun="events" />
          )}
        </div>
      )}
      <div className={styles.tracePanel} id="trace-panel" role="tabpanel" aria-labelledby={`trace-tab-${tab}`}>
        {tab === 'timeline' && <TimelinePanel model={model} />}
        {tab === 'logs' && <LogsPanel model={model} />}
        {tab === 'metrics' && (
          <div className={styles.panelScroll}>
            <RunMetrics onShowTimeline={() => store.getState().setTab('timeline')} />
          </div>
        )}
        {tab === 'state' && <StatePanel />}
        {tab === 'metadata' && <MetadataPanel />}
      </div>
    </section>
  );
}
