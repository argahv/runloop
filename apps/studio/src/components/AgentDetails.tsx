'use client';
import { selectRecentActions, selectTaskProgress, type ExecState } from '@runloop-world/core';
import { useMemo, type CSSProperties } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { formatDuration } from '../state/timeline';
import { agentLook, callStatusView, characterStatusView, KIND_LABEL, taskStatusView } from '../state/view';
import styles from './AgentDetails.module.css';
import StatusBadge from './StatusBadge';

/** Details of the selected agent at the playhead (or a task overview when none is selected). */
export default function AgentDetails() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const selected = useStudio((s) => s.selectedAgentId);
  const world = useStudio((s) => s.world);
  const run = useStudio((s) => s.run);
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const { exec } = state;
  const agent = selected ? exec.agents[selected] : undefined;

  if (!selected) return <TaskOverview exec={exec} />;
  if (!agent) {
    return (
      <div className={styles.details}>
        <p className={styles.muted}>This agent has not registered yet at the playhead.</p>
      </div>
    );
  }

  const look = agentLook(exec, world, agent.id);
  const character = state.world.characters[agent.id];
  const station = character?.stationId && world ? world.stationsById[character.stationId] : undefined;
  const task = agent.currentTaskId ? exec.tasks[agent.currentTaskId] : undefined;
  const progress = task ? selectTaskProgress(exec, task.id) : null;
  const actions = selectRecentActions(exec, agent.id, 5);
  const artifacts = exec.artifactOrder
    .map((id) => exec.artifacts[id]!)
    .filter((a) => a.agentId === agent.id)
    .reverse();
  const s = store.getState();

  return (
    <div className={styles.details} style={{ '--role': look.color } as CSSProperties}>
      <header className={styles.header}>
        <span className={styles.avatar} aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <div className={styles.who}>
          <h2 className={styles.name}>{agent.name}</h2>
          <span className={styles.role}>{agent.role}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => s.selectAgent(null)} aria-label="Close agent details">
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <p className={styles.badges}>
        {character && <StatusBadge view={characterStatusView(state.world.paused ? 'paused' : character.activity)} />}
        <span className="chip">state: {agent.state}</span>
        {station && <span className="chip">at {station.label}</span>}
      </p>
      {agent.stateReason && <p className={styles.muted}>{agent.stateReason}</p>}

      <dl className={styles.dl}>
        <dt>Model</dt>
        <dd>{agent.model ?? exec.run.adapter?.label ?? run?.adapterLabel ?? '—'}</dd>
        <dt>Tools</dt>
        <dd className={styles.tools}>
          {agent.tools.length ? agent.tools.map((t) => <code key={t} className="chip">{t}</code>) : '—'}
        </dd>
        <dt>Workspace</dt>
        <dd>{exec.run.workspace ? <code>{exec.run.workspace}</code> : '—'}</dd>
      </dl>

      <section className={styles.section}>
        <h3 className={styles.h3}>Current task</h3>
        {task ? (
          <div className={styles.task}>
            <div className={styles.taskTop}>
              <span className={styles.taskTitle}>{task.title}</span>
              <StatusBadge view={taskStatusView(task.status)} />
            </div>
            <span className={styles.muted}>
              {task.id} · {KIND_LABEL[task.kind]} · attempt {Math.max(1, task.attempts)}
            </span>
            {task.blockedReason && task.status === 'blocked' && <span className={styles.warn}>Blocked: {task.blockedReason}</span>}
            <div
              className={styles.progress}
              role="progressbar"
              aria-label={`${task.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(progress !== null ? { 'aria-valuenow': Math.round(progress * 100) } : {})}
              data-indeterminate={progress === null || undefined}
            >
              <span style={{ width: `${(progress ?? 0) * 100}%` }} />
            </div>
            <span className={styles.muted}>
              {task.plannedSteps !== null
                ? `${Math.min(task.stepsDoneThisAttempt, task.plannedSteps)} of ${task.plannedSteps} planned steps`
                : 'No step plan'}
            </span>
          </div>
        ) : (
          <p className={styles.muted}>No task right now.</p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.h3}>Recent actions</h3>
        {actions.length === 0 ? (
          <p className={styles.muted}>No tool calls yet.</p>
        ) : (
          <ol className={styles.actions}>
            {actions.map((c) => {
              const view = callStatusView(c.status);
              return (
                <li key={c.id}>
                  <button type="button" className={styles.action} onClick={() => s.seekToSeq(c.endedSeq ?? c.startedSeq)}>
                    <span className={styles.actionIcon} data-tone={view.tone} aria-hidden="true">
                      {view.icon}
                    </span>
                    <span className={styles.actionBody}>
                      <span className={styles.actionTitle}>
                        <code>{c.tool}</code> {c.inputSummary}
                      </span>
                      <span className={styles.muted}>
                        <span className="sr-only">{view.text}: </span>
                        {c.status === 'running' ? 'running…' : (c.outputSummary ?? c.message ?? view.text)}
                        {c.durationMs !== null && ` · ${formatDuration(c.durationMs)}`}
                      </span>
                      {c.metrics && (
                        <span className={styles.metrics}>
                          <span className="chip">✓ {c.metrics.passed} passed</span>
                          <span className="chip" data-tone={c.metrics.failed ? 'err' : undefined}>
                            ✗ {c.metrics.failed} failed
                          </span>
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.h3}>Artifacts</h3>
        {artifacts.length === 0 ? (
          <p className={styles.muted}>None yet.</p>
        ) : (
          <ul className={styles.artifacts}>
            {artifacts.map((a) => (
              <li key={a.artifactId}>
                <button type="button" className={styles.artifact} onClick={() => s.openArtifact(a.artifactId)}>
                  <span aria-hidden="true">📄</span>
                  <span className={styles.actionBody}>
                    <span className={styles.actionTitle}>
                      {a.name} <span className="chip">{a.kind}</span>
                    </span>
                    <span className={styles.muted}>{a.summary}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TaskOverview({ exec }: { exec: ExecState }) {
  const store = useStudioStore();
  const open = exec.incidents.filter((i) => i.resolvedSeq === null);
  return (
    <div className={styles.details}>
      <h2 className={styles.overviewTitle}>Tasks</h2>
      <p className={styles.muted}>Select a character in the world or the roster (or press ]) to see its details.</p>
      {exec.taskOrder.length === 0 ? (
        <p className={styles.muted}>No tasks yet.</p>
      ) : (
        <ol className={styles.actions}>
          {exec.taskOrder.map((id) => {
            const t = exec.tasks[id]!;
            return (
              <li key={id}>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => t.ownerId && exec.agents[t.ownerId]?.embodied && store.getState().selectAgent(t.ownerId)}
                >
                  <span className={styles.actionBody}>
                    <span className={styles.taskTop}>
                      <span className={styles.actionTitle}>
                        {t.id} · {t.title}
                      </span>
                      <StatusBadge view={taskStatusView(t.status)} />
                    </span>
                    <span className={styles.muted}>
                      {KIND_LABEL[t.kind]}
                      {t.ownerId ? ` · ${exec.agents[t.ownerId]?.name ?? t.ownerId}` : ''}
                      {t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {open.length > 0 && (
        <>
          <h3 className={styles.h3}>Open incidents</h3>
          <ul className={styles.actions}>
            {open.map((i) => (
              <li key={i.eventId}>
                <button type="button" className={styles.action} onClick={() => store.getState().seekToSeq(i.seq)}>
                  <span className={styles.actionIcon} data-tone="err" aria-hidden="true">
                    ✗
                  </span>
                  <span className={styles.actionBody}>
                    <span className={styles.actionTitle}>{i.kind.replace('_', ' ')}</span>
                    <span className={styles.muted}>{i.message}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
