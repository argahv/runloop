'use client';
import { formatClock } from '@runloop-world/core';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { buildTimelineRows, formatDuration, rowStatusAt, STATUS_LABEL, type RowStatus, type TimelineRow } from '../state/timeline';
import { agentLook } from '../state/view';
import styles from './TimelinePanel.module.css';

const STATUS_ICON: Partial<Record<RowStatus, string>> = { running: '⚙', ok: '✓', error: '✗', warn: '⚠' };
const STATUS_TONE: Record<RowStatus, string> = { running: 'live', ok: 'ok', error: 'err', warn: 'warn', info: 'muted' };

export default function TimelinePanel() {
  const store = useStudioStore();
  const lastSequence = useStudio((s) => s.lastSequence);
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const world = useStudio((s) => s.world);
  const follow = useStudio((s) => s.cursor.mode === 'live' || s.cursor.playing);
  const listRef = useRef<HTMLOListElement>(null);

  // Rows depend only on the received events; the playhead only changes how they look.
  const rows = useMemo(() => {
    const s = store.getState();
    return buildTimelineRows(s.events(), s.timeOfSeq);
  }, [store, lastSequence]);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);

  let current = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.seq <= playheadSeq) {
      current = i;
      break;
    }
  }

  useEffect(() => {
    const list = listRef.current;
    const row = current >= 0 ? list?.querySelector<HTMLElement>('[data-current="true"]') : null;
    if (!list || !row) return;
    if (follow) {
      row.scrollIntoView({ block: 'nearest' });
      return;
    }
    // A seek while paused (scrub, ←/→, incident marker, "Move playhead here"):
    // show the row if it is off-screen; a click on a visible row does not scroll.
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) row.scrollIntoView({ block: 'center' });
  }, [current, follow]);

  const onRow = (row: TimelineRow) => {
    const s = store.getState();
    s.seekToSeq(row.endSeq ?? row.seq);
    if (agentLook(exec, world, row.actorId).embodied) s.selectAgent(row.actorId);
  };

  if (rows.length === 0) {
    return <p className={styles.empty}>{lastSequence === 0 ? 'No events yet.' : ''}</p>;
  }

  return (
    <ol className={styles.list} ref={listRef} aria-label="Timeline">
      {rows.map((row, i) => {
        const status = rowStatusAt(row, playheadSeq);
        const look = agentLook(exec, world, row.actorId);
        const future = row.seq > playheadSeq;
        const icon = row.callId !== null ? (STATUS_ICON[status] ?? row.icon) : row.icon;
        return (
          <li
            key={row.key}
            className={styles.row}
            data-future={future || undefined}
            data-current={i === current || undefined}
            data-status={status}
            style={{ '--role': look.color } as CSSProperties}
          >
            <button type="button" className={styles.main} onClick={() => onRow(row)} aria-current={i === current ? 'step' : undefined}>
              <span className={styles.time}>{formatClock(row.tMs)}</span>
              <span className={styles.icon} data-tone={STATUS_TONE[status]} aria-hidden="true">
                {icon}
              </span>
              <span className={styles.body}>
                <span className={styles.head}>
                  <span className="dot" aria-hidden="true" />
                  <span className={styles.actor}>{look.name}</span>
                  {status !== 'info' && (
                    <span className="badge" data-tone={STATUS_TONE[status]}>
                      {STATUS_LABEL[status]}
                    </span>
                  )}
                  {future && <span className="sr-only">(after the playhead)</span>}
                </span>
                <span className={styles.title}>{row.title}</span>
                {row.detail && (status !== 'running' || row.callId === null) && <span className={styles.detail}>{row.detail}</span>}
                {(row.metrics || row.durationMs !== null) && status !== 'running' && (
                  <span className={styles.facts}>
                    {row.metrics && (
                      <>
                        <span className="chip" data-tone="ok">
                          ✓ {row.metrics.passed} passed
                        </span>
                        <span className="chip" data-tone={row.metrics.failed > 0 ? 'err' : undefined}>
                          ✗ {row.metrics.failed} failed
                        </span>
                      </>
                    )}
                    {row.durationMs !== null && <span className="chip">{formatDuration(row.durationMs)}</span>}
                  </span>
                )}
              </span>
            </button>
            {row.artifactIds.length > 0 && (row.endSeq === null || row.endSeq <= playheadSeq) && (
              <span className={styles.artifacts}>
                {row.artifactIds.map((id) => (
                  <button key={id} type="button" className="link" onClick={() => store.getState().openArtifact(id)}>
                    <span aria-hidden="true">📄</span> {exec.artifacts[id]?.name ?? id}
                  </button>
                ))}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
