'use client';
import type { RunSummary } from '@runloop-world/events';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { connectCommands } from '../../lib/claude-code';
import { apiBase } from '../../lib/config';
import { useStudio, useStudioStore } from '../../state/context';
import { ROUTES } from '../../state/deeplink';
import { formatWhen, runDurationMs } from '../../state/format';
import { selectRun, useTicker } from '../../state/hooks';
import { nextStep, ONBOARDING_STEPS, stepsDone, type OnboardingStep } from '../../state/onboarding';
import { activityText, formatAgo, groupRuns, isTracedRun, lastTracedEventAt, runSourceLabel, runSubtitle } from '../../state/runs';
import { formatDuration } from '../../state/timeline';
import { runStatusView } from '../../state/view';
import { Button, ButtonLink } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chip, StatusBadge } from '../../ui/Chip';
import { CommandSnippet } from '../../ui/CommandSnippet';
import { Icon } from '../../ui/Icon';
import { Kbd, modKey } from '../../ui/Kbd';
import { EmptyState, Skeleton } from '../../ui/States';
import { OfflineState } from '../RunStates';
import { useStartDemo } from '../useStartDemo';
import styles from './Pages.module.css';

function SourceChip({ run }: { run: RunSummary }) {
  const traced = isTracedRun(run);
  return (
    <Chip tone={traced ? 'info' : 'muted'} icon={traced ? 'eye' : 'terminal'} title={traced ? 'Recorded from Claude Code hooks; Runloop did not run or verify it' : 'Runloop’s runtime ran the tools itself'}>
      {runSourceLabel(run)}
    </Chip>
  );
}

