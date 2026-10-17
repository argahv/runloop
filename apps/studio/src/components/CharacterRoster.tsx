'use client';
import { selectEmbodiedAgents } from '@runloop-world/core';
import { useMemo } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { agentLook } from '../state/view';
import { AgentDot } from '../ui/Chip';
import CharacterStatus from './CharacterStatus';
import styles from './WorldStage.module.css';

/** Keyboard-reachable list of characters over the canvas (mirrors clicking them in 3D). */
export default function CharacterRoster() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const world = useStudio((s) => s.world);
  const selected = useStudio((s) => s.selectedAgentId);
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const agents = selectEmbodiedAgents(state.exec);
  if (agents.length === 0) return null;

  return (
    <div className={styles.roster} role="group" aria-label="Characters">
      {agents.map((a) => {
        const isSelected = selected === a.id;
        return (
          <button
            key={a.id}
            type="button"
            className={styles.character}
            aria-pressed={isSelected}
            onClick={() => store.getState().selectAgent(isSelected ? null : a.id)}
          >
            <AgentDot color={agentLook(state.exec, world, a.id).color} />
            <span className={styles.characterName}>{a.name}</span>
            <CharacterStatus agentId={a.id} />
          </button>
        );
      })}
    </div>
  );
}
