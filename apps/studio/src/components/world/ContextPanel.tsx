'use client';
import type { EntityRef } from '@runloop-world/events';
import { useWorld, useWorldStore } from '../../world/context';
import { entityName } from '../../world/entityIndex';
import { MODE_LABEL } from '../../world/link';
import { focusOf } from '../../world/store';
import { Button } from '../../ui/Button';
import AgentsPanel from '../agents/AgentsPanel';
import AgentPanel from '../panels/AgentPanel';
import BuildingPanel from '../panels/BuildingPanel';
import PlacePanel from '../panels/PlacePanel';
import ResidentPanel from '../panels/ResidentPanel';
import styles from './WorldHome.module.css';
import WorldLog from './WorldLog';

const KIND_LABEL: Record<EntityRef['kind'], string> = {
  resident: 'Resident',
  building: 'Building',
  agent: 'Agent',
  district: 'District',
  lot: 'Lot',
  spot: 'Place',
};

/** The panel for one entity. A housed agent's building opens its agent panel. */
export function EntityPanel({ refId }: { refId: EntityRef }) {
  const agentOfBuilding = useWorld((s) => (refId.kind === 'building' ? (s.snapshot?.agents.find((a) => a.buildingId === refId.id)?.agentId ?? null) : null));
  switch (refId.kind) {
    case 'resident':
      return <ResidentPanel key={refId.id} id={refId.id} />;
    case 'agent':
      return <AgentPanel key={refId.id} id={refId.id} />;
    case 'building':
      return agentOfBuilding ? <AgentPanel key={agentOfBuilding} id={agentOfBuilding} /> : <BuildingPanel key={refId.id} id={refId.id} />;
    default:
      return <PlacePanel key={`${refId.kind}:${refId.id}`} refId={refId} />;
  }
}

/** Whether the context panel has something to show. */
export function useContextPanelOpen(): boolean {
  return useWorld((s) => s.panelStack.length > 0 || s.mode === 'agents' || s.mode === 'intelligence');
}

/**
 * The right-hand context (plan §5, UX §1): a stack of entity panels with
 * Back, over the current mode's own panel (Agents, the World Log). Opaque:
 * glass is only for controls floating over the town.
 */
export default function ContextPanel({ onAddToWorld }: { onAddToWorld: (fromSessionId?: string) => void }) {
  const store = useWorldStore();
  const stack = useWorld((s) => s.panelStack);
  const mode = useWorld((s) => s.mode);
  const top = useWorld((s) => focusOf(s));
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const prev = stack.length > 1 ? stack[stack.length - 2]! : null;
  const modePanel = mode === 'agents' || mode === 'intelligence';

  return (
    <div className={styles.context}>
      <div className={styles.contextHead}>
        {top && (prev || modePanel) ? (
          <Button size="sm" variant="ghost" icon="arrowRight" className={styles.backBtn} onClick={() => store.getState().back()} aria-label={prev ? `Back to ${entityName(prev, snapshot, town)}` : `Back to ${MODE_LABEL[mode]}`}>
            {prev ? entityName(prev, snapshot, town) : MODE_LABEL[mode]}
          </Button>
        ) : (
          <span className={styles.contextKind}>{top ? KIND_LABEL[top.kind] : MODE_LABEL[mode]}</span>
        )}
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="x"
          aria-label="Close the panel"
          title="Close (Esc)"
          onClick={() => {
            if (top) store.getState().closePanels();
            else store.getState().setMode('explore');
          }}
        />
      </div>
      <div className={styles.contextBody}>
        {top ? <EntityPanel refId={top} /> : mode === 'agents' ? <AgentsPanel onAddToWorld={onAddToWorld} /> : mode === 'intelligence' ? <WorldLog /> : null}
      </div>
    </div>
  );
}
