'use client';
import { formatClock, selectRecentActions, selectTaskProgress, type ExecState, type ToolCallExec } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent } from '@runloop-world/events';
import { usePathname } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { ROUTES, linkTo } from '../state/deeplink';
import { formatWhen } from '../state/format';
import { CATEGORY_ICON, categoryLabel, describeEvent, formatInt, formatTokens, isTracedExec, usageParts, usageSourceText, usageText, usageTotal } from '../state/labels';
import { INFERRED, runProvenance } from '../state/provenance';
import { isTracedRun } from '../state/runs';
import { agentOfEvent, artifactIdsOf, callIdOf, eventProvenance, latestEventOf, parentChain, subagentOfCall, type InspectorTab } from '../state/selection';
import { formatDuration } from '../state/timeline';
import { agentLook, callStatusView, KIND_LABEL, runHasEnded, runStatusView, taskStatusView } from '../state/view';
import { Button } from '../ui/Button';
import { AgentDot, Chip, StatusBadge } from '../ui/Chip';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/States';
import { Tabs } from '../ui/Tabs';
import { toast } from '../ui/Toast';
import { runtimeStatusView } from '../views/graph/model';
import CharacterStatus from './CharacterStatus';
import styles from './Inspector.module.css';
import PayloadView from './PayloadView';
import RunMetrics from './RunMetrics';
import SourceFacts from './SourceFacts';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'event', label: 'Event' },
  { id: 'agent', label: 'Agent' },
  { id: 'run', label: 'Run' },
];

/**
 * The inspector: one view of the shared selection. Event = the selected
 * event; Agent = the selected agent's card; Run = summary, tasks, failures.
 */
