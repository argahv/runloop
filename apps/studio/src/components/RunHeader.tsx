'use client';
import { useMemo, useState } from 'react';
import { stopRun } from '../lib/api';
import { useStudio, useStudioStore } from '../state/context';
import { ROUTES } from '../state/deeplink';
import { formatWhen, runNumber } from '../state/format';
import { selectRun, useTicker } from '../state/hooks';
import { runProvenance } from '../state/provenance';
import { activityText, isTracedRun, runSubtitle } from '../state/runs';
import { runStatusView } from '../state/view';
import { isPinned } from '../state/baselines';
import { Button, ButtonLink } from '../ui/Button';
import { Chip, StatusBadge } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { GlyphIcon, Icon } from '../ui/Icon';
import { Popover } from '../ui/Popover';
import { toast } from '../ui/Toast';
import { CompareWithBaseline, PinButton } from './Baseline';
import OpenInWorld from './overlays/OpenInWorld';
import styles from './RunHeader.module.css';

/**
 * Run title, status, provenance and the run's actions; `page` decides the
 * cross-link. `variant="sheet"` is the compact header of the in-world trace
 * sheet: an h2 (the town owns the page's h1), no cross-link (the sheet has
 * its own World tab and "Full page" link).
 */
export default function RunHeader({ page, variant = 'page' }: { page: 'world' | 'traces'; variant?: 'page' | 'sheet' }) {
  const store = useStudioStore();
  const run = useStudio((s) => s.run);
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const activeRunId = useStudio((s) => s.runtime.activeRunId);
  const warnings = useStudio((s) => s.warnings);
  const gap = useStudio((s) => s.gap);
  const lastSequence = useStudio((s) => s.lastSequence);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  const n = runNumber(runs, runId);
  const prov = runProvenance(run, exec);
  const traced = isTracedRun(run) || prov.kind === 'traced';
  const canStop = run !== null && run.status === 'running' && activeRunId === run.runId;
  const live = run?.status === 'running';
  useTicker(live && traced, 15_000);
  const subtitle = run ? runSubtitle(run) : null;
  const activity = run && live && traced ? activityText(run, Date.now()) : null;

  const onStop = async () => {
    if (!run) return;
    setStopping(true);
    try {
      await stopRun(run.runId);
      toast({ tone: 'ok', title: 'Run stopped', description: 'Everything recorded so far is kept and can be replayed.' });
    } catch (err) {
      toast({ tone: 'err', title: 'Could not stop the run', description: `${err instanceof Error ? err.message : String(err)}. The run keeps going; try again.` });
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  };

  const sheet = variant === 'sheet';
  const Heading = sheet ? 'h2' : 'h1';

  return (
    <header className={styles.header} data-variant={variant}>
      <div className={styles.title}>
        <span className={styles.number}>{n !== null ? `#${n}` : '#'}</span>
        <div className={styles.titleText}>
          <Heading className={styles.h1} title={run?.title}>
            {run?.title ?? 'Loading run…'}
          </Heading>
          {(subtitle || activity) && (
            <p className={styles.subtitle}>
              {subtitle}
              {activity && <span className={styles.activity}> · {activity}</span>}
            </p>
          )}
        </div>
        {run && <StatusBadge view={runStatusView(run.status, run.paused, traced)} />}
        {run && (
          <Chip tone={prov.tone} icon={prov.icon} title={prov.detail}>
            {prov.label}
          </Chip>
        )}
        {gap && (
          <Chip tone="warn" icon="ellipsis" title="Waiting for missing events; they are fetched again automatically">
            waiting for #{gap.from}
            {gap.to > gap.from ? `–${gap.to}` : ''}
          </Chip>
        )}
        {warnings.length > 0 && (
          <Chip tone="warn" icon="alert" title={warnings.join('\n')}>
            {warnings.length} warning{warnings.length > 1 ? 's' : ''}
          </Chip>
        )}
      </div>
      <div className={styles.actions}>
        {run && <PinButton run={run} />}
        {run && <CompareWithBaseline run={run} />}
        {runs.length > 1 && (
          <Popover label="Switch run" icon="traces" align="end">
            <ul className={styles.runList} aria-label="Runs">
              {runs.slice(0, 20).map((r, i) => {
                const rTraced = isTracedRun(r);
                const view = runStatusView(r.status, r.paused, rTraced);
                const sub = runSubtitle(r);
                return (
                  <li key={r.runId}>
                    <button type="button" className={styles.runItem} aria-current={r.runId === runId ? 'true' : undefined} onClick={() => selectRun(store, r.runId)}>
                      <span className={styles.runIcon} data-tone={view.tone} title={view.text}>
                        <GlyphIcon glyph={view.icon} size={12} />
                        <span className="sr-only">{view.text}</span>
                      </span>
                      <span className={styles.runName}>
                        #{runs.length - i} · {r.title}
                        {isPinned(r) && <span className="sr-only"> (baseline)</span>}
                        {sub && <span className={styles.runSub}>{sub}</span>}
                      </span>
                      <span className={styles.runWhen}>
                        {isPinned(r) && <Icon name="pin" size={11} label="Baseline" />}
                        <Icon name={rTraced ? 'eye' : 'terminal'} size={11} label={rTraced ? 'Traced · Claude Code' : 'Executed'} />
                        {formatWhen(r.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover>
        )}
        {sheet ? null : page === 'world' ? (
          <ButtonLink href={ROUTES.traces} size="sm" icon="traces">
            Investigate in Traces
          </ButtonLink>
        ) : (
          <ButtonLink href={ROUTES.world} size="sm" icon="world">
            Open Live World
          </ButtonLink>
        )}
        {!sheet && <OpenInWorld compact />}
        {canStop && (
          <Button size="sm" variant="danger" icon="stop" onClick={() => setConfirmStop(true)}>
            Stop run
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmStop}
        title="Stop this run?"
        confirmLabel="Stop run"
        busy={stopping}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => void onStop()}
        impact={
          <>
            <p>The demo mission stops at its next step and ends as “stopped”. A stopped run cannot be resumed.</p>
            <p>Every event recorded so far is kept and can still be replayed.</p>
          </>
        }
      />
    </header>
  );
}
