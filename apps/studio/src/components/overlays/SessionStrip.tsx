'use client';
/**
 * Inside an agent's building (contract §1.1 S, §4.1): the session strip.
 * Pick one of the agent's sessions, play or scrub it with the replay bar
 * (scrubbing moves the diorama inside the building to the recorded state at
 * the playhead; nothing is re-executed; Go live returns), open its trace or
 * compare it with its baseline, or leave.
 */
import { useEffect } from 'react';
import { baselineFor } from '../../state/baselines';
import { useStudio, useStudioStore } from '../../state/context';
import { selectRun, useTicker } from '../../state/hooks';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { useWorld } from '../../world/context';
import ReplayBar from '../ReplayBar';
import { useStudioNav } from './nav';
import { sessionStateLabel, stripMode } from './stripMode';
import styles from './overlays.module.css';

export function SessionStrip({ agentId, onOpenTrace, onLeave }: { agentId: string; onOpenTrace: (seq: number | null) => void; onLeave: () => void }) {
  const studio = useStudioStore();
  const nav = useStudioNav();
  const summary = useWorld((s) => s.agents.find((a) => a.agentId === agentId) ?? null);
  const name = useWorld((s) => s.snapshot?.agents.find((a) => a.agentId === agentId)?.displayName ?? summary?.displayName ?? 'Agent');
  const runId = useStudio((s) => s.runId);
  const runs = useStudio((s) => s.runs);
  const selectedSeq = useStudio((s) => s.selectedSeq);
  const following = useStudio((s) => s.cursor.mode === 'live');
  const health = useWorld((s) => s.snapshot?.agents.find((a) => a.agentId === agentId)?.health ?? summary?.health ?? null);
  const sessions = summary?.sessions ?? [];
  const current = sessions.find((s) => s.runId === runId) ?? null;
  const base = current ? baselineFor(runs, current.runId) : null;

  // The diorama inside is this session's world: mounted while the strip shows it, so a finished run settles there.
  const currentRun = current?.runId ?? null;
  useEffect(() => (currentRun ? studio.getState().mountWorld() : undefined), [currentRun, studio]);

  const recording = current?.status === 'running';
  useTicker(recording && health === 'idle', 15_000);
  // The run's state, with the agent's own health: a quiet open session is "Open · idle 12m", never "Live".
  const mode = current ? stripMode({ following, open: recording, health, lastEventAt: summary?.lastEventAt ?? null, nowMs: Date.now() }) : null;

  return (
    <section className={styles.strip} aria-label={`Inside ${name}: its sessions`} data-keys="own">
      <div className={styles.stripHead}>
        <label className={styles.stripPick}>
          <span className="sr-only">Session</span>
          <select
            value={current?.runId ?? ''}
            onChange={(e) => e.target.value && selectRun(studio, e.target.value)}
            aria-label={`${name}: session shown inside`}
            disabled={sessions.length === 0}
          >
            {sessions.length === 0 && <option value="">No session yet</option>}
            {!current && sessions.length > 0 && <option value="">Choose a session…</option>}
            {sessions.map((s, i) => {
              const title = runs.find((r) => r.runId === s.runId)?.title;
              return (
                <option key={s.runId} value={s.runId}>
                  Session #{sessions.length - i}
                  {title ? ` · ${title}` : ''} · {sessionStateLabel(s.status)}
                </option>
              );
            })}
          </select>
        </label>
        {mode && (
          <span className={styles.stripMode} data-live={mode.live || undefined}>
            <Icon name={mode.icon} size={12} />
            {mode.text}
          </span>
        )}
        <span className={styles.stripActions}>
          <Button size="sm" variant="ghost" icon="traces" disabled={!current} onClick={() => onOpenTrace(selectedSeq)} title="Open this session's trace beside the town">
            Trace
          </Button>
          {current && base && base.runId !== current.runId && (
            <Button size="sm" variant="ghost" icon="compare" onClick={() => nav.openCompare({ a: base.runId, b: current.runId })} title={`Compare with the baseline “${base.title}”`}>
              Compare
            </Button>
          )}
          <Button size="sm" variant="secondary" icon="arrowUp" onClick={onLeave} aria-keyshortcuts="Escape">
            Leave
          </Button>
        </span>
      </div>
      {current ? (
        <ReplayBar glass followLabel={health === 'live' ? null : 'Latest'} />
      ) : (
        <p className={styles.stripNote}>{sessions.length ? 'Choose a session to watch it here.' : 'This agent has no session yet: start Claude Code in its folder.'}</p>
      )}
    </section>
  );
}

export default SessionStrip;