export default function Inspector({ onClose }: { onClose?: () => void }) {
  const store = useStudioStore();
  const tab = useStudio((s) => s.inspectorTab);
  const runId = useStudio((s) => s.runId);
  const hasSelection = useStudio((s) => s.selectedSeq !== null || s.selectedAgentId !== null);

  return (
    <section className={styles.inspector} aria-label="Inspector">
      <header className={styles.header}>
        <Tabs items={TABS} value={tab} onChange={(t) => store.getState().setInspectorTab(t)} label="Inspector views" idPrefix="inspector" size="sm" />
        {(hasSelection || onClose) && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="x"
            aria-label={onClose ? 'Close the inspector' : 'Clear the selection (Esc)'}
            title={onClose ? 'Close' : 'Clear the selection (Esc)'}
            onClick={() => {
              store.getState().clearSelection();
              onClose?.();
            }}
          />
        )}
      </header>
      <div className={styles.body} id="inspector-panel" role="tabpanel" aria-labelledby={`inspector-tab-${tab}`}>
        {!runId ? (
          <EmptyState compact icon="target" title="Nothing selected">
            <p>Open a run to inspect its events and agents.</p>
          </EmptyState>
        ) : tab === 'event' ? (
          <EventView />
        ) : tab === 'agent' ? (
          <AgentView />
        ) : (
          <RunView />
        )}
      </div>
    </section>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.h3}>
        <span>{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const NotReported = () => <span className={styles.none}>not reported</span>;

/** Hook: the latest exec state, memoised on the received events. */
function useLatestExec(): ExecState {
  const store = useStudioStore();
  const lastSequence = useStudio((s) => s.lastSequence);
  return useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
}

function AgentLink({ exec, agentId }: { exec: ExecState; agentId: string | null }) {
  const store = useStudioStore();
  const world = useStudio((s) => s.world);
  if (!agentId) return <span className={styles.none}>System</span>;
  const look = agentLook(exec, world, agentId);
  return (
    <button type="button" className={styles.link} onClick={() => store.getState().selectAgent(agentId)}>
      <AgentDot color={look.color} />
      {look.name}
    </button>
  );
}

function EventLink({ e, exec, onSelect }: { e: AnyEvent; exec: ExecState; onSelect: (seq: number) => void }) {
  const f = describeEvent(e, exec);
  return (
    <button type="button" className={styles.eventLink} onClick={() => onSelect(e.sequence)}>
      <span className={styles.seq}>#{e.sequence}</span>
      <code className={styles.type}>{e.type}</code>
      <span className={styles.eventLabel}>{f.label}</span>
    </button>
  );
}


/** A tool call as the event at `seq` sees it: input and result summaries (payload text only), provenance, delegation. */
function CallSection({ call, seq, exec, events, traced }: { call: ToolCallExec; seq: number; exec: ExecState; events: readonly AnyEvent[]; traced: boolean }) {
  const sourceName = exec.run.source?.kind === 'claude-code' ? 'Claude Code' : 'the source';
  const finished = call.endedSeq !== null && call.endedSeq <= seq;
  const subagent = call.category === 'delegate' || call.tool === 'Agent' ? subagentOfCall(events, exec, call.startedEventId) : null;
  const usage = exec.usageReports.find((u) => u.callId === call.id && u.seq <= seq) ?? null;
  const prov = (p: ToolCallExec['startProvenance']) => (p === 'reported' ? `reported by ${sourceName}` : p === 'inferred' ? 'reconstructed by Runloop' : 'observed by the runtime');
  return (
    <Section
      title="Tool call"
      aside={
        call.category ? (
          <span className={styles.asideChip}>
            <Chip icon={CATEGORY_ICON[call.category]} title="Category of the call (drives the station in the world)">
              {categoryLabel(call.category)}
            </Chip>
          </span>
        ) : undefined
      }
    >
      <dl className={styles.facts}>
        <Fact label="Tool">
          <span className={styles.inline}>
            <code>{call.tool}</code>
            <StatusBadge view={callStatusView(finished ? call.status : 'running')} />
          </span>
        </Fact>
        <Fact label="Input">{call.inputSummary ? <span className={styles.summary}>{call.inputSummary}</span> : <NotReported />}</Fact>
        <Fact label="Result">
          {!finished ? (
            <span className={styles.none}>still running at this event</span>
          ) : call.outputSummary || call.message ? (
            <span className={styles.summary}>{call.outputSummary ?? call.message}</span>
          ) : (
            <NotReported />
          )}
        </Fact>
        {finished && call.errorType && (
          <Fact label="Error type">
            <code>{call.errorType}</code>
          </Fact>
        )}
        <Fact label="Duration">
          {finished && call.durationMs !== null ? (
            <>
              {formatDuration(call.durationMs)}
              {call.endProvenance === 'inferred' && <span className={styles.muted}> · until Runloop closed it, not a reported run time</span>}
            </>
          ) : (
            <span className={styles.none}>{finished ? 'not reported' : 'still running'}</span>
          )}
        </Fact>
        {finished && call.exitCode !== null && <Fact label="Exit code">{call.exitCode}</Fact>}
        {traced && (
          <Fact label="Provenance">
            <span className={styles.provLines}>
              <span>
                Start: {prov(call.startProvenance)}
                {call.startProvenance === 'inferred' && <Chip tone={INFERRED.tone} icon={INFERRED.icon}>inferred</Chip>}
              </span>
              {finished && (
                <span>
                  End: {prov(call.endProvenance)}
                  {call.endProvenance === 'inferred' && <Chip tone={INFERRED.tone} icon={INFERRED.icon}>inferred</Chip>}
                </span>
              )}
            </span>
          </Fact>
        )}
        {subagent && (
          <Fact label="Subagent">
            <AgentLink exec={exec} agentId={subagent} />
          </Fact>
        )}
        {usage && (
          <Fact label="Usage">
            <span className={styles.provLines}>
              <span>
                {usageText(usage)} · {usageParts(usage)}
              </span>
              <span className={styles.muted}>{usageSourceText(usage.source)}</span>
            </span>
          </Fact>
        )}
      </dl>
    </Section>
  );
}

function EventView() {
  const store = useStudioStore();
  const pathname = usePathname() ?? '';
  const seq = useStudio((s) => s.selectedSeq);
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const run = useStudio((s) => s.run);
  const runId = useStudio((s) => s.runId);
  const exec = useLatestExec();
  const [showRaw, setShowRaw] = useState(false);
  const s = store.getState();
  const events = s.events();
  const e = seq !== null ? events[seq - 1] : undefined;
  const byId = useMemo(() => new Map(events.map((x) => [x.eventId, x])), [events, events.length]);

  if (!e || seq === null) {
    return (
      <EmptyState compact icon="traces" title="No event selected">
        <p>Select a row in the timeline or the log, a failure marker on the scrubber, or a character in the world.</p>
      </EmptyState>
    );
  }

  const select = (n: number) => s.selectEvent(n);
  const f = describeEvent(e, exec);
  // The event's own agent (not whichever agent happens to be selected).
  const agentId = agentOfEvent(e, exec);
  const task = e.taskId ? exec.tasks[e.taskId] : undefined;
  const callId = callIdOf(e);
  const call = callId ? exec.toolCalls.get(callId) : undefined;
  const parents = parentChain(e, byId);
  const children = events.filter((x) => x.parentEventId === e.eventId).slice(0, 10);
  const artifacts = [...new Set([...artifactIdsOf(e), ...(call && call.endedSeq !== null && call.endedSeq <= seq ? call.outputArtifactIds : [])])];
  const provenance = eventProvenance(e);
  const runProv = runProvenance(run, exec);
  const raw = s.rawEvent(seq) ?? e;
  const tone = f.severity === 'error' ? 'err' : f.severity === 'warn' ? 'warn' : f.severity === 'ok' ? 'ok' : 'muted';

  const copyLink = () => {
    if (!runId) return;
    const route = pathname.startsWith(ROUTES.traces) ? ROUTES.traces : ROUTES.world;
    const url = new URL(linkTo(route, { runId, seq }), window.location.origin).href;
    navigator.clipboard.writeText(url).then(
      () => toast({ tone: 'ok', title: 'Link copied', description: `Opens event #${seq} of this run.` }),
      () => toast({ tone: 'err', title: 'Could not copy the link', description: url }),
    );
  };

  return (
    <div className={styles.stack}>
      <div className={styles.eventHead}>
        <span className={styles.eventIcon} data-tone={tone} aria-hidden="true">
          <Icon name={tone === 'err' ? 'x' : tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : 'dot'} size={14} />
        </span>
        <div className={styles.eventTitleWrap}>
          <h2 className={styles.eventTitle}>{f.label}</h2>
          <p className={styles.eventSub}>
            <code>{e.type}</code> · #{e.sequence} · {formatClock(s.timeOfSeq(e.sequence))}
          </p>
        </div>
      </div>

      <div className={styles.chips}>
        {provenance === 'inferred' ? (
          <Chip tone={INFERRED.tone} icon={INFERRED.icon} title={INFERRED.detail}>
            {INFERRED.label}
          </Chip>
        ) : (
          <Chip tone={runProv.tone} icon={runProv.icon} title={runProv.detail}>
            {runProv.kind === 'traced' ? 'Reported' : runProv.label}
          </Chip>
        )}
        <Chip
          icon={e.visibility === 'public' ? 'eye' : e.visibility === 'sensitive' ? 'lock' : 'eyeOff'}
          tone={e.visibility === 'public' ? undefined : 'warn'}
          title={e.visibility === 'sensitive' ? 'May contain prompts or other sensitive text' : e.visibility === 'redacted' ? 'Secrets were masked before recording' : 'No sensitive content flagged'}
        >
          {e.visibility}
        </Chip>
        {isUnknownEvent(e) && (
          <Chip tone="warn" icon="alert">
            {e.reason.replace(/_/g, ' ')}
          </Chip>
        )}
        {e.sequence > playheadSeq && <Chip icon="clock">after the playhead</Chip>}
      </div>
      {f.detail && <p className={styles.detail}>{f.detail}</p>}

      <div className={styles.actions}>
        {e.sequence !== playheadSeq && (
          <Button size="sm" icon="target" onClick={() => s.seekToSeq(e.sequence)}>
            Move playhead here
          </Button>
        )}
        <Button size="sm" variant="ghost" icon="link" onClick={copyLink}>
          Copy link
        </Button>
      </div>

      <Section title="Details">
        <dl className={styles.facts}>
          <Fact label="Agent">
            <AgentLink exec={exec} agentId={agentId} />
          </Fact>
          {task && (
            <Fact label="Task">
              <span className={styles.inline}>
                <code>{task.id}</code> {task.title}
              </span>
            </Fact>
          )}
          <Fact label="Recorded at">
            <span title={e.timestamp}>{new Date(e.timestamp).toLocaleTimeString(undefined, { hour12: false })}</span>
          </Fact>
          <Fact label="Event id">
            <code className={styles.id}>{e.eventId}</code>
          </Fact>
          <Fact label="Schema">v{e.schemaVersion}</Fact>
        </dl>
      </Section>

      {call && <CallSection call={call} seq={seq} exec={exec} events={events} traced={isTracedExec(exec)} />}

      {call?.metrics && call.endedSeq !== null && call.endedSeq <= seq && (
        <Section title="Test results" aside={<span className={styles.asideNote}>as reported by the test runner</span>}>
          <div className={styles.metrics}>
            <span className={styles.metric} data-tone="ok">
              <strong>{call.metrics.passed}</strong> passed
            </span>
            <span className={styles.metric} data-tone={call.metrics.failed > 0 ? 'err' : undefined}>
              <strong>{call.metrics.failed}</strong> failed
            </span>
            <span className={styles.metric}>
              <strong>{call.metrics.tests}</strong> total
            </span>
          </div>
          {call.failingTests.length > 0 && (
            <ul className={styles.failing}>
              {call.failingTests.map((t) => (
                <li key={t}>
                  <Icon name="x" size={12} />
                  <code>{t}</code>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Payload">
        <PayloadView payload={e.payload} />
      </Section>

      {artifacts.length > 0 && (
        <Section title="Artifacts">
          <ul className={styles.links}>
            {artifacts.map((id) => (
              <li key={id}>
                <button type="button" className={styles.eventLink} onClick={() => s.openArtifact(id)}>
                  <Icon name="file" size={14} />
                  <span className={styles.eventLabel}>{exec.artifacts[id]?.name ?? id}</span>
                  {exec.artifacts[id] && <Chip>{exec.artifacts[id]!.kind}</Chip>}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(parents.length > 0 || children.length > 0) && (
        <Section title="Causal chain">
          {parents.length > 0 && (
            <>
              <p className={styles.chainLabel}>Caused by</p>
              <ul className={styles.links}>
                {parents.map((p) => (
                  <li key={p.eventId}>
                    <EventLink e={p} exec={exec} onSelect={select} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {children.length > 0 && (
            <>
              <p className={styles.chainLabel}>Led to</p>
              <ul className={styles.links}>
                {children.map((c) => (
                  <li key={c.eventId}>
                    <EventLink e={c} exec={exec} onSelect={select} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}

      <Section
        title="Raw JSON"
        aside={
          <Button size="sm" variant="ghost" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Hide' : 'Show'}
          </Button>
        }
      >
        {showRaw ? <pre className={styles.json}>{JSON.stringify(raw, null, 2)}</pre> : <p className={styles.muted}>The event exactly as the runtime sent it.</p>}
      </Section>
    </div>
  );
}

function AgentView() {
  const store = useStudioStore();
  const selected = useStudio((s) => s.selectedAgentId);
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const world = useStudio((s) => s.world);
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const latestExec = useLatestExec();
  const { exec } = state;
  const s = store.getState();

  if (!selected) {
    return (
      <EmptyState compact icon="agent" title="No agent selected">
        <p>Select a character in the world, a name in the roster, or press ] to cycle through agents.</p>
      </EmptyState>
    );
  }
  const agent = exec.agents[selected];
  if (!agent) {
    return (
      <EmptyState compact icon="agent" title="Not registered yet">
        <p>This agent registers later in the run. Move the playhead forward to see it.</p>
      </EmptyState>
    );
  }

  const look = agentLook(exec, world, agent.id);
  const character = state.world.characters[agent.id];
  const station = character?.stationId && world ? world.stationsById[character.stationId] : undefined;
  const task = agent.currentTaskId ? exec.tasks[agent.currentTaskId] : undefined;
  const progress = task ? selectTaskProgress(exec, task.id) : null;
  const actions = selectRecentActions(exec, agent.id, 6);
  const artifacts = exec.artifactOrder
    .map((id) => exec.artifacts[id]!)
    .filter((a) => a.agentId === agent.id)
    .reverse();
  const latest = latestEventOf(s.events(), latestExec, agent.id, seq);
  const ended = runHasEnded(exec);

  return (
    <div className={styles.stack}>
      <div className={styles.agentHead}>
        <span className={styles.avatar} style={{ background: look.color }} aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <div className={styles.eventTitleWrap}>
          <h2 className={styles.eventTitle}>{agent.name}</h2>
          <p className={styles.eventSub}>{agent.role}</p>
        </div>
      </div>
      <div className={styles.chips}>
        {character && <CharacterStatus agentId={agent.id} />}
        <Chip>
          {ended ? 'last state' : 'state'}: {runtimeStatusView(agent.state, ended).text}
        </Chip>
        {station && <Chip icon="target">at {station.label}</Chip>}
        {!agent.embodied && <Chip>no character in the world</Chip>}
      </div>
      {agent.stateReason && <p className={styles.detail}>{agent.stateReason}</p>}
      <div className={styles.actions}>
        {latest !== null && (
          <Button size="sm" icon="traces" onClick={() => s.selectEvent(latest)}>
            Latest event #{latest}
          </Button>
        )}
      </div>

      <Section title="Profile">
        <dl className={styles.facts}>
          <Fact label="Model">
            {agent.model ?? agent.usage?.model ?? <NotReported />}
            {!agent.model && agent.usage?.model && <span className={styles.muted}> · {usageSourceText(agent.usage.source)}</span>}
          </Fact>
          <Fact label="Tokens">
            {agent.usage ? (
              <span className={styles.provLines}>
                <span title={`${formatInt(usageTotal(agent.usage))} tokens`}>{formatTokens(usageTotal(agent.usage))} tokens</span>
                <span className={styles.muted}>{usageParts(agent.usage)}</span>
                <span className={styles.muted}>{usageSourceText(agent.usage.source)}</span>
              </span>
            ) : (
              <span>
                <NotReported />
                {isTracedExec(exec) && agent.role === 'main agent' && <span className={styles.muted}> · Claude Code hooks do not report the main agent’s usage</span>}
              </span>
            )}
          </Fact>
          <Fact label="Tools">
            {agent.tools.length ? (
              <span className={styles.toolList}>
                {agent.tools.map((t) => (
                  <code key={t} className={styles.tag}>
                    {t}
                  </code>
                ))}
              </span>
            ) : (
              <NotReported />
            )}
          </Fact>
          <Fact label="Agent id">
            <code className={styles.id}>{agent.id}</code>
          </Fact>
        </dl>
      </Section>

      <Section title="Current task">
        {task ? (
          <div className={styles.task}>
            <div className={styles.taskTop}>
              <span className={styles.taskTitle}>{task.title}</span>
              <StatusBadge view={taskStatusView(task.status, ended)} />
            </div>
            <span className={styles.muted}>
              <code>{task.id}</code> · {KIND_LABEL[task.kind] ?? task.kind} · attempt {Math.max(1, task.attempts)}
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
              {task.plannedSteps !== null ? `${Math.min(task.stepsDoneThisAttempt, task.plannedSteps)} of ${task.plannedSteps} planned steps` : 'No step plan reported'}
            </span>
          </div>
        ) : (
          <p className={styles.muted}>No task at the playhead.</p>
        )}
      </Section>

      <Section title="Recent actions">
        {actions.length === 0 ? (
          <p className={styles.muted}>No tool calls yet.</p>
        ) : (
          <ol className={styles.links}>
            {actions.map((c) => {
              const view = callStatusView(c.status);
              return (
                <li key={c.id}>
                  <button type="button" className={styles.action} onClick={() => s.selectEvent(c.endedSeq ?? c.startedSeq, { seek: true })}>
                    <span className={styles.actionIcon} data-tone={view.tone} aria-hidden="true">
                      <Icon name={c.status === 'success' ? 'check' : c.status === 'running' ? 'pulse' : 'x'} size={12} />
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
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <Section title="Artifacts">
        {artifacts.length === 0 ? (
          <p className={styles.muted}>None yet.</p>
        ) : (
          <ul className={styles.links}>
            {artifacts.map((a) => (
              <li key={a.artifactId}>
                <button type="button" className={styles.eventLink} onClick={() => s.openArtifact(a.artifactId)}>
                  <Icon name="file" size={14} />
                  <span className={styles.eventLabel}>{a.name}</span>
                  <Chip>{a.kind}</Chip>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function RunView() {
  const store = useStudioStore();
  const run = useStudio((s) => s.run);
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const world = useStudio((s) => s.world);
  const exec = useMemo(() => store.getState().stateAt(seq).exec, [store, seq, lastSequence]);
  const latest = useLatestExec();
  const s = store.getState();
  if (!run) {
    return (
      <EmptyState compact icon="traces" title="Loading the run">
        <p>The summary appears once the run’s first events arrive.</p>
      </EmptyState>
    );
  }
  const prov = runProvenance(run, latest);
  const traced = prov.kind === 'traced' || isTracedRun(run);
  const ended = runHasEnded(exec);
  const failures = latest.incidents;

  return (
    <div className={styles.stack}>
      <div className={styles.eventHead}>
        <div className={styles.eventTitleWrap}>
          <h2 className={styles.eventTitle}>{run.title}</h2>
          <p className={styles.eventSub}>Started {formatWhen(run.createdAt)}</p>
        </div>
      </div>
      <div className={styles.chips}>
        <StatusBadge view={runStatusView(run.status, run.paused, traced)} />
        <Chip tone={prov.tone} icon={prov.icon} title={prov.detail}>
          {prov.label}
        </Chip>
      </div>
      <p className={styles.provenance}>{prov.detail}</p>

      {traced && (
        <Section title="Source">
          <SourceFacts run={run} exec={latest} />
        </Section>
      )}

      <Section title="Metrics">
        <RunMetrics variant="compact" />
      </Section>

      {failures.length > 0 && (
        <Section title="Failures">
          <ul className={styles.links}>
            {failures.map((i) => (
              <li key={i.eventId}>
                <button type="button" className={styles.action} onClick={() => s.selectEvent(i.seq, { seek: true })}>
                  <span className={styles.actionIcon} data-tone={i.resolvedSeq !== null ? 'muted' : 'err'} aria-hidden="true">
                    <Icon name="alert" size={12} />
                  </span>
                  <span className={styles.actionBody}>
                    <span className={styles.actionTitle}>
                      {i.kind.replace(/_/g, ' ')} · #{i.seq}
                    </span>
                    <span className={styles.muted}>
                      {i.message}
                      {i.resolvedSeq !== null
                        ? i.resolution === 'later_success'
                          ? ` · a later call succeeded at #${i.resolvedSeq} (inferred)`
                          : ` · resolved at #${i.resolvedSeq} (its task finished)`
                        : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Tasks at the playhead">
        {exec.taskOrder.length === 0 ? (
          <p className={styles.muted}>No tasks yet.</p>
        ) : (
          <ol className={styles.links}>
            {exec.taskOrder.map((id) => {
              const t = exec.tasks[id]!;
              const owner = t.ownerId ? agentLook(exec, world, t.ownerId) : null;
              return (
                <li key={id}>
                  <button type="button" className={styles.action} onClick={() => t.ownerId && s.selectAgent(t.ownerId)} disabled={!t.ownerId}>
                    <span className={styles.actionBody}>
                      <span className={styles.taskTop}>
                        <span className={styles.actionTitle}>{t.title}</span>
                        <StatusBadge view={taskStatusView(t.status, ended)} />
                      </span>
                      <span className={styles.muted}>
                        <code>{t.id}</code> · {KIND_LABEL[t.kind] ?? t.kind}
                        {owner ? ` · ${owner.name}` : ''}
                        {t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
    </div>
  );
}
