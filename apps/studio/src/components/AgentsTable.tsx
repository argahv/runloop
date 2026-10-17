'use client';
import { formatClock } from '@runloop-world/core';
import { useMemo } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { describeEvent, formatInt, usageSourceText, usageText, usageTotal } from '../state/labels';
import { latestEventOf } from '../state/selection';
import { agentLook, KIND_LABEL, runHasEnded, taskStatusView } from '../state/view';
import { AgentDot, StatusBadge } from '../ui/Chip';
import { runtimeStatusView } from '../views/graph/model';
import { EmptyState } from '../ui/States';
import CharacterStatus from './CharacterStatus';
import styles from './AgentsTable.module.css';

/**
 * The 2D route to everything the world shows: every agent, what it is doing at
 * the playhead, where, and its latest event. Selecting a row selects the agent
 * everywhere. (The agent graph view will join this slot in the next phase.)
 */
export default function AgentsTable() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const world = useStudio((s) => s.world);
  const selected = useStudio((s) => s.selectedAgentId);
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const latest = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
  const { exec } = state;
  const s = store.getState();
  const ended = runHasEnded(exec);

  if (exec.agentOrder.length === 0) {
    return (
      <EmptyState compact icon="agent" title="No agents yet">
        <p>Agents appear as soon as they register in the run.</p>
      </EmptyState>
    );
  }

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="sr-only">Agents at the playhead (event #{seq})</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">State</th>
            <th scope="col">Task</th>
            <th scope="col">Where</th>
            <th scope="col">Tokens</th>
            <th scope="col">Latest event</th>
          </tr>
        </thead>
        <tbody>
          {exec.agentOrder.map((id) => {
            const a = exec.agents[id]!;
            const look = agentLook(exec, world, id);
            const task = a.currentTaskId ? exec.tasks[a.currentTaskId] : undefined;
            const character = state.world.characters[id];
            const station = character?.stationId && world ? world.stationsById[character.stationId] : undefined;
            const last = latestEventOf(s.events(), latest, id, seq);
            const lastEvent = last !== null ? s.events()[last - 1] : undefined;
            return (
              <tr key={id} data-selected={selected === id || undefined}>
                <th scope="row">
                  <button type="button" className={styles.agent} onClick={() => s.selectAgent(selected === id ? null : id)} aria-pressed={selected === id}>
                    <AgentDot color={look.color} />
                    <span className={styles.name}>{a.name}</span>
                    <span className={styles.role}>{a.role}</span>
                  </button>
                </th>
                <td>{a.embodied ? <CharacterStatus agentId={id} /> : <StatusBadge view={runtimeStatusView(a.state, ended)} />}</td>
                <td className={styles.task} data-empty={task ? undefined : true}>
                  {task ? `${KIND_LABEL[task.kind] ?? task.kind} · ${task.title}${ended ? ` · ${taskStatusView(task.status, true).text}` : ''}` : <span className={styles.muted}>—</span>}
                </td>
                <td>{station ? station.label : <span className={styles.muted}>{a.embodied ? 'home' : 'not in the world'}</span>}</td>
                <td className={styles.tokens}>
                  {a.usage ? (
                    <span title={`${formatInt(usageTotal(a.usage))} tokens, ${usageSourceText(a.usage.source)}`}>{usageText(a.usage)}</span>
                  ) : a.role === 'user' ? (
                    <span className={styles.muted}>—</span>
                  ) : (
                    <span className={styles.none}>not reported</span>
                  )}
                </td>
                <td className={styles.event}>
                  {lastEvent ? (
                    <button type="button" className={styles.eventLink} onClick={() => s.selectEvent(lastEvent.sequence)}>
                      <span className={styles.clock}>{formatClock(s.timeOfSeq(lastEvent.sequence))}</span>
                      {describeEvent(lastEvent, latest).label}
                    </button>
                  ) : (
                    <span className={styles.muted}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
