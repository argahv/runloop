'use client';
import { SIMULATED_DECISION_LABEL, type Explanation, type ExplanationOption } from '@runloop-world/events';
import { useEffect, useState } from 'react';
import { getExplanation, WorldApiError } from '../../world/api';
import { useWorldStore } from '../../world/context';
import { explanationView } from '../../world/selectors';
import { Icon } from '../../ui/Icon';
import { Skeleton } from '../../ui/States';
import styles from './panels.module.css';

type Load = { state: 'loading' } | { state: 'ready'; x: Explanation } | { state: 'none'; message: string } | { state: 'error'; message: string };

/**
 * Why a resident is doing what it does (plan §3, P10): the engine's
 * explanation of one recorded `resident.decided` event. Every factor links to
 * the event field it comes from; a factor without a source is dropped. It is
 * labelled as a simulated, rule-based decision and never as reasoning.
 */
export default function ExplanationBlock({ residentId, atSeq }: { residentId: string; atSeq: number }) {
  const store = useWorldStore();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [showAlts, setShowAlts] = useState(false);

  useEffect(() => {
    if (atSeq <= 0) {
      setLoad({ state: 'none', message: 'No decision recorded yet.' });
      return;
    }
    let live = true;
    setLoad((l) => (l.state === 'ready' ? l : { state: 'loading' }));
    getExplanation(residentId, atSeq).then(
      (r) => live && setLoad({ state: 'ready', x: r.explanation }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof WorldApiError && e.status === 404) setLoad({ state: 'none', message: 'The decision behind this was pruned from the log (ambient events are kept for 3 sim days).' });
        else setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [residentId, atSeq]);

  const open = (seq: number) => store.getState().showInLog({ seq, actor: residentId });

  return (
    <section className={styles.why} aria-labelledby="why-title" aria-busy={load.state === 'loading' || undefined}>
      <div className={styles.sectionHead}>
        <h3 id="why-title" className={styles.h3}>
          Why
        </h3>
        <span className={styles.whyLabel}>
          <Icon name="diamond" size={12} />
          {SIMULATED_DECISION_LABEL}
        </span>
      </div>
      {load.state === 'loading' && (
        <div className={styles.factors}>
          <Skeleton width="70%" />
          <Skeleton width="55%" />
          <Skeleton width="62%" />
        </div>
      )}
      {(load.state === 'none' || load.state === 'error') && <p className={styles.note}>{load.state === 'error' ? `Could not load the explanation: ${load.message}` : load.message}</p>}
      {load.state === 'ready' &&
        (() => {
          const v = explanationView(load.x);
          return (
            <>
              <Option o={v.chosen} onSource={open} />
              {v.alternatives.length > 0 && (
                <button type="button" className={styles.source} aria-expanded={showAlts} onClick={() => setShowAlts((s) => !s)} style={{ alignSelf: 'flex-start' }}>
                  <Icon name={showAlts ? 'chevronDown' : 'chevronRight'} size={12} />
                  {showAlts ? 'Hide' : 'Show'} {v.alternatives.length} other {v.alternatives.length === 1 ? 'option' : 'options'} it scored
                </button>
              )}
              {showAlts && (
                <div className={styles.alts}>
                  {v.alternatives.map((o, i) => (
                    <Option key={i} o={o} onSource={open} alt />
                  ))}
                </div>
              )}
              <p className={styles.whyFoot}>
                Simulated decision recorded by the engine ·{' '}
                <button type="button" className={styles.source} onClick={() => open(load.x.atSeq)}>
                  seq {load.x.atSeq}
                </button>
                {v.dropped > 0 && ` · ${v.dropped} unsourced ${v.dropped === 1 ? 'factor' : 'factors'} hidden`}
              </p>
            </>
          );
        })()}
    </section>
  );
}

function Option({ o, onSource, alt }: { o: ExplanationOption; onSource: (seq: number) => void; alt?: boolean }) {
  return (
    <div className={[styles.option, alt ? styles.optionAlt : ''].join(' ')}>
      <div className={styles.optionHead}>
        <span>{o.label}</span>
        <span className={styles.score}>score {o.total}</span>
      </div>
      <ul className={styles.factors}>
        {o.factors.map((f, i) => (
          <li key={i} className={styles.factor}>
            <span>{f.text}</span>
            <button type="button" className={styles.source} onClick={() => onSource(f.source.seq)} title={`Recorded in event ${f.source.seq}, field ${f.source.field}`}>
              <Icon name="link" size={11} />
              {f.source.seq} · {f.source.field}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
