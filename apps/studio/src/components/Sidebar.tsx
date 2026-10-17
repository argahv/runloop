'use client';
import { useState } from 'react';
import { ApiError, startRun } from '../lib/api';
import { API_BASE, DEMO_MISSION_ID, START_RUNTIME_COMMAND } from '../lib/config';
import { useStudio, useStudioStore } from '../state/context';
import { selectRun } from '../state/hooks';
import { runStatusView } from '../state/view';
import styles from './Sidebar.module.css';
import StatusBadge from './StatusBadge';

export default function Sidebar() {
  const store = useStudioStore();
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const runtime = useStudio((s) => s.runtime);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const offline = runtime.status !== 'online';
  const active = runtime.activeRunId;

  const onStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { runId: id } = await startRun(DEMO_MISSION_ID);
      selectRun(store, id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && active) {
        setStartError('A run is already in progress.');
        selectRun(store, active);
      } else {
        setStartError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <nav className={styles.sidebar} aria-label="Runs">
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden="true" />
        <span>
          <strong>Runloop</strong>
          <span className={styles.sub}>Studio</span>
        </span>
      </div>

      <button
        type="button"
        className={`btn btn-primary ${styles.start}`}
        onClick={() => void onStart()}
        disabled={offline || starting || active !== null}
        title={active ? 'Wait for the active run to finish' : undefined}
      >
        <span aria-hidden="true">▶</span> {starting ? 'Starting…' : 'Run demo mission'}
      </button>
      {startError && (
        <p className={styles.error} role="alert">
          {startError}
        </p>
      )}

      <h2 className={styles.heading}>Runs</h2>
      {runs.length === 0 ? (
        <p className={styles.empty}>{offline ? 'Runs appear once the runtime is online.' : 'No runs yet.'}</p>
      ) : (
        <ol className={styles.runs}>
          {runs.map((r, i) => (
            <li key={r.runId}>
              <button
                type="button"
                className={styles.run}
                aria-current={r.runId === runId ? 'true' : undefined}
                onClick={() => selectRun(store, r.runId)}
              >
                <span className={styles.runTop}>
                  <span className={styles.runNo}>#{runs.length - i}</span>
                  <StatusBadge view={runStatusView(r.status, r.paused)} />
                </span>
                <span className={styles.runTitle}>{r.title}</span>
                <span className={styles.runMeta}>{new Date(r.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.runtime} aria-live="polite">
        <h2 className={styles.heading}>Local runtime</h2>
        {runtime.status === 'online' && (
          <p className={styles.status}>
            <StatusBadge view={{ icon: '●', text: 'online', tone: 'ok' }} />
            <span className={styles.meta}>v{runtime.version}</span>
          </p>
        )}
        {runtime.status === 'unknown' && (
          <p className={styles.status}>
            <StatusBadge view={{ icon: '…', text: 'checking', tone: 'muted' }} />
          </p>
        )}
        {runtime.status === 'offline' && (
          <div className={styles.offline}>
            <p className={styles.status}>
              <StatusBadge view={{ icon: '✗', text: 'offline', tone: 'err' }} />
            </p>
            <p>
              No runtime at <code>{API_BASE}</code>. Start it from the repo root:
            </p>
            <code className={styles.cmd}>{START_RUNTIME_COMMAND}</code>
          </div>
        )}
        <p className={styles.endpoint}>
          <code>{API_BASE.replace(/^https?:\/\//, '')}</code>
        </p>
      </div>
    </nav>
  );
}