/** Overview: getting started, runtime health, live sessions and run history. */
export default function OverviewPage() {
  const store = useStudioStore();
  const router = useRouter();
  const runtime = useStudio((s) => s.runtime);
  const runs = useStudio((s) => s.runs);
  const onboarding = useStudio((s) => s.onboarding);
  useStudio((s) => s.apiBaseOverride); // re-render when the runtime URL changes
  const groups = useMemo(() => groupRuns(runs), [runs]);
  useTicker(groups.live.length > 0, 5000);

  const open = (runId: string, route: string = ROUTES.world) => {
    selectRun(store, runId);
    router.push(route);
  };

  const online = runtime.status === 'online';
  const done = stepsDone(onboarding, runs);
  const allDone = nextStep(done) === null;
  const showChecklist = online && !onboarding.dismissed && !allDone;

  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.pageHead}>
          <div>
            <h1 className={styles.h1}>Overview</h1>
            <p className={styles.lede}>A local flight recorder for coding agents: watch a run live, replay any moment, and inspect every tool call.</p>
          </div>
        </header>

        {runtime.status === 'offline' ? (
          <Card>
            <OfflineState />
          </Card>
        ) : (
          <div className={styles.overviewTop}>
            {showChecklist ? <Checklist done={done} onOpen={open} /> : <QuickStart />}
            <HealthCard />
          </div>
        )}

        {/* Offline, the runtime's sessions and runs are unknown: say nothing rather than "none". */}
        {runtime.status !== 'offline' && (
          <>
            <Card title="Live sessions" subtitle="Recording right now; idle time counts from the last recorded event" labelledBy="live-sessions">
              <div className={styles.cardBody}>
                {runtime.status === 'unknown' ? (
                  <Skeleton height={52} radius={8} />
                ) : groups.live.length === 0 ? (
                  <EmptyState inline icon="pulse" title="Nothing is recording">
                    <p>Run Claude Code with the plugin installed, or start the demo mission. A session appears here with its first recorded event, and the Studio opens it when nothing else is open.</p>
                  </EmptyState>
                ) : (
                  <ul className={styles.sessions}>
                    {groups.live.map((r) => (
                      <LiveSession key={r.runId} run={r} n={runs.length - runs.indexOf(r)} onOpen={open} />
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card title="Run history" subtitle="Everything this runtime recorded, newest first" labelledBy="run-history">
              {runtime.status === 'unknown' ? (
                <div className={styles.cardBody}>
                  <Skeleton height={14} />
                  <Skeleton height={14} width="80%" />
                  <Skeleton height={14} width="60%" />
                </div>
              ) : groups.traced.length + groups.demo.length === 0 ? (
                <div className={styles.cardBody}>
                  <EmptyState inline icon="traces" title={runs.length ? 'No finished runs yet' : 'No runs recorded yet'}>
                    <p>
                      Finished runs are kept here to replay. Start one from the checklist above, or from a terminal: <code>pnpm demo</code>.
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Run</th>
                        <th scope="col">Status</th>
                        <th scope="col">Source</th>
                        <th scope="col">Started</th>
                        <th scope="col" className={styles.right}>
                          Duration
                        </th>
                        <th scope="col" className={styles.right}>
                          Events
                        </th>
                        <th scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <HistoryGroup title="Claude Code sessions" icon="eye" runs={groups.traced} all={runs} onOpen={open} />
                    <HistoryGroup title="Demo runs" icon="terminal" runs={groups.demo} all={runs} onOpen={open} />
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function HistoryGroup({ title, icon, runs, all, onOpen }: { title: string; icon: 'eye' | 'terminal'; runs: RunSummary[]; all: RunSummary[]; onOpen: (id: string, route?: string) => void }) {
  if (runs.length === 0) return null;
  return (
    <tbody>
      <tr className={styles.groupRow}>
        <th scope="colgroup" colSpan={8}>
          <span className={styles.groupTitle}>
            <Icon name={icon} size={13} />
            {title}
            <span className={styles.groupCount}>{runs.length}</span>
          </span>
        </th>
      </tr>
      {runs.map((r) => {
        const n = all.length - all.indexOf(r);
        const ms = runDurationMs(r);
        const sub = runSubtitle(r);
        return (
          <tr key={r.runId}>
            <td className={styles.num}>{n}</td>
            <td className={styles.titleCell}>
              <button type="button" className={styles.rowLink} onClick={() => onOpen(r.runId)}>
                {r.title}
              </button>
              {sub && <span className={styles.rowSub}>{sub}</span>}
            </td>
            <td>
              <StatusBadge view={runStatusView(r.status, r.paused, isTracedRun(r))} />
            </td>
            <td>
              <SourceChip run={r} />
            </td>
            <td className={styles.num}>{formatWhen(r.createdAt)}</td>
            <td className={`${styles.num} ${styles.right}`}>{ms !== null ? formatDuration(ms) : <span className={styles.none}>not reported</span>}</td>
            <td className={`${styles.num} ${styles.right}`}>{r.lastSequence}</td>
            <td className={styles.right}>
              <Button size="sm" variant="ghost" icon="traces" onClick={() => onOpen(r.runId, ROUTES.traces)} aria-label={`Open run ${n} in Traces`}>
                Traces
              </Button>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

function LiveSession({ run, n, onOpen }: { run: RunSummary; n: number; onOpen: (id: string, route?: string) => void }) {
  const traced = isTracedRun(run);
  const ms = runDurationMs(run);
  const activity = traced ? activityText(run, Date.now()) : null;
  const sub = runSubtitle(run);
  return (
    <li className={styles.session}>
      <span className={styles.liveDot} aria-hidden="true" />
      <div className={styles.sessionMain}>
        <span className={styles.sessionTitle}>
          <span className={styles.sessionNum}>#{n}</span> {run.title}
        </span>
        <span className={styles.sessionMeta}>
          {sub && <span className={styles.mono}>{sub} · </span>}
          started {formatWhen(run.createdAt)} · {run.lastSequence} events{ms !== null ? ` · ${formatDuration(ms)}` : ''}
          {activity && (
            <>
              {' · '}
              <strong className={styles.activity} data-idle={activity !== 'active' || undefined}>
                {activity}
              </strong>
            </>
          )}
        </span>
      </div>
      <SourceChip run={run} />
      <StatusBadge view={runStatusView(run.status, run.paused, traced)} />
      <div className={styles.sessionActions}>
        <Button size="sm" variant="primary" icon="world" onClick={() => onOpen(run.runId)}>
          Watch
        </Button>
        <Button size="sm" variant="ghost" icon="traces" onClick={() => onOpen(run.runId, ROUTES.traces)} aria-label={`Open run ${n} in Traces`}>
          Traces
        </Button>
      </div>
    </li>
  );
}

function HealthCard() {
  const runtime = useStudio((s) => s.runtime);
  const runs = useStudio((s) => s.runs);
  const store = useStudioStore();
  const router = useRouter();
  const online = runtime.status === 'online';
  const ingest = runtime.ingest;
  const lastTraced = lastTracedEventAt(runs);
  const tracedCount = runs.filter(isTracedRun).length;
  const checking = <span className={styles.none}>checking…</span>;

  return (
    <Card title="Runtime health" subtitle="The local process that records and serves runs">
      <div className={styles.cardBody}>
        {runtime.status === 'unknown' ? (
          <div className={styles.bigStatus} role="status" aria-label="Checking the runtime">
            <Skeleton width={40} height={40} radius={12} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Skeleton width="50%" height={14} />
              <Skeleton width="70%" height={10} />
            </div>
          </div>
        ) : (
          <div className={styles.bigStatus}>
            <span className={styles.bigStatusIcon} data-tone="ok" aria-hidden="true">
              <Icon name="checkCircle" size={20} />
            </span>
            <div>
              <p className={styles.bigStatusTitle}>Online{runtime.version ? ` · v${runtime.version}` : ''}</p>
              <p className={styles.bigStatusSub}>
                <code>{apiBase()}</code>
              </p>
            </div>
          </div>
        )}
        <dl className={styles.kv}>
          <div>
            <dt>Claude Code ingest</dt>
            <dd>
              {!online ? (
                checking
              ) : ingest?.claudeCode ? (
                <Chip tone="ok" icon="check">
                  ready · protocol {ingest.claudeCode.protocol}
                </Chip>
              ) : ingest ? (
                <Chip icon="slash">turned off (RUNLOOP_TRACE=off)</Chip>
              ) : (
                <Chip icon="slash">not in this runtime</Chip>
              )}
            </dd>
          </div>
          <div>
            <dt>Live Claude Code sessions</dt>
            <dd>{online ? runtime.tracedRunIds.length : checking}</dd>
          </div>
          <div>
            <dt>Last Claude Code event</dt>
            <dd>{!online ? checking : lastTraced ? `${formatAgo(Math.max(0, Date.now() - Date.parse(lastTraced)))} ago · ${formatWhen(lastTraced)}` : <span className={styles.none}>none recorded yet</span>}</dd>
          </div>
          <div>
            <dt>Demo run in progress</dt>
            <dd>
              {!online ? (
                checking
              ) : runtime.activeRunId ? (
                <button
                  type="button"
                  className={styles.rowLink}
                  onClick={() => {
                    selectRun(store, runtime.activeRunId!);
                    router.push(ROUTES.world);
                  }}
                >
                  Watch it
                </button>
              ) : (
                'none'
              )}
            </dd>
          </div>
          <div>
            <dt>Runs recorded</dt>
            <dd>{online ? `${runs.length} · ${tracedCount} traced, ${runs.length - tracedCount} executed` : checking}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

/** When the checklist is done or hidden: the two ways to get a run. */
function QuickStart() {
  const demo = useStartDemo();
  return (
    <Card title="Start a run" subtitle="Trace your own Claude Code sessions, or run the scripted demo">
      <div className={styles.cardBody}>
        <div className={styles.grid2}>
          <div className={styles.option}>
            <span className={styles.optionHead}>
              <Icon name="eye" size={16} /> Trace Claude Code
            </span>
            <p className={styles.cardText}>Use Claude Code as normal with the plugin installed. Runloop records what it reports and never runs or approves anything.</p>
            <div className={styles.cardActions}>
              <ButtonLink href={ROUTES.integrations} size="sm" icon="integrations">
                Connect Claude Code
              </ButtonLink>
            </div>
          </div>
          <div className={styles.option}>
            <span className={styles.optionHead}>
              <Icon name="terminal" size={16} /> Demo mission
            </span>
            <p className={styles.cardText}>A scripted agent, real tools: the runtime edits files and runs a real test suite. Labelled Executed.</p>
            <div className={styles.cardActions}>
              <Button size="sm" variant="primary" icon="play" onClick={() => void demo.start()} busy={demo.starting} disabled={demo.disabledReason !== null} title={demo.disabledReason ?? undefined}>
                Run demo mission
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

const STEP_TITLE: Record<OnboardingStep, string> = {
  demo: 'Run the demo mission',
  connect: 'Connect Claude Code',
  open: 'Open a run',
  failure: 'Inspect a failure',
  replay: 'Replay a moment',
};

/** Getting started: teaches run demo → connect Claude Code → open a run → inspect a failure → replay. */
function Checklist({ done, onOpen }: { done: Record<OnboardingStep, boolean>; onOpen: (id: string, route?: string) => void }) {
  const store = useStudioStore();
  const runs = useStudio((s) => s.runs);
  const ingest = useStudio((s) => s.runtime.ingest);
  const demo = useStartDemo();
  const next = nextStep(done);
  const count = ONBOARDING_STEPS.filter((s) => done[s]).length;
  const cmds = connectCommands(apiBase());
  const newest = runs[0];
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);

  const body: Record<OnboardingStep, ReactNode> = {
    demo: (
      <>
        <p className={styles.cardText}>A scripted agent edits files and runs a real test suite in a throwaway copy of a small repository. Two tests fail, then the fix makes them pass.</p>
        <div className={styles.cardActions}>
          <Button size="sm" variant="primary" icon="play" onClick={() => void demo.start()} busy={demo.starting} disabled={demo.disabledReason !== null} title={demo.disabledReason ?? undefined}>
            Run demo mission
          </Button>
        </div>
      </>
    ),
    connect: (
      <>
        <p className={styles.cardText}>
          Start Claude Code with the Runloop plugin, from the root of your Runloop checkout. Your next prompt appears under Live sessions.
          {ingest && !ingest.claudeCode && ' This runtime has Claude Code ingest turned off; restart it without RUNLOOP_TRACE=off.'}
        </p>
        <CommandSnippet command={cmds.claude} />
        <div className={styles.cardActions}>
          <ButtonLink href={ROUTES.integrations} size="sm" variant="ghost" icon="integrations">
            Marketplace install, doctor and privacy
          </ButtonLink>
        </div>
      </>
    ),
    open: (
      <>
        <p className={styles.cardText}>Watch a run in the Live World: robots for each agent, stations for each kind of tool call, and the timeline beside them.</p>
        {newest && (
          <div className={styles.cardActions}>
            <Button size="sm" variant="primary" icon="world" onClick={() => onOpen(newest.runId)}>
              Open the newest run
            </Button>
          </div>
        )}
      </>
    ),
    failure: (
      <>
        <p className={styles.cardText}>
          In Traces, select a red row (a failing test run, a tool error) to see the exact call, its reported output and what caused it. Or press <Kbd keys={[mod, 'K']} /> and choose “Jump to the next failure”.
        </p>
        {newest && (
          <div className={styles.cardActions}>
            <Button
              size="sm"
              variant="primary"
              icon="traces"
              onClick={() => {
                store.getState().setFilter({ text: '', agents: [], tools: [], categories: [], statuses: ['error'], types: [] });
                onOpen(newest.runId, ROUTES.traces);
              }}
            >
              Show failures in the newest run
            </Button>
          </div>
        )}
      </>
    ),
    replay: (
      <p className={styles.cardText}>
        Drag the scrubber or press <Kbd keys={['Space']} /> to replay from the start; <Kbd keys={['←']} /> and <Kbd keys={['→']} /> step event by event. The world, timeline and inspector show exactly the recorded state; nothing is re-executed.
      </p>
    ),
  };

  return (
    <Card
      title="Get started"
      subtitle={`${count} of ${ONBOARDING_STEPS.length} done`}
      actions={
        <Button size="sm" variant="ghost" onClick={() => store.getState().setOnboarding({ dismissed: true })} title="Hide the checklist (kept hidden in this browser)">
          Hide
        </Button>
      }
    >
      <div className={styles.cardBody}>
        <div className={styles.progress} role="progressbar" aria-label="Getting started" aria-valuemin={0} aria-valuemax={ONBOARDING_STEPS.length} aria-valuenow={count}>
          <span style={{ width: `${(count / ONBOARDING_STEPS.length) * 100}%` }} />
        </div>
        <ol className={styles.checklist}>
          {ONBOARDING_STEPS.map((step, i) => {
            const isDone = done[step];
            const current = step === next;
            return (
              <li key={step} className={styles.check} data-done={isDone || undefined} data-current={current || undefined}>
                <span className={styles.checkMark} aria-hidden="true">
                  {isDone ? <Icon name="check" size={13} /> : i + 1}
                </span>
                <div className={styles.checkBody}>
                  <span className={styles.checkTitle}>
                    {STEP_TITLE[step]}
                    <span className="sr-only">{isDone ? ' (done)' : current ? ' (next)' : ''}</span>
                  </span>
                  {current && body[step]}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}
