'use client';
import { baselineFor } from '../../state/baselines';
import { useStudio, useStudioStore } from '../../state/context';
import { formatWhen } from '../../state/format';
import { selectRun, useTicker } from '../../state/hooks';
import { useWorld, useWorldStore } from '../../world/context';
import { agentView } from '../../world/selectors';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Icon } from '../../ui/Icon';
import { CC } from '../../lib/claude-code';
import { CommandSnippet } from '../../ui/CommandSnippet';
import { AssignTaskSection } from '../agents/AssignTask';
import { useStudioNav } from '../overlays/nav';
import styles from './panels.module.css';

const METHOD: Record<string, string> = { path: 'bound by folder', dispatch: 'dispatched by Runloop', claimed: 'claimed from Arrivals' };
const STATUS: Record<string, string> = { running: 'open', completed: 'ended', stopped: 'ended', failed: 'failed', interrupted: 'interrupted' };

/**
 * A real agent's building (plan §5): connection health in text and icon with
 * the last event's age, capabilities with reasons, the workspace label and
 * hint, sessions (interior, Traces, Compare), Assign task, and "Real ·
 * Claude Code · observed". There is no Why: an agent's reasoning is never
 * shown or implied; only what its hooks reported.
 */
export default function AgentPanel({ id }: { id: string }) {
  const store = useWorldStore();
  const studio = useStudioStore();
  useWorld((s) => s.rev);
  const presence = useWorld((s) => s.snapshot?.agents.find((a) => a.agentId === id) ?? null);
  const summary = useWorld((s) => s.agents.find((a) => a.agentId === id) ?? null);
  const agentsApi = useWorld((s) => s.agentsApi);
  const entered = useWorld((s) => s.entered);
  const runs = useStudio((s) => s.runs);
  const nav = useStudioNav();
  useTicker(true, 1000);
  const v = agentView(presence, summary, Date.now(), agentsApi);
  if (!v) return <p className={styles.panel}>This agent is not in the town.</p>;

  const buildingId = presence?.buildingId ?? summary?.buildingId ?? null;
  const inside = buildingId !== null && entered === buildingId;
  const latestRun = v.activeRunId ?? v.sessions[0]?.runId ?? null;
  const submit = v.capabilities.find((c) => c.id === 'submit_task');
  const enter = () => {
    if (latestRun) selectRun(studio, latestRun);
    store.getState().enter(inside ? null : buildingId);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={`${styles.avatar} ${styles.square}`} style={{ background: '#2a2d34', color: presence?.hue ?? '#e8ebf0' }} aria-hidden="true">
            <Icon name="agent" size={20} />
          </span>
          <div>
            <h2 className={styles.title}>{v.name}</h2>
            <p className={styles.subtitle}>Agent headquarters · Agent District</p>
          </div>
        </div>
        <div className={styles.chips}>
          <Chip icon={v.chip.icon} tone={v.chip.real ? 'info' : 'muted'} title={v.chip.detail}>
            {v.chip.label}
          </Chip>
        </div>
      </div>

      {v.unregistered && (
        <p className={styles.notice}>
          <Icon name="alert" size={14} />
          No agent is registered for this building in this runtime, so nothing here is real agent activity and it offers no actions.
        </p>
      )}
      {!v.unregistered && (
        <>
          <section className={styles.section} aria-labelledby="conn-title">
            <h3 id="conn-title" className={styles.h3}>
              Connection
            </h3>
            <div className={styles.card}>
              <span className={styles.health} data-tone={v.health.tone}>
                <Icon name={v.health.icon} size={16} />
                {v.health.text}
              </span>
              <span className={styles.note}>
                {v.lastEvent} · {v.health.detail}
              </span>
              {v.taskNote && (
                <span className={styles.health} data-tone="live" style={{ fontSize: 'var(--rl-text-sm)' }}>
                  <Icon name="play" size={14} />
                  {v.taskNote}
                </span>
              )}
              {v.attention && (
                <span className={styles.health} data-tone="warn" style={{ fontSize: 'var(--rl-text-sm)' }}>
                  <Icon name="alert" size={14} />
                  {v.attention}
                </span>
              )}
            </div>
            {(presence?.health === 'awaiting_first_event' || presence?.health === 'not_connected') && (
              <div className={styles.connectSteps}>
                <p className={styles.note}>
                  Install the Runloop plugin once, then run <code>claude</code> in {v.workspace ? `“${v.workspace.label}”` : 'its workspace'}. The building is painted when the first hook arrives.
                </p>
                <CommandSnippet command={CC.shellInstall} />
              </div>
            )}
            {v.apiMissing && (
              <p className={styles.notice}>
                <Icon name="alert" size={14} />
                {agentsApi === 'unavailable'
                  ? 'This runtime does not serve the agents API, so the workspace, sessions and capabilities are not reported. The building and its connection come from the world log.'
                  : 'Could not reach the agents API; the workspace, sessions and capabilities are not reported right now.'}
              </p>
            )}
          </section>

          {v.activeRunId && (
            <section className={styles.section} aria-labelledby="act-title">
              <div className={styles.sectionHead}>
                <h3 id="act-title" className={styles.h3}>
                  In the open session
                </h3>
                <span className={styles.note}>as reported by Claude Code hooks</span>
              </div>
              <div className={styles.card}>
                <span className={styles.nowLine} style={{ textTransform: 'capitalize' }}>
                  {v.execState}
                </span>
                <div className={styles.chips}>
                  {v.counts.length === 0 ? <span className={styles.note}>No tool calls yet</span> : v.counts.map((c) => <Chip key={c.category}>{`${c.category} ${c.n}`}</Chip>)}
                  {v.helpers > 0 && <Chip icon="graph">{`${v.helpers} ${v.helpers === 1 ? 'subagent' : 'subagents'}`}</Chip>}
                  {v.openIncidents > 0 && (
                    <Chip icon="alert" tone="err">
                      {`${v.openIncidents} open ${v.openIncidents === 1 ? 'failure' : 'failures'}`}
                    </Chip>
                  )}
                </div>
                {v.lastCause && (
                  <button
                    type="button"
                    className={`${styles.note} ${styles.textLink}`}
                    onClick={() => nav.openTrace(v.lastCause!.runId, { seq: v.lastCause!.seqTo })}
                  >
                    From run events {v.lastCause.seqFrom}–{v.lastCause.seqTo} · open the trace →
                  </button>
                )}
              </div>
            </section>
          )}

          <div className={styles.actions}>
            <Button size="sm" variant="secondary" icon={inside ? 'arrowUp' : 'arrowRight'} onClick={enter} disabled={!buildingId}>
              {inside ? 'Leave building' : 'Enter building'}
            </Button>
            {latestRun && (
              <button type="button" className={styles.miniLink} onClick={() => nav.openTrace(latestRun)} style={{ height: 28 }}>
                Open the trace
              </button>
            )}
          </div>

          <AssignTaskSection agentId={v.agentId} agentName={v.name} workspaceLabel={v.workspace?.label ?? null} submit={submit} latest={presence?.dispatch ?? null} />
          <section className={styles.section} aria-labelledby="caps-title">
            <h3 id="caps-title" className={styles.h3}>
              Capabilities
            </h3>
            <ul className={styles.caps}>
              {v.capabilities.map((c) => (
                <li key={c.id} className={styles.cap} data-available={c.available || undefined}>
                  <span className={styles.capIcon}>
                    <Icon name={c.available ? 'check' : 'slash'} size={14} label={c.available ? 'available' : 'not available'} />
                  </span>
                  <span className={styles.capName}>{c.label}</span>
                  <span className={styles.capReason}>{c.available ? 'Available' : c.reason}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.section} aria-labelledby="ws-title">
            <h3 id="ws-title" className={styles.h3}>
              Workspace
            </h3>
            {v.workspace ? (
              <dl className={styles.kv}>
                <dt>Folder</dt>
                <dd>{v.workspace.label}</dd>
                <dt>Where</dt>
                <dd className={styles.mono}>{v.workspace.pathHint}</dd>
              </dl>
            ) : (
              <p className={styles.note}>{v.apiMissing ? 'Not reported.' : 'No workspace bound yet. Sessions started inside its folder bind to this agent.'}</p>
            )}
            <p className={styles.note}>The full path stays on this machine and is never shown or stored in the world.</p>
          </section>

          <section className={styles.section} aria-labelledby="ses-title">
            <h3 id="ses-title" className={styles.h3}>
              Sessions
            </h3>
            {v.sessions.length === 0 ? (
              <p className={styles.note}>{v.apiMissing ? 'Not reported.' : 'No session yet. Start Claude Code in the workspace with the Runloop plugin.'}</p>
            ) : (
              <ul className={styles.list}>
                {v.sessions.slice(0, 8).map((s, i) => {
                  const base = baselineFor(runs, s.runId);
                  return (
                    <li key={s.runId} className={styles.row}>
                      <span className={styles.rowMain} title={`${METHOD[s.bindingMethod] ?? s.bindingMethod} · run ${s.runId}`}>
                        Session #{v.sessions.length - i}
                        <span className={styles.muted}>
                          {' '}
                          · {STATUS[s.status] ?? s.status} · {formatWhen(s.startedAt)}
                        </span>
                      </span>
                      <span className={styles.sessionActions}>
                        <button type="button" className={styles.miniLink} onClick={() => nav.openRunWorld(s.runId)} title="Watch it in the building's interior (replay inside)">
                          Interior
                        </button>
                        <button type="button" className={styles.miniLink} onClick={() => nav.openTrace(s.runId)}>
                          Trace
                        </button>
                        <button
                          type="button"
                          className={styles.miniLink}
                          onClick={() =>
                            nav.openCompare({
                              a: base?.runId ?? null,
                              b: s.runId,
                            })
                          }
                          title={base ? `Compare with the baseline ${base.title}` : 'Pick a baseline to compare with'}
                        >
                          Compare
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
