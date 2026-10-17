'use client';
import { useEffect, useRef, useState } from 'react';
import { connectRun } from '../state/connect';
import { StudioProvider, useStudio } from '../state/context';
import {
  runIdFromUrl,
  selectRun,
  useKeyboardShortcuts,
  usePlaybackDriver,
  useReducedMotion,
  useRuntimePolling,
} from '../state/hooks';
import { createStudioStore, type StudioStore } from '../state/store';
import AgentDetails from './AgentDetails';
import AgentFlow from './AgentFlow';
import ArtifactViewer from './ArtifactViewer';
import LogsPanel from './LogsPanel';
import MetadataPanel from './MetadataPanel';
import ReplayBar from './ReplayBar';
import RunHeader from './RunHeader';
import Sidebar from './Sidebar';
import StatePanel from './StatePanel';
import styles from './Studio.module.css';
import TimelinePanel from './TimelinePanel';
import WorldView from './WorldView';

export default function Studio() {
  const [store] = useState(() => createStudioStore());
  return (
    <StudioProvider store={store}>
      <Shell store={store} />
    </StudioProvider>
  );
}

function Shell({ store }: { store: StudioStore }) {
  const runId = useStudio((s) => s.runId);
  const tab = useStudio((s) => s.tab);
  const retry = useReconnectNonce(store);

  useEffect(() => {
    const fromUrl = runIdFromUrl();
    if (fromUrl) selectRun(store, fromUrl);
  }, [store]);
  useRuntimePolling(store);
  usePlaybackDriver(store);
  useReducedMotion(store);
  useKeyboardShortcuts(store);
  useEffect(() => (runId ? connectRun(store, runId) : undefined), [store, runId, retry]);

  return (
    <div className={styles.studio} data-wide={tab === 'timeline' ? undefined : 'true'}>
      <Sidebar />
      <RunHeader />
      <section className={styles.panel} id="studio-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'timeline' && <TimelinePanel />}
        {tab === 'logs' && <LogsPanel />}
        {tab === 'state' && <StatePanel />}
        {tab === 'metadata' && <MetadataPanel />}
      </section>
      <main className={styles.world}>
        <WorldView />
        <ReplayBar />
        <AgentFlow />
      </main>
      <aside className={styles.details} aria-label="Agent details">
        <AgentDetails />
      </aside>
      <ArtifactViewer />
    </div>
  );
}

/** Bumps when the runtime comes back online after the open run failed to load or stream. */
function useReconnectNonce(store: StudioStore): number {
  const [nonce, setNonce] = useState(0);
  const prev = useRef(store.getState().runtime.status);
  useEffect(
    () =>
      store.subscribe((s) => {
        const was = prev.current;
        prev.current = s.runtime.status;
        if (was === 'offline' && s.runtime.status === 'online' && s.runId && (s.loadError || s.conn === 'error')) {
          setNonce((n) => n + 1);
        }
      }),
    [store],
  );
  return nonce;
}
