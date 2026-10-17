'use client';
import { useEffect, useMemo, useState } from 'react';
import { getArtifactText } from '../lib/api';
import { useStudio, useStudioStore } from '../state/context';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ErrorState, SkeletonRows } from '../ui/States';
import styles from './ArtifactViewer.module.css';

type Load = { status: 'loading' } | { status: 'ok'; text: string } | { status: 'error'; message: string };

/** An artifact's metadata (from the trace) and its content (GET /api/runs/:id/artifacts/:aid). */
export default function ArtifactViewer() {
  const store = useStudioStore();
  const artifactId = useStudio((s) => s.viewArtifactId);
  const runId = useStudio((s) => s.runId);
  const lastSequence = useStudio((s) => s.lastSequence);
  const artifact = useMemo(
    () => (artifactId ? store.getState().stateAt(lastSequence).exec.artifacts[artifactId] : undefined),
    [store, artifactId, lastSequence],
  );
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!artifactId || !runId) return;
    let cancelled = false;
    setLoad({ status: 'loading' });
    getArtifactText(runId, artifactId).then(
      (text) => !cancelled && setLoad({ status: 'ok', text }),
      (err: unknown) => !cancelled && setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [artifactId, runId, attempt]);

  const close = () => store.getState().openArtifact(null);

  return (
    <Dialog open={artifactId !== null} onClose={close} labelledBy="artifact-title" className={styles.dialog}>
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name="file" size={16} />
        </span>
        <div className={styles.heading}>
          <h2 id="artifact-title" className={styles.title}>
            {artifact?.name ?? artifactId}
          </h2>
          {artifact && <p className={styles.summary}>{artifact.summary}</p>}
        </div>
        <Button variant="ghost" iconOnly icon="x" aria-label="Close" onClick={close} />
      </header>
      {artifact && (
        <dl className={styles.meta}>
          <div>
            <dt>Kind</dt>
            <dd>{artifact.kind}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{artifact.mediaType}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{artifact.bytes.toLocaleString()} bytes</dd>
          </div>
          {artifact.path && (
            <div>
              <dt>Path</dt>
              <dd>
                <code>{artifact.path}</code>
              </dd>
            </div>
          )}
          <div className={styles.wide}>
            <dt>SHA-256</dt>
            <dd>
              <code className={styles.hash}>{artifact.sha256}</code>
            </dd>
          </div>
          {artifact.producedByCallId && (
            <div>
              <dt>Produced by</dt>
              <dd>
                <code>{artifact.producedByCallId}</code>
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className={styles.content}>
        {load.status === 'loading' && <SkeletonRows rows={5} label="Loading the artifact" />}
        {load.status === 'error' && (
          <ErrorState compact title="Could not load the artifact" saved="The artifact is still stored by the runtime; only this view failed." onRetry={() => setAttempt((n) => n + 1)}>
            <p>{load.message}</p>
          </ErrorState>
        )}
        {load.status === 'ok' && <pre className={styles.pre}>{load.text}</pre>}
      </div>
    </Dialog>
  );
}
