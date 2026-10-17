'use client';
import { formatClock } from '@runloop-world/core';
import { useMemo } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import styles from './InfoPanels.module.css';

/** Raw Layer-1 and Layer-2 state at the playhead. */
export default function StatePanel() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const exec = useMemo(() => JSON.stringify(state.exec, null, 2), [state]);
  const world = useMemo(() => JSON.stringify(state.world, null, 2), [state]);

  return (
    <div className={styles.scroll}>
      <p className={styles.note}>
        State after event <strong>#{seq}</strong> ({formatClock(store.getState().timeOfSeq(seq))}). Move the playhead to inspect another moment.
      </p>
      {state.exec.anomalies.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.h2}>
            <span className="badge" data-tone="warn">
              ⚠ {state.exec.anomalies.length} anomal{state.exec.anomalies.length === 1 ? 'y' : 'ies'}
            </span>
          </h2>
          <ul className={styles.anomalies}>
            {state.exec.anomalies.map((a, i) => (
              <li key={i}>
                <code>#{a.seq}</code> <strong>{a.code}</strong> {a.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      <details className={styles.section} open>
        <summary className={styles.h2}>Execution state (Layer 1)</summary>
        <pre className={styles.pre}>{exec}</pre>
      </details>
      <details className={styles.section}>
        <summary className={styles.h2}>World state (Layer 2)</summary>
        <pre className={styles.pre}>{world}</pre>
      </details>
    </div>
  );
}
