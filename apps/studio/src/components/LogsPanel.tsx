'use client';
import { formatClock } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent } from '@runloop-world/events';
import { useMemo, useState } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import styles from './LogsPanel.module.css';

const ALL = '*';
const INVALID = '!invalid';

/** Artifact ids an event points at (artifact.created and tool results). */
function artifactIdsOf(e: AnyEvent): string[] {
  if (isUnknownEvent(e)) return [];
  if (e.type === 'artifact.created') return [e.payload.artifactId];
  if (e.type === 'tool.call_completed') return e.payload.outputArtifactIds ?? [];
  if (e.type === 'task.completed') return e.payload.artifactIds;
  return [];
}

export default function LogsPanel() {
  const store = useStudioStore();
  const lastSequence = useStudio((s) => s.lastSequence);
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const raw = useStudio((s) => s.raw);
  const [filter, setFilter] = useState(ALL);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const events = useMemo(() => [...store.getState().events()], [store, lastSequence]);
  const byId = useMemo(() => new Map(events.map((e) => [e.eventId, e])), [events]);
  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);

  const shown = filter === ALL ? events : filter === INVALID ? [] : events.filter((e) => e.type === filter);
  const showRaw = filter === ALL || filter === INVALID;

  const toggle = (seq: number, force?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (force ?? !next.has(seq)) next.add(seq);
      else next.delete(seq);
      return next;
    });

  const jumpTo = (e: AnyEvent) => {
    setFilter(ALL);
    toggle(e.sequence, true);
    requestAnimationFrame(() => document.getElementById(`log-${e.sequence}`)?.scrollIntoView({ block: 'center' }));
  };

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

  return (
    <div className={styles.logs}>
      <div className={styles.toolbar}>
        <label className={styles.filter}>
          <span>Type</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value={ALL}>All events ({events.length + raw.length})</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            {raw.length > 0 && <option value={INVALID}>Invalid ({raw.length})</option>}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => void copyJsonl()} disabled={events.length + raw.length === 0}>
          {copyState === 'copied' ? '✓ Copied' : copyState === 'failed' ? '✗ Copy failed' : 'Copy JSONL'}
        </button>
      </div>

      <ol className={styles.list} aria-label="Event log">
        {shown.map((e) => {
          const unknown = isUnknownEvent(e);
          const parents: AnyEvent[] = [];
          for (let p = e.parentEventId ? byId.get(e.parentEventId) : undefined; p && parents.length < 10; ) {
            parents.push(p);
            p = p.parentEventId ? byId.get(p.parentEventId) : undefined;
          }
          const artifacts = artifactIdsOf(e);
          const isOpen = open.has(e.sequence);
          return (
            <li key={e.eventId} id={`log-${e.sequence}`} className={styles.entry} data-future={e.sequence > playheadSeq || undefined}>
              <button type="button" className={styles.summary} aria-expanded={isOpen} onClick={() => toggle(e.sequence)}>
                <span className={styles.caret} aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                <span className={styles.seq}>#{e.sequence}</span>
                <span className={styles.clock}>{formatClock(store.getState().timeOfSeq(e.sequence))}</span>
                <span className={styles.type}>{e.type}</span>
                <span className={styles.meta}>
                  {e.actorId ?? '—'}
                  {e.taskId ? ` · ${e.taskId}` : ''}
                </span>
                {e.visibility !== 'public' && (
                  <span className="badge" data-tone="warn">
                    ⚿ {e.visibility}
                  </span>
                )}
                {unknown && (
                  <span className="badge" data-tone="warn">
                    ⚠ {e.reason.replace('_', ' ')}
                  </span>
                )}
              </button>
              {isOpen && (
                <div className={styles.body}>
                  {parents.length > 0 && (
                    <p className={styles.chain}>
                      <span>Caused by</span>
                      {parents.map((p) => (
                        <button key={p.eventId} type="button" className="link" onClick={() => jumpTo(p)}>
                          #{p.sequence} {p.type}
                        </button>
                      ))}
                    </p>
                  )}
                  {artifacts.length > 0 && (
                    <p className={styles.chain}>
                      <span>Artifacts</span>
                      {artifacts.map((id) => (
                        <button key={id} type="button" className="link" onClick={() => store.getState().openArtifact(id)}>
                          📄 {exec.artifacts[id]?.name ?? id}
                        </button>
                      ))}
                    </p>
                  )}
                  {unknown && e.error && <p className={styles.error}>{e.error}</p>}
                  <div className={styles.actions}>
                    <button type="button" className="btn btn-ghost" onClick={() => store.getState().seekToSeq(e.sequence)}>
                      Move playhead here
                    </button>
                  </div>
                  <pre className={styles.json}>{JSON.stringify(store.getState().rawEvent(e.sequence) ?? e, null, 2)}</pre>
                </div>
              )}
            </li>
          );
        })}
        {showRaw &&
          raw.map((r) => (
            <li key={`raw-${r.id}`} className={styles.entry} data-invalid="true">
              <details>
                <summary className={styles.summary}>
                  <span className={styles.seq}>{r.sequence !== null ? `#${r.sequence}` : '#?'}</span>
                  <span className="badge" data-tone="err">
                    ✗ invalid event
                  </span>
                  <span className={styles.meta}>{r.error}</span>
                </summary>
                <div className={styles.body}>
                  <p className={styles.error}>{r.error}</p>
                  <pre className={styles.json}>{typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw, null, 2)}</pre>
                </div>
              </details>
            </li>
          ))}
      </ol>
    </div>
  );
}
