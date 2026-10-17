'use client';
import { selectEmbodiedAgents } from '@runloop-world/core';
import { useMemo, type CSSProperties } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { agentLook, characterStatusView } from '../state/view';
import styles from './WorldView.module.css';
import StatusBadge from './StatusBadge';

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
        const c = state.world.characters[a.id];
        const view = characterStatusView(state.world.paused ? 'paused' : (c?.activity ?? 'idle'));
        const isSelected = selected === a.id;
        return (
          <button
            key={a.id}
            type="button"
            className={styles.character}
            aria-pressed={isSelected}
            onClick={() => store.getState().selectAgent(isSelected ? null : a.id)}
            style={{ '--role': agentLook(state.exec, world, a.id).color } as CSSProperties}
          >
            <span className="dot" aria-hidden="true" />
            <span className={styles.characterName}>{a.name}</span>
            <StatusBadge view={view} />
          </button>
        );
      })}
    </div>
  );
}
