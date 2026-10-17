'use client';
import { Fragment, useMemo } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { flowChips } from '../state/view';
import styles from './AgentFlow.module.css';

/** One chip per task kind at the playhead (core selectAgentFlow). */
export default function AgentFlow() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const chips = useMemo(() => flowChips(store.getState().stateAt(seq).exec), [store, seq, lastSequence]);

  return (
    <section className={styles.flow} aria-label="Agent flow">
      <h2 className={styles.heading}>Agent flow</h2>
      {chips.length === 0 ? (
        <p className={styles.empty}>Tasks appear here as the coordinator creates them.</p>
      ) : (
        <ol className={styles.chips}>
          {chips.map((c, i) => (
            <Fragment key={c.kind}>
              {i > 0 && (
                <li className={styles.arrow} aria-hidden="true">
                  →
                </li>
              )}
              <li className={styles.chip} data-tone={c.view.tone} title={`${c.label}: ${c.view.text} (${c.taskIds.join(', ')})`}>
                <span className={styles.icon} aria-hidden="true">
                  {c.view.icon}
                </span>
                <span className={styles.label}>{c.label}</span>
                <span className={styles.status}>{c.view.text}</span>
              </li>
            </Fragment>
          ))}
        </ol>
      )}
    </section>
  );
}
