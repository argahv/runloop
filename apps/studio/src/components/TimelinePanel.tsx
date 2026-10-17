'use client';
import { formatClock } from '@runloop-world/core';
import { useEffect, useMemo, useRef } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { activeFilterCount, EMPTY_FILTER } from '../state/filters';
import { formatDuration, lastRowAtOrBefore, rowIndexBySeq, rowStatusAt, selectedRow, STATUS_LABEL, type RowStatus, type TimelineRow } from '../state/timeline';
import { CATEGORY_ICON, categoryLabel } from '../state/labels';
import { agentLook } from '../state/view';
import { Button } from '../ui/Button';
import { AgentDot, Chip } from '../ui/Chip';
import { GlyphIcon, Icon } from '../ui/Icon';
import { EmptyState, SkeletonRows } from '../ui/States';
import { listKeyHandler, useRovingRow, useVirtualRows } from '../ui/useVirtualRows';
import styles from './TimelinePanel.module.css';
import type { TraceModel } from './useTraceModel';

const STATUS_ICON: Partial<Record<RowStatus, string>> = { running: '⚙', ok: '✓', error: '✗', warn: '⚠' };
const STATUS_TONE: Record<RowStatus, string> = { running: 'live', ok: 'ok', error: 'err', warn: 'warn', info: 'muted' };


/**
 * The run as readable rows (a tool call's start and result are one row).
 * Selecting a row selects its event everywhere (world, inspector, URL) and
 * moves the playhead there.
 */
