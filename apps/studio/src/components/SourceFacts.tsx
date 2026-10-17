'use client';
import type { ExecState } from '@runloop-world/core';
import type { RunSummary, TraceSource } from '@runloop-world/events';
import type { ReactNode } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { selectRun } from '../state/hooks';
import { runNumber } from '../state/format';
import { shortId } from '../state/runs';
import styles from './SourceFacts.module.css';

const SOURCE_NAME: Record<string, string> = { 'claude-code': 'Claude Code' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children ?? <span className={styles.none}>not reported</span>}</dd>
    </div>
  );
}

/** The traced run's source, from its run.started (full) or the run summary (partial). */
export function traceSourceOf(run: RunSummary | null, exec: ExecState): Partial<TraceSource> | null {
  return exec.run.source ?? run?.source ?? null;
}

/**
 * Where a traced run came from (plan §7.3): session (short id), segment,
 * project, model if reported, permission mode and plugin version. Values the
 * source did not report say so.
 */
export default function SourceFacts({ run, exec }: { run: RunSummary | null; exec: ExecState }) {
  const store = useStudioStore();
  const runs = useStudio((s) => s.runs);
  const src = traceSourceOf(run, exec);
  if (!src) return null;
  const continues = src.continuesRunId ?? null;
  const prevN = continues ? runNumber(runs, continues) : null;

  return (
    <dl className={styles.dl}>
      <Row label="Source">{src.kind ? (SOURCE_NAME[src.kind] ?? src.kind) : null}</Row>
      <Row label="Project">{src.projectLabel ? <code>{src.projectLabel}</code> : null}</Row>
      <Row label="Session">
        {src.sessionId ? (
          <code title={src.sessionId} className={styles.mono}>
            {shortId(src.sessionId)}
          </code>
        ) : null}
      </Row>
      <Row label="Segment">
        {src.segment !== undefined ? (
          <span>
            {src.segment}
            {continues &&
              (prevN !== null ? (
                <>
                  {' · continues '}
                  <button type="button" className={styles.link} onClick={() => selectRun(store, continues)}>
                    run #{prevN}
                  </button>
                </>
              ) : (
                ' · continues an earlier run'
              ))}
          </span>
        ) : null}
      </Row>
      <Row label="Model">{src.model ? <code>{src.model}</code> : null}</Row>
      <Row label="Permission mode">{src.permissionMode ? <code>{src.permissionMode}</code> : null}</Row>
      <Row label="Session start">{src.startSource ?? null}</Row>
      <Row label="Plugin version">{src.pluginVersion ? <code>{src.pluginVersion}</code> : null}</Row>
    </dl>
  );
}
