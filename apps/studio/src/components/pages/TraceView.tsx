'use client';
import type { ReactNode } from 'react';
import { useStudio, useStudioStore } from '../../state/context';
import type { Tab } from '../../state/store';
import { SplitGroup, SplitHandle, SplitPanel } from '../../ui/SplitPanels';
import { Tabs } from '../../ui/Tabs';
import { MOBILE_QUERY, useMediaQuery } from '../../ui/useMediaQuery';
import FilterBar from '../FilterBar';
import Inspector from '../Inspector';
import LogsPanel from '../LogsPanel';
import MetadataPanel from '../MetadataPanel';
import RunMetrics from '../RunMetrics';
import StatePanel from '../StatePanel';
import TimelinePanel from '../TimelinePanel';
import { useTraceModel } from '../useTraceModel';
import styles from './Pages.module.css';
import { MobileInspector } from './WorldPage';

/**
 * The trace's World tab (the in-world trace sheet adds it): the run's world,
 * shown in place of the trace views while `active`.
 */
export interface TraceWorldTab {
  active: boolean;
  set(active: boolean): void;
  content: ReactNode;
}

/**
 * The trace views and the inspector: Timeline, Logs, Metrics, State and
 * Metadata beside a resizable inspector (a bottom sheet on phones). The
 * Traces page and the in-world trace sheet both show this; `idPrefix` keeps
 * their remembered panel sizes apart.
 */
export function TraceView({ world, idPrefix = 'traces', inspector }: { world?: TraceWorldTab; idPrefix?: string; inspector?: { defaultSize: string; minSize: string; maxSize: string } }) {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const size = inspector ?? { defaultSize: '420px', minSize: '300px', maxSize: '680px' };
  if (mobile) {
    return (
      <>
        <TraceContent world={world} />
        <MobileInspector />
      </>
    );
  }
  return (
    <SplitGroup id={`${idPrefix}-main`} className={styles.split}>
      <SplitPanel id={`${idPrefix}-content`} minSize="420px">
        <TraceContent world={world} />
      </SplitPanel>
      <SplitHandle label="Resize the inspector" />
      <SplitPanel id={`${idPrefix}-inspector`} defaultSize={size.defaultSize} minSize={size.minSize} maxSize={size.maxSize} groupResizeBehavior="preserve-pixel-size">
        <Inspector />
      </SplitPanel>
    </SplitGroup>
  );
}

function TraceContent({ world }: { world?: TraceWorldTab }) {
  const store = useStudioStore();
  const tab = useStudio((s) => s.tab);
  const model = useTraceModel();
  const showWorld = world?.active === true;
  const filterable = !showWorld && (tab === 'timeline' || tab === 'logs');
  const items: { id: Tab | 'world'; label: string; count?: number }[] = [
    ...(world ? [{ id: 'world' as const, label: 'World' }] : []),
    { id: 'timeline', label: 'Timeline', count: model.visibleRows.length },
    { id: 'logs', label: 'Logs', count: model.visibleEvents.length },
    { id: 'metrics', label: 'Metrics' },
    { id: 'state', label: 'State' },
    { id: 'metadata', label: 'Metadata' },
  ];
  const value: Tab | 'world' = showWorld ? 'world' : tab;
  const onChange = (t: Tab | 'world') => {
    if (t === 'world') return world?.set(true);
    world?.set(false);
    store.getState().setTab(t);
  };
  return (
    <section className={styles.traceCard} aria-label="Trace">
      <div className={styles.traceHead}>
        <Tabs items={items} value={value} onChange={onChange} label="Trace views" idPrefix="trace" />
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
      <div className={styles.tracePanel} id="trace-panel" role="tabpanel" aria-labelledby={`trace-tab-${value}`}>
        {showWorld && world.content}
        {!showWorld && tab === 'timeline' && <TimelinePanel model={model} />}
        {!showWorld && tab === 'logs' && <LogsPanel model={model} />}
        {!showWorld && tab === 'metrics' && (
          <div className={styles.panelScroll}>
            <RunMetrics onShowTimeline={() => store.getState().setTab('timeline')} />
          </div>
        )}
        {!showWorld && tab === 'state' && <StatePanel />}
        {!showWorld && tab === 'metadata' && <MetadataPanel />}
      </div>
    </section>
  );
}