export default function TimelinePanel({ model }: { model: TraceModel }) {
  const store = useStudioStore();
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const selectedSeq = useStudio((s) => s.selectedSeq);
  const world = useStudio((s) => s.world);
  const conn = useStudio((s) => s.conn);
  const ended = useStudio((s) => s.ended);
  const filter = useStudio((s) => s.filter);
  const follow = useStudio((s) => s.cursor.mode === 'live' || s.cursor.playing);
  const listRef = useRef<HTMLOListElement>(null);
  const { rows, visibleRows, exec } = model;
  const keys = useMemo(() => visibleRows.map((r) => r.key), [visibleRows]);
  const v = useVirtualRows(listRef, keys, 50);
  const current = lastRowAtOrBefore(visibleRows, playheadSeq);
  const selectedAgentId = useStudio((s) => s.selectedAgentId);
  const rowOfSeq = useMemo(() => rowIndexBySeq(rows), [rows]);
  const { index: selected, hiddenSeq: hiddenBySeq } = selectedRow(rows, rowOfSeq, visibleRows, selectedSeq, selectedAgentId);
  // One Tab stop for the whole list: the focused row, else the selected one, else the row at the playhead.
  const roving = useRovingRow(selected >= 0 ? selected : Math.max(0, current));
  const tabStop = Math.min(roving.tabStop, visibleRows.length - 1);

  useEffect(() => {
    if (selected >= 0) v.scrollToIndex(selected);
  }, [selected]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || current < 0) return;
    if (follow) {
      v.scrollToIndex(current);
      return;
    }
    // A seek while paused: show the row if it is off-screen; a click on a visible row does not scroll.
    const row = list.querySelector<HTMLElement>('[data-current="true"]');
    if (!row) {
      v.scrollToIndex(current, 'center');
      return;
    }
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) v.scrollToIndex(current, 'center');
  }, [current, follow]);

  const onRow = (row: TimelineRow) => store.getState().selectEvent(row.endSeq ?? row.seq, { seek: true });

  if (rows.length === 0) {
    if (conn === 'loading') return <SkeletonRows rows={7} label="Loading the timeline" />;
    return (
      <EmptyState compact icon="clock" title={ended ? 'This run recorded no events' : 'Waiting for the first event'}>
        {ended ? <p>Nothing to replay here.</p> : <p>Events appear here the moment the runtime records them.</p>}
      </EmptyState>
    );
  }
  if (visibleRows.length === 0) {
    return (
      <EmptyState
        compact
        icon="filter"
        title="No events match these filters"
        actions={
          <Button size="sm" onClick={() => store.getState().setFilter(EMPTY_FILTER)}>
            Clear {activeFilterCount(filter) > 1 ? 'all filters' : 'the filter'}
          </Button>
        }
      >
        <p>{rows.length} events are hidden by the current search and filters.</p>
      </EmptyState>
    );
  }

  return (
    <>
      {hiddenBySeq !== null && (
        <p className={styles.hidden} role="status">
          <Icon name="filter" size={12} />
          Selected event #{hiddenBySeq} is hidden by the filters.
          <Button size="sm" variant="ghost" onClick={() => store.getState().setFilter(EMPTY_FILTER)}>
            Show it
          </Button>
        </p>
      )}
    <ol className={styles.list} ref={listRef} aria-label="Timeline" onKeyDown={listKeyHandler(visibleRows.length, v)} onBlur={roving.onBlurList}>
      {v.padTop > 0 && <li className={styles.spacer} style={{ height: v.padTop }} aria-hidden="true" />}
      {visibleRows.slice(v.start, v.end).map((row, k) => {
        const i = v.start + k;
        const status = rowStatusAt(row, playheadSeq);
        const look = agentLook(exec, world, row.actorId);
        const future = row.seq > playheadSeq;
        const icon = row.callId !== null ? (STATUS_ICON[status] ?? row.icon) : row.icon;
        const isSelected = i === selected;
        const finished = status !== 'running';
        const tabIndex = i === tabStop ? 0 : -1;
        return (
          <li
            key={row.key}
            ref={v.measure(i)}
            data-index={i}
            aria-setsize={visibleRows.length}
            aria-posinset={i + 1}
            className={styles.item}
            data-future={future || undefined}
            data-playhead={(future && i === current + 1) || undefined}
            data-current={i === current || undefined}
            data-selected={isSelected || undefined}
            data-status={status}
          >
            <button
              type="button"
              data-row
              tabIndex={tabIndex}
              className={styles.row}
              onFocus={() => roving.onFocusRow(i)}
              onClick={() => onRow(row)}
              aria-current={isSelected ? 'true' : undefined}
              aria-label={`${formatClock(row.tMs)} ${look.name}: ${row.title}${status !== 'info' ? `, ${STATUS_LABEL[status]}` : ''}${future ? ', after the playhead' : ''}`}
            >
              <span className={styles.time}>{formatClock(row.tMs)}</span>
              <span className={styles.icon} data-tone={STATUS_TONE[status]} aria-hidden="true">
                <GlyphIcon glyph={icon} size={13} />
              </span>
              <span className={styles.body}>
                <span className={styles.title}>
                  {row.tool ? (
                    <>
                      <code className={styles.tool}>{row.tool}</code> {row.title.slice(row.tool.length).trim()}
                    </>
                  ) : (
                    row.title
                  )}
                </span>
                <span className={styles.meta}>
                  <span className={styles.actor}>
                    <AgentDot color={look.color} size={7} />
                    {look.name}
                  </span>
                  {row.category && (
                    <span className={styles.category}>
                      <Icon name={CATEGORY_ICON[row.category as keyof typeof CATEGORY_ICON] ?? 'dot'} size={11} />
                      {categoryLabel(row.category)}
                    </span>
                  )}
                  {row.detail && (finished || row.callId === null) && <span className={styles.detail}>{row.detail}</span>}
                </span>
              </span>
              <span className={styles.facts}>
                {status === 'error' && <Chip tone="err" icon="x">error</Chip>}
                {status === 'running' && <Chip tone="live" icon="pulse">running</Chip>}
                {row.inferredSeq !== null && row.inferredSeq <= playheadSeq && (
                  <Chip tone="warn" icon="inferred" title="Reconstructed by Runloop, not reported by the source">
                    inferred
                  </Chip>
                )}
                {row.metrics && finished && (
                  <Chip tone={row.metrics.failed > 0 ? 'err' : 'ok'}>
                    {row.metrics.passed}/{row.metrics.tests} passed
                  </Chip>
                )}
                {row.durationMs !== null && finished && <span className={styles.duration}>{formatDuration(row.durationMs)}</span>}
              </span>
            </button>
            {row.delegateId && (
              <span className={styles.artifacts}>
                <button
                  type="button"
                  tabIndex={tabIndex}
                  className={styles.delegate}
                  onClick={() => store.getState().selectAgent(row.delegateId)}
                  aria-label={`Select subagent ${agentLook(exec, world, row.delegateId).name}`}
                >
                  <Icon name="arrowRight" size={11} />
                  <AgentDot color={agentLook(exec, world, row.delegateId).color} size={7} />
                  {agentLook(exec, world, row.delegateId).name}
                </button>
              </span>
            )}
            {row.artifactIds.length > 0 && (row.endSeq === null || row.endSeq <= playheadSeq) && (
              <span className={styles.artifacts}>
                {row.artifactIds.map((id) => (
                  <button key={id} type="button" tabIndex={tabIndex} className={styles.artifact} onClick={() => store.getState().openArtifact(id)}>
                    <Icon name="file" size={12} />
                    {exec.artifacts[id]?.name ?? id}
                  </button>
                ))}
              </span>
            )}
          </li>
        );
      })}
      {v.padBottom > 0 && <li className={styles.spacer} style={{ height: v.padBottom }} aria-hidden="true" />}
    </ol>
    </>
  );
}
