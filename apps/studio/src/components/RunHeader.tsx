'use client';
import { useRef, type KeyboardEvent } from 'react';
import { useStudio } from '../state/context';
import type { ConnStatus, Tab } from '../state/store';
import { runStatusView, type StatusView } from '../state/view';
import styles from './RunHeader.module.css';
import StatusBadge from './StatusBadge';

const TABS: { id: Tab; label: string }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'logs', label: 'Logs' },
  { id: 'state', label: 'State' },
  { id: 'metadata', label: 'Metadata' },
];

const CONN: Record<ConnStatus, StatusView | null> = {
  idle: null,
  loading: { icon: '…', text: 'loading', tone: 'muted' },
  streaming: { icon: '●', text: 'streaming', tone: 'live' },
  reconnecting: { icon: '↻', text: 'reconnecting', tone: 'warn' },
  complete: null,
  error: { icon: '✗', text: 'disconnected', tone: 'err' },
};

export default function RunHeader() {
  const run = useStudio((s) => s.run);
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const tab = useStudio((s) => s.tab);
  const setTab = useStudio((s) => s.setTab);
  const conn = useStudio((s) => s.conn);
  const loadError = useStudio((s) => s.loadError);
  const warnings = useStudio((s) => s.warnings);
  const gap = useStudio((s) => s.gap);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const index = runs.findIndex((r) => r.runId === runId);
  const number = index >= 0 ? runs.length - index : null;
  const connView = CONN[conn];

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + TABS.length) % TABS.length;
    setTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <header className={styles.header}>
      <div className={styles.title}>
        {run ? (
          <>
            <span className={styles.no}>Run {number !== null ? `#${number}` : ''}</span>
            <StatusBadge view={runStatusView(run.status, run.paused)} />
            <h1 className={styles.h1} title={run.title}>
              {run.title}
            </h1>
          </>
        ) : (
          <h1 className={styles.h1}>{!runId ? 'No run selected' : loadError ? 'Run unavailable' : 'Loading run…'}</h1>
        )}
        <span className={styles.flags}>
          {connView && <StatusBadge view={connView} />}
          {gap && <StatusBadge view={{ icon: '⋯', text: `waiting for #${gap.from}${gap.to > gap.from ? `–${gap.to}` : ''}`, tone: 'warn' }} />}
          {warnings.length > 0 && (
            <span title={warnings.join('\n')}>
              <StatusBadge view={{ icon: '⚠', text: `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`, tone: 'warn' }} />
            </span>
          )}
        </span>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Run views" onKeyDown={onTabKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="studio-tabpanel"
            tabIndex={tab === t.id ? 0 : -1}
            className={styles.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </header>
  );
}
