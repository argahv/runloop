'use client';
/**
 * Add to World's last step (contract §4.3): what the new agent is doing now,
 * read from the live world, never from the create answer once that is stale.
 * Until a real hook arrives the building stands unpainted and this says how
 * to connect Claude Code; from the first real event it shows the agent's
 * honest health (icon + text), its attention line and when the first event
 * came. `onArrived` runs once when that first event lands while it is shown.
 */
import type { AgentSummary } from '@runloop-world/events';
import { useEffect, useRef, type ReactNode } from 'react';
import { CC } from '../../lib/claude-code';
import { useTicker } from '../../state/hooks';
import { useWorld } from '../../world/context';
import { clockParts } from '../../world/interpolate';
import { addedAgentView } from '../../world/selectors';
import { CommandSnippet } from '../../ui/CommandSnippet';
import { Icon } from '../../ui/Icon';
import { whenText } from '../world/hud/bits';
import styles from './agents.module.css';

export default function AddedAgentStatus({
  created,
  onArrived,
  more,
  titleClass = styles.flowTitle,
}: {
  created: AgentSummary;
  onArrived?: (agentId: string) => void;
  /** Extra help under the install command while it waits (the dialog links to Connect). */
  more?: ReactNode;
  titleClass?: string | undefined;
}) {
  useWorld((s) => s.rev);
  const presence = useWorld((s) => s.snapshot?.agents.find((a) => a.agentId === created.agentId) ?? null);
  const summary = useWorld((s) => s.agents.find((a) => a.agentId === created.agentId) ?? null);
  const log = useWorld((s) => s.log);
  const today = useWorld((s) => (s.clock ? clockParts(s.clock.tick).day : 0));
  useTicker(true, 1000);
  const v = addedAgentView(created, presence, summary, log, Date.now());

  // The first real event while this step is open: hand over (once) to the agent's own card.
  const waited = useRef(v.waiting);
  const arrived = useRef(onArrived);
  arrived.current = onArrived;
  useEffect(() => {
    if (waited.current && !v.waiting) arrived.current?.(created.agentId);
    waited.current = v.waiting;
  }, [v.waiting, created.agentId]);

  if (v.waiting) {
    return (
      <>
        <p className={titleClass}>
          <Icon name="hourglass" size={16} />
          {v.name} is in the Agent District, waiting for its first event.
        </p>
        <p className={styles.hint}>
          The building stands unpainted until Claude Code really sends a hook from {created.workspace ? `“${created.workspace.label}”` : 'its workspace'}. Install the plugin once, then run <code>claude</code> in that folder:
        </p>
        <CommandSnippet command={CC.shellInstall} />
        <p className={styles.hint}>{more ?? <>Or load it from a Runloop checkout with <code>{CC.pluginDir}</code>.</>}</p>
      </>
    );
  }
  return (
    <>
      <p className={titleClass} role="status">
        <Icon name={v.health.icon} size={16} />
        {v.name} · {v.health.text}
      </p>
      <p className={styles.hint}>
        Real · Claude Code · observed
        {v.firstEventTick !== null ? ` · first event ${whenText(v.firstEventTick, today)}` : ''} · {v.lastEvent}
      </p>
      {v.attention && (
        <p className={styles.health} data-tone="warn">
          <Icon name="alert" size={14} />
          {v.attention}
        </p>
      )}
    </>
  );
}
