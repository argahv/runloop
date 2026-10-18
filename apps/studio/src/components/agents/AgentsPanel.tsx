'use client';
import type { ArrivalSummary } from '@runloop-world/events';
import Link from 'next/link';
import { useState } from 'react';
import { ROUTES } from '../../state/deeplink';
import { formatWhen } from '../../state/format';
import { useTicker } from '../../state/hooks';
import { claimSession, WorldApiError } from '../../world/api';
import { refreshAgents } from '../../world/connect';
import { useWorld, useWorldStore } from '../../world/context';
import { healthView, lastEventText } from '../../world/selectors';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/Toast';
import styles from './agents.module.css';

/**
 * Agents mode (plan §5): the Agent District's real agents with their
 * connection, and Arrivals: Claude Code sessions no agent's workspace
 * contains yet, which can be claimed (their earlier activity is backfilled)
 * or used to found a new agent.
 */
export default function AgentsPanel({ onAddToWorld }: { onAddToWorld: (fromSessionId?: string) => void }) {
  const store = useWorldStore();
  useWorld((s) => s.rev);
  const presences = useWorld((s) => s.snapshot?.agents);
  const summaries = useWorld((s) => s.agents);
  const arrivals = useWorld((s) => s.arrivals);
  const api = useWorld((s) => s.agentsApi);
  const town = useWorld((s) => s.town);
  useTicker(true, 5000);
  const now = Date.now();
  const list = presences ?? [];
  const free = (town?.agentLots.length ?? 0) - list.length;
  const unhoused = summaries.filter((a) => !a.housed);

  return (
    <div className={styles.panel}>
      <div>
        <div className={styles.head}>
          <h2 className={styles.title}>Agents</h2>
          <Button variant="secondary" size="sm" icon="plus" onClick={() => onAddToWorld()}>
            Add to World
          </Button>
        </div>
        <p className={styles.lede}>Real agents live in the Agent District. A building is their place in the town; the connection is the real integration, and the work happens where the agent runs.</p>
      </div>

      {api === 'unavailable' && (
        <p className={styles.notice}>
          <Icon name="alert" size={14} />
          This runtime does not serve the agents API yet, so workspaces, sessions and Arrivals are not reported. Buildings below come from the world log.
        </p>
      )}
      {api === 'offline' && (
        <p className={styles.notice}>
          <Icon name="alert" size={14} />
          Could not reach the agents API. Retrying every few seconds.
        </p>
      )}

      <section className={styles.section} aria-labelledby="agents-list">
        <h3 id="agents-list" className={styles.h3}>
          In the Agent District ({list.length}) · {free} free {free === 1 ? 'lot' : 'lots'}
        </h3>
        {list.length === 0 ? (
          <div className={styles.empty}>
            <p>No real agent lives here yet. The town runs on its own; adding your Claude Code agent gives it a building next to the residents.</p>
            <Button size="sm" variant="secondary" icon="plus" onClick={() => onAddToWorld()}>
              Add your first agent
            </Button>
          </div>
        ) : (
          <ul className={styles.list}>
            {list.map((a) => {
              const h = healthView(a.health);
              const summary = summaries.find((s) => s.agentId === a.agentId);
              return (
                <li key={a.agentId}>
                  <button type="button" className={styles.agentRow} onClick={() => store.getState().focusEntity({ kind: 'agent', id: a.agentId })}>
                    <span className={styles.hue} style={{ background: a.hue }} aria-hidden="true" />
                    <span className={styles.agentMain}>
                      <span className={styles.agentName}>{a.displayName}</span>
                      <span className={styles.agentMeta}>
                        {summary?.workspace?.label ?? (api === 'ok' ? 'no workspace yet' : 'workspace not reported')} · {summary ? lastEventText(summary.lastEventAt, now) : 'last event not reported'}
                      </span>
                    </span>
                    <span className={styles.health} data-tone={h.tone}>
                      <Icon name={h.icon} size={13} />
                      {h.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {unhoused.length > 0 && (
          <p className={styles.hint}>
            {unhoused.length} {unhoused.length === 1 ? 'agent is' : 'agents are'} registered but not housed yet; Runloop retries at start-up.
          </p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="arrivals">
        <h3 id="arrivals" className={styles.h3}>
          Arrivals ({arrivals.length})
        </h3>
        <p className={styles.hint}>Claude Code sessions whose folder no agent owns. They are traced as usual; claim one to bring its activity into a building.</p>
        {arrivals.length === 0 ? (
          <p className={styles.hint}>{api === 'ok' ? 'None right now.' : 'Not reported.'}</p>
        ) : (
          <ul className={styles.arrivals}>
            {arrivals.map((a) => (
              <Arrival key={a.sessionId} arrival={a} onFound={() => onAddToWorld(a.sessionId)} />
            ))}
          </ul>
        )}
      </section>

      <p className={styles.hint}>
        <Link href={ROUTES.overview}>All sessions</Link> · <Link href={ROUTES.integrations}>Connect Claude Code</Link>
      </p>
    </div>
  );
}

function Arrival({ arrival, onFound }: { arrival: ArrivalSummary; onFound: () => void }) {
  const store = useWorldStore();
  const agents = useWorld((s) => s.snapshot?.agents);
  const [target, setTarget] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await claimSession(target, arrival.sessionId);
      toast({ tone: 'ok', title: `Claimed for ${res.agent.displayName}`, description: `${res.backfilledRuns} ${res.backfilledRuns === 1 ? 'run' : 'runs'} of earlier activity replayed into the building.` });
      void refreshAgents(store);
    } catch (e) {
      setError(e instanceof WorldApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={styles.arrival}>
      <div className={styles.arrivalHead}>
        <Icon name="eye" size={14} />
        <span className={styles.agentName}>{arrival.projectLabel}</span>
        <span className={styles.agentMeta}>session {arrival.sessionId.slice(0, 8)}</span>
      </div>
      <span className={styles.agentMeta}>
        {arrival.pathHint ?? 'folder not known since the last restart'} · {arrival.runIds.length} {arrival.runIds.length === 1 ? 'run' : 'runs'} · first seen {formatWhen(arrival.firstSeenAt)}
      </span>
      <div className={styles.arrivalActions}>
        {(agents?.length ?? 0) > 0 && (
          <>
            <select className={styles.select} value={target} onChange={(e) => setTarget(e.target.value)} aria-label={`Claim ${arrival.projectLabel} for`}>
              <option value="">Claim for…</option>
              {agents!.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" disabled={!target} busy={busy} onClick={() => void claim()}>
              Claim
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" icon="plus" onClick={onFound}>
          New agent from it
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          <Icon name="xCircle" size={13} />
          {error}. Nothing changed.
        </p>
      )}
    </li>
  );
}
