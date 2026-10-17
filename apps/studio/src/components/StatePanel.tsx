'use client';
import { formatClock } from '@runloop-world/core';
import { useMemo, useState } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { Chip } from '../ui/Chip';
import styles from './InfoPanels.module.css';

/** Raw Layer-1 (execution) and Layer-2 (world) state at the playhead. */
export default function StatePanel() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const [open, setOpen] = useState<'exec' | 'world'>('exec');
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const json = useMemo(() => JSON.stringify(open === 'exec' ? state.exec : state.world, null, 2), [state, open]);

  return (
    <div className={styles.scroll}>
      <p className={styles.note}>
        State after event <strong>#{seq}</strong> at {formatClock(store.getState().timeOfSeq(seq))}. Move the playhead to inspect another moment.
      </p>
      {state.exec.anomalies.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.h2}>
            <Chip tone="warn" icon="alert">
              {state.exec.anomalies.length} anomal{state.exec.anomalies.length === 1 ? 'y' : 'ies'}
            </Chip>
          </h2>
          <ul className={styles.anomalies}>
            {state.exec.anomalies.map((a, i) => (
              <li key={i}>
                <button type="button" className={styles.anomaly} onClick={() => store.getState().selectEvent(a.seq)}>
                  <code>#{a.seq}</code> <strong>{a.code.replace(/_/g, ' ')}</strong> <span>{a.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className={styles.switch} role="group" aria-label="Layer">
        <button type="button" aria-pressed={open === 'exec'} onClick={() => setOpen('exec')}>
          Execution (Layer 1)
        </button>
        <button type="button" aria-pressed={open === 'world'} onClick={() => setOpen('world')}>
          World (Layer 2)
        </button>
      </div>
      <pre className={styles.pre}>{json}</pre>
    </div>
  );
}
