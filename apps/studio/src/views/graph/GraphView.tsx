'use client';
import { useEffect, useState } from 'react';
import AgentsTable from '../../components/AgentsTable';
import { safeStorage } from '../../state/prefs';
import { SegmentedControl } from '../../ui/SegmentedControl';
import NetworkGraph from './NetworkGraph';
import styles from './graph.module.css';

type Mode = 'graph' | 'table';
const KEY = 'runloop.network-view.v1';

/**
 * The Live World's 2D slot ("Network"): the agent graph, or the agents table.
 * Needs no WebGL, so it is also the fallback when the 3D world cannot run.
 */
export default function GraphView({ notice }: { notice?: string }) {
  const [mode, setMode] = useState<Mode>('graph');
  // The viewer's last choice, read after mount (the server render has no storage).
  useEffect(() => {
    if (safeStorage.getItem(KEY) === 'table') setMode('table');
  }, []);
  const choose = (m: Mode) => {
    setMode(m);
    safeStorage.setItem(KEY, m);
  };
  return (
    <div className={styles.view} data-mode={mode}>
      <div className={styles.toolbar}>
        <SegmentedControl
          size="sm"
          label="Network view"
          value={mode}
          onChange={choose}
          options={[
            { value: 'graph', label: 'Graph', icon: 'graph' },
            { value: 'table', label: 'Table', icon: 'table' },
          ]}
        />
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div className={styles.body}>{mode === 'graph' ? <NetworkGraph /> : <AgentsTable />}</div>
    </div>
  );
}
