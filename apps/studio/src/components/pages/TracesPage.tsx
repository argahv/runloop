'use client';
import ReplayBar from '../ReplayBar';
import RunHeader from '../RunHeader';
import { OfflineBanner, RunGate } from '../RunStates';
import { useInWorld } from '../overlays/nav';
import TraceSheet from '../overlays/TraceSheet';
import styles from './Pages.module.css';
import { TraceView } from './TraceView';

export { TraceView, type TraceWorldTab } from './TraceView';

/**
 * Traces: investigate one run (timeline, logs, state, metadata) with search,
 * filters and the inspector; no world. Shown inside the world (a sheet on
 * `/`), it is the trace sheet: the same views plus the run's World tab.
 */
export default function TracesPage() {
  if (useInWorld()) return <TraceSheet />;
  return (
    <div className={styles.runPage}>
      <RunGate>
        <RunHeader page="traces" />
        <OfflineBanner />
        <ReplayBar />
        <TraceView />
      </RunGate>
    </div>
  );
}
