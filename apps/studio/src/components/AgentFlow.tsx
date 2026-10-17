'use client';
import { Fragment, useMemo } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { flowChips } from '../state/view';
import { GlyphIcon, Icon } from '../ui/Icon';
import styles from './AgentFlow.module.css';

/** One chip per task kind at the playhead (core selectAgentFlow): the mission's shape at a glance. */
export default function AgentFlow() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const chips = useMemo(() => flowChips(store.getState().stateAt(seq).exec), [store, seq, lastSequence]);
  if (chips.length === 0) return null;

  return (
    <ol className={styles.flow} aria-label="Task flow at the playhead">
      {chips.map((c, i) => (
        <Fragment key={c.kind}>
          {i > 0 && (
            <li className={styles.arrow} aria-hidden="true">
              <Icon name="chevronRight" size={12} />
            </li>
          )}
          <li className={styles.chip} data-tone={c.view.tone} title={`${c.label}: ${c.view.text} (${c.taskIds.join(', ')})`}>
            <GlyphIcon glyph={c.view.icon} size={12} />
            <span className={styles.label}>{c.label}</span>
            <span className={styles.status}>{c.view.text}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
