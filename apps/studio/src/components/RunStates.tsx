'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { apiBase, DEFAULT_ALLOWED_ORIGINS, startRuntimeCommand } from '../lib/config';
import { useStudio, useStudioStore } from '../state/context';
import { ROUTES } from '../state/deeplink';
import { runNumber } from '../state/format';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { EmptyState, ErrorState, SkeletonRows } from '../ui/States';
import styles from './RunStates.module.css';
import { NavButtonLink } from './overlays/nav';
import { useStartDemo } from './useStartDemo';

const SAVED = 'Recorded runs stay in the runtime’s database (.runloop/runloop.db by default); nothing is lost while it is stopped.';

/** The origin this page is served from, when the runtime would not accept it by default (CORS). */
function useForeignOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    const o = window.location.origin;
    setOrigin(DEFAULT_ALLOWED_ORIGINS.includes(o) ? null : o);
  }, []);
  return origin;
}

/** The runtime does not answer: what failed, that data is safe, and the exact command to fix it. */
export function OfflineState({ compact }: { compact?: boolean }) {
  const origin = useForeignOrigin();
  useStudio((s) => s.apiBaseOverride); // re-render when the runtime URL changes
  const url = apiBase();
  return (
    <ErrorState compact={compact} title="The local runtime is offline" command={startRuntimeCommand(url)} saved={SAVED}>
      <p>
        No runtime answered at <code>{url}</code>. Start it from the repo root; the Studio reconnects on its own within a few seconds.
      </p>
      {origin && (
        <p className={styles.hint}>
          Already running? It may not accept this page’s origin. Restart it with <code>RUNLOOP_ALLOWED_ORIGINS={origin}</code>.
        </p>
      )}
    </ErrorState>
  );
}

/** A slim banner on run pages when the runtime drops while a run is open. */
export function OfflineBanner() {
  const status = useStudio((s) => s.runtime.status);
  const conn = useStudio((s) => s.conn);
  if (status !== 'offline' && conn !== 'error') return null;
  return (
    <div className={styles.banner} role="alert">
      <Icon name="alert" size={14} />
      <span>
        {status === 'offline' ? 'Runtime offline.' : 'Stream disconnected.'} Showing the events already received; they are saved. Start the runtime with{' '}
        <code>{startRuntimeCommand()}</code> and the Studio reconnects.
      </span>
    </div>
  );
}

export function NoRunsState() {
  const demo = useStartDemo();
  return (
    <EmptyState
      icon="world"
      title="No runs yet"
      actions={
        <>
          <Button variant="primary" icon="play" onClick={() => void demo.start()} busy={demo.starting} disabled={demo.disabledReason !== null}>
            Run demo mission
          </Button>
          <NavButtonLink href={ROUTES.integrations} icon="integrations">
            Connect Claude Code
          </NavButtonLink>
        </>
      }
    >
      <p>Start the scripted demo to watch agents edit files and run tests for real, or connect Claude Code to trace your own sessions.</p>
    </EmptyState>
  );
}

function RunErrorState() {
  const store = useStudioStore();
  const loadError = useStudio((s) => s.loadError);
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const n = runNumber(runs, runId);
  return (
    <ErrorState
      title={`Could not load ${n !== null ? `run #${n}` : 'this run'}`}
      saved="The run’s events are stored by the runtime; only loading them here failed."
      onRetry={() => store.getState().retryConnection()}
    >
      <p>{loadError}</p>
    </ErrorState>
  );
}

/** Run pages render their content only once there is a run to show; otherwise the right state. */
export function RunGate({ children }: { children: ReactNode }) {
  const runtime = useStudio((s) => s.runtime.status);
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const loadError = useStudio((s) => s.loadError);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  let state: ReactNode = null;
  if (!mounted || (runtime === 'unknown' && !runId)) state = <SkeletonRows rows={6} label="Connecting to the runtime" />;
  else if (runtime === 'offline' && (!runId || loadError)) state = <OfflineState />;
  else if (loadError) state = <RunErrorState />;
  else if (!runId && runs.length === 0) state = <NoRunsState />;
  else if (!runId) state = <SkeletonRows rows={6} label="Opening the latest run" />;
  if (state) return <div className={styles.center}>{state}</div>;
  return <>{children}</>;
}
