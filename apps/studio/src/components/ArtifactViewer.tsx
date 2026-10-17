'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getArtifactText } from '../lib/api';
import { useStudio, useStudioStore } from '../state/context';
import styles from './ArtifactViewer.module.css';

type Load = { status: 'loading' } | { status: 'ok'; text: string } | { status: 'error'; message: string };

/** Modal showing an artifact's metadata (from the trace) and its content (GET /api/runs/:id/artifacts/:aid). */
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

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
  }, [artifactId, runId]);

  useEffect(() => {
    if (!artifactId) return;
    opener.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.getState().openArtifact(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [artifactId, store]);

  if (!artifactId) return null;
  const close = () => store.getState().openArtifact(null);

  return (
    <div className={styles.backdrop} onClick={close}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 id="artifact-title" className={styles.title}>
              <span aria-hidden="true">📄</span> {artifact?.name ?? artifactId}
            </h2>
            {artifact && <p className={styles.summary}>{artifact.summary}</p>}
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Close">
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        {artifact && (
          <dl className={styles.meta}>
            <dt>Kind</dt>
            <dd>{artifact.kind}</dd>
            <dt>Type</dt>
            <dd>{artifact.mediaType}</dd>
            <dt>Size</dt>
            <dd>{artifact.bytes} bytes</dd>
            {artifact.path && (
              <>
                <dt>Path</dt>
                <dd>
                  <code>{artifact.path}</code>
                </dd>
              </>
            )}
            <dt>SHA-256</dt>
            <dd>
              <code className={styles.hash}>{artifact.sha256}</code>
            </dd>
            {artifact.producedByCallId && (
              <>
                <dt>Produced by</dt>
                <dd>
                  <code>{artifact.producedByCallId}</code>
                </dd>
              </>
            )}
          </dl>
        )}
        <div className={styles.content}>
          {load.status === 'loading' && <p className={styles.note}>Loading…</p>}
          {load.status === 'error' && (
            <p className={styles.error} role="alert">
              ✗ Could not load the artifact: {load.message}
            </p>
          )}
          {load.status === 'ok' && <pre className={styles.pre}>{load.text}</pre>}
        </div>
      </div>
    </div>
  );
}
