'use client';
import { formatClock } from '@runloop-world/core';
import { isUnknownEvent } from '@runloop-world/events';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { EMPTY_FILTER, activeFilterCount } from '../state/filters';
import { eventProvenance } from '../state/selection';
import { agentLook } from '../state/view';
import { Button } from '../ui/Button';
import { AgentDot, Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/States';
import { listKeyHandler, useRovingRow, useVirtualRows } from '../ui/useVirtualRows';
import styles from './LogsPanel.module.css';
import type { TraceModel } from './useTraceModel';

/** Every recorded event, one line each (plus envelopes that failed validation). Selecting one opens it in the inspector. */
export default function LogsPanel({ model }: { model: TraceModel }) {
  const store = useStudioStore();
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const selectedSeq = useStudio((s) => s.selectedSeq);
  const world = useStudio((s) => s.world);
  const raw = useStudio((s) => s.raw);
  const conn = useStudio((s) => s.conn);
  const filter = useStudio((s) => s.filter);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const listRef = useRef<HTMLOListElement>(null);
  const { events, visibleEvents, exec } = model;
  const filtered = activeFilterCount(filter) > 0;
  const keys = useMemo(() => visibleEvents.map((e) => e.eventId), [visibleEvents]);
  const v = useVirtualRows(listRef, keys, 34);
  const selected = selectedSeq === null ? -1 : visibleEvents.findIndex((e) => e.sequence === selectedSeq);
  // One Tab stop for the whole list (arrow keys move within it): the selected entry, else the playhead's.
  let atPlayhead = -1;
  for (let i = visibleEvents.length - 1; i >= 0 && atPlayhead < 0; i--) if (visibleEvents[i]!.sequence <= playheadSeq) atPlayhead = i;
  const roving = useRovingRow(selected >= 0 ? selected : Math.max(0, atPlayhead));
  const tabStop = Math.min(roving.tabStop, visibleEvents.length - 1);

  useEffect(() => {
    if (selected >= 0) v.scrollToIndex(selected);
  }, [selected]);

  const copyJsonl = async () => {
    const s = store.getState();
    const lines = [...events.map((e) => JSON.stringify(s.rawEvent(e.sequence) ?? e)), ...raw.map((r) => JSON.stringify(r.raw))];
    try {
      await navigator.clipboard.writeText(lines.join('\n') + '\n');
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  };

  if (events.length === 0 && raw.length === 0) {
    if (conn === 'loading') return <SkeletonRows rows={8} label="Loading the event log" />;
    return (
      <EmptyState compact icon="traces" title="No events recorded yet">
        <p>Each event the runtime records appears here with its raw JSON.</p>
      </EmptyState>
    );
  }

  return (
    <div className={styles.logs}>
      <div className={styles.toolbar}>
        <span className={styles.note}>
          {raw.length > 0 ? `${raw.length} envelope${raw.length > 1 ? 's' : ''} failed validation (listed at the end)` : 'Raw events as recorded'}
        </span>
        <Button size="sm" variant="ghost" icon={copyState === 'copied' ? 'check' : 'copy'} onClick={() => void copyJsonl()}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy JSONL'}
        </Button>
      </div>
      {visibleEvents.length === 0 && filtered ? (
        <EmptyState
          compact
          icon="filter"
          title="No events match these filters"
          actions={
            <Button size="sm" onClick={() => store.getState().setFilter(EMPTY_FILTER)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ol className={styles.list} aria-label="Event log" ref={listRef} onKeyDown={listKeyHandler(visibleEvents.length, v)} onBlur={roving.onBlurList}>
          {v.padTop > 0 && <li className={styles.spacer} style={{ height: v.padTop }} aria-hidden="true" />}
          {visibleEvents.slice(v.start, v.end).map((e, k) => {
            const i = v.start + k;
            const unknown = isUnknownEvent(e);
            const agentId = model.agentOf(e);
            const look = agentLook(exec, world, agentId ?? 'system');
            const isSelected = i === selected;
            const future = e.sequence > playheadSeq;
            return (
              <li
                key={e.eventId}
                ref={v.measure(i)}
                data-index={i}
                aria-setsize={visibleEvents.length}
                aria-posinset={i + 1}
                className={styles.entry}
                data-future={future || undefined}
                data-playhead={(future && (i === 0 || visibleEvents[i - 1]!.sequence <= playheadSeq)) || undefined}
                data-selected={isSelected || undefined}
              >
                <button
                  type="button"
                  data-row
                  tabIndex={i === tabStop ? 0 : -1}
                  onFocus={() => roving.onFocusRow(i)}
                  className={styles.summary}
                  aria-current={isSelected ? 'true' : undefined}
                  aria-label={future ? `#${e.sequence} ${e.type}, after the playhead` : undefined}
                  onClick={() => store.getState().selectEvent(e.sequence)}
                >
                  <span className={styles.seq}>#{e.sequence}</span>
                  <span className={styles.clock}>{formatClock(store.getState().timeOfSeq(e.sequence))}</span>
                  <span className={styles.type}>{e.type}</span>
                  <span className={styles.actor}>
                    <AgentDot color={look.color} size={7} />
                    {look.name}
                    {e.taskId && <span className={styles.task}>{e.taskId}</span>}
                  </span>
                  <span className={styles.chips}>
                    {eventProvenance(e) === 'inferred' && (
                      <Chip tone="warn" icon="inferred">
                        inferred
                      </Chip>
                    )}
                    {e.visibility !== 'public' && (
                      <Chip tone="warn" icon={e.visibility === 'sensitive' ? 'lock' : 'eyeOff'}>
                        {e.visibility}
                      </Chip>
                    )}
                    {unknown && (
                      <Chip tone="warn" icon="alert">
                        {e.reason.replace(/_/g, ' ')}
                      </Chip>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {v.padBottom > 0 && <li className={styles.spacer} style={{ height: v.padBottom }} aria-hidden="true" />}
          {!filtered &&
            raw.map((r) => (
              <li key={`raw-${r.id}`} className={styles.entry} data-invalid="true">
                <details className={styles.invalid}>
                  <summary className={styles.summary}>
                    <span className={styles.seq}>{r.sequence !== null ? `#${r.sequence}` : '#?'}</span>
                    <span className={styles.clock}>—</span>
                    <span className={styles.type}>invalid envelope</span>
                    <span className={styles.actor}>{r.error}</span>
                    <span className={styles.chips}>
                      <Chip tone="err" icon="x">
                        not recorded as an event
                      </Chip>
                    </span>
                  </summary>
                  <pre className={styles.json}>{typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw, null, 2)}</pre>
                </details>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}
