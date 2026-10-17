'use client';
import type { ToolCategory } from '@runloop-world/events';
import { useMemo, type ReactNode } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { EMPTY_FILTER } from '../state/filters';
import { CATEGORY_ICON, categoryLabel, formatInt, formatTokens, usageParts } from '../state/labels';
import { computeRunMetrics, type CountRow, type RunMetrics as Metrics } from '../state/metrics';
import { formatDuration } from '../state/timeline';
import { agentLook } from '../state/view';
import { AgentDot, Chip } from '../ui/Chip';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState, SkeletonRows } from '../ui/States';
import styles from './RunMetrics.module.css';

const NotReported = ({ why }: { why?: string }) => (
  <span className={styles.none} title={why}>
    not reported
  </span>
);

function Tile({
  label,
  icon,
  tone,
  value,
  sub,
  action,
}: {
  label: string;
  icon: IconName;
  tone?: 'ok' | 'err' | 'warn';
  value: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.tile}>
      <dt className={styles.tileLabel}>
        <Icon name={icon} size={13} />
        {label}
      </dt>
      <dd className={styles.tileValue} data-tone={tone}>
        {value}
      </dd>
      {sub && <dd className={styles.tileSub}>{sub}</dd>}
      {action && <dd className={styles.tileAction}>{action}</dd>}
    </div>
  );
}

/** Counts as a labelled bar list: every value is printed, the bar only helps compare. */
function Bars({ rows, label, iconOf, nameOf, onPick }: { rows: CountRow[]; label: string; iconOf?: (k: string) => IconName; nameOf: (k: string) => string; onPick?: (k: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className={styles.bars} aria-label={label}>
      {rows.map((r) => {
        const body = (
          <>
            <span className={styles.barLabel}>
              {iconOf && <Icon name={iconOf(r.key)} size={13} />}
              {nameOf(r.key)}
            </span>
            <span className={styles.barTrack} aria-hidden="true">
              <span className={styles.barFill} style={{ width: `${(r.count / max) * 100}%` }} />
            </span>
            <span className={styles.barCount}>{r.count}</span>
            <span className={styles.barErrors} data-some={r.errors > 0 || undefined}>
              {r.errors > 0 ? (
                <>
                  <Icon name="x" size={11} />
                  {r.errors} failed
                </>
              ) : (
                'all ok'
              )}
            </span>
          </>
        );
        const title = `${nameOf(r.key)}: ${r.count} call${r.count === 1 ? '' : 's'}, ${r.errors} failed`;
        return (
          <li key={r.key}>
            {onPick ? (
              <button type="button" className={styles.barRow} title={`${title}. Show them in the timeline.`} onClick={() => onPick(r.key)}>
                {body}
              </button>
            ) : (
              <div className={styles.barRow} title={title}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Run metrics (D8): duration, tool calls by category, failures, tests,
 * tokens and model per agent where reported, permission waits. Every value
 * comes from recorded events (state/metrics.ts); what the source did not
 * report reads "not reported", never 0.
 */
export default function RunMetrics({ variant = 'full', onShowTimeline }: { variant?: 'full' | 'compact'; onShowTimeline?: () => void }) {
  const store = useStudioStore();
  const lastSequence = useStudio((s) => s.lastSequence);
  const conn = useStudio((s) => s.conn);
  const runId = useStudio((s) => s.runId);
  const world = useStudio((s) => s.world);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
  const m: Metrics = useMemo(() => computeRunMetrics(exec, store.getState().events()), [exec, store]);
  const s = store.getState();
  const compact = variant === 'compact';

  if (!runId) {
    return (
      <EmptyState compact icon="pulse" title="No run open">
        <p>Open a run to see its metrics.</p>
      </EmptyState>
    );
  }
  if (lastSequence === 0) {
    if (conn === 'loading') return <SkeletonRows rows={4} label="Loading the run metrics" />;
    return (
      <EmptyState compact icon="pulse" title="No events recorded yet">
        <p>Metrics appear with the run’s first events.</p>
      </EmptyState>
    );
  }

  const pickCategory = (k: string) => {
    s.setFilter({ ...EMPTY_FILTER, categories: [k] });
    onShowTimeline?.();
  };
  const pickTool = (k: string) => {
    s.setFilter({ ...EMPTY_FILTER, tools: [k] });
    onShowTimeline?.();
  };
  const claudeCode = exec.run.source?.kind === 'claude-code';
  const c = m.calls;
  const callParts = [
    `${c.success} ok`,
    c.error ? `${c.error} error` : null,
    c.couldNotRun ? `${c.couldNotRun} could not run` : null,
    c.running ? `${c.running} running` : null,
    c.inferred ? `${c.inferred} inferred` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const p = m.permissions;
  const tests = m.tests;

  return (
    <div className={styles.metrics} data-variant={variant}>
      <p className={styles.note}>
        Totals for the whole run{m.duration?.running ? ' so far' : ''}, from {formatInt(m.events)} recorded events. Values the source did not report say “not reported”, never 0.
      </p>

      <dl className={styles.tiles}>
        <Tile
          label="Duration"
          icon="clock"
          value={m.duration ? formatDuration(m.duration.ms) : <NotReported why="The run has not started yet" />}
          sub={m.duration?.running ? 'to the last event · still recording' : m.duration ? 'start to end' : undefined}
        />
        <Tile label="Tool calls" icon="terminal" value={c.total} sub={c.total ? callParts : 'none recorded'} />
        <Tile
          label="Failures"
          icon="alert"
          tone={m.failures.open > 0 ? 'err' : undefined}
          value={m.failures.total}
          sub={
            m.failures.total === 0
              ? 'none recorded'
              : m.failures.open > 0
                ? `${m.failures.open} still open`
                : m.failures.resolvedByLaterSuccess === m.failures.total
                  ? 'each followed by a successful retry (inferred)'
                  : m.failures.resolvedByLaterSuccess > 0
                    ? 'all resolved (some inferred from a later success)'
                    : 'all in tasks that later finished'
          }
          action={
            m.failures.firstSeq !== null ? (
              <button type="button" className={styles.link} onClick={() => s.selectEvent(m.failures.firstSeq!, { seek: true })}>
                Jump to the first
              </button>
            ) : undefined
          }
        />
        <Tile
          label="Tests"
          icon="flask"
          tone={tests ? (tests.latest.failed > 0 ? 'err' : 'ok') : undefined}
          value={
            tests ? (
              <span className={styles.inline}>
                <Icon name={tests.latest.failed > 0 ? 'x' : 'check'} size={14} />
                {tests.latest.passed}/{tests.latest.tests}
              </span>
            ) : (
              <NotReported why="No tool call reported test counts" />
            )
          }
          sub={
            tests
              ? `${tests.latest.failed > 0 ? `${tests.latest.failed} failing` : 'passed'} in the latest of ${tests.runs} test run${tests.runs === 1 ? '' : 's'}${tests.failingRuns ? ` · ${tests.failingRuns} with failures` : ''}`
              : 'no test counts in any result'
          }
          action={
            tests ? (
              <button type="button" className={styles.link} onClick={() => s.selectEvent(tests.latest.seq, { seek: true })}>
                Open the latest run
              </button>
            ) : undefined
          }
        />
        <Tile
          label="Tokens"
          icon="coins"
          value={m.usage.reportedTotal !== null ? formatTokens(m.usage.reportedTotal) : <NotReported />}
          sub={
            m.usage.reportedTotal !== null
              ? `reported for ${m.usage.reportedAgents} of ${m.usage.agents.length} agents`
              : m.usage.agents.length
                ? 'no agent reported usage'
                : undefined
          }
        />
        <Tile label="Cost" icon="database" value={<NotReported why="No source reports cost" />} sub="no source reports cost" />
        <Tile
          label="Permissions"
          icon="lock"
          tone={p.pending > 0 ? 'warn' : undefined}
          value={p.requested}
          sub={
            p.requested === 0
              ? 'none requested'
              : [p.approved ? `${p.approved} approved` : null, p.denied ? `${p.denied} denied` : null, p.pending ? `${p.pending} waiting` : null, p.inferred ? `${p.inferred} inferred` : null]
                  .filter(Boolean)
                  .join(' · ')
          }
        />
        {!compact && (
          <Tile
            label="Permission waits"
            icon="hourglass"
            value={p.waits ? formatDuration(p.waits.totalMs) : p.requested ? <NotReported why="Only inferred answers: their time is when Runloop closed them" /> : '—'}
            sub={
              p.waits
                ? `${p.waits.count} answered · longest ${formatDuration(p.waits.longestMs)}`
                : p.inferred
                  ? 'answers were inferred, so no real wait time'
                  : p.requested
                    ? 'no answer recorded yet'
                    : 'none requested'
            }
          />
        )}
        {m.turns !== null && <Tile label="Turns" icon="message" value={m.turns} sub={m.delegations ? `${m.delegations} delegated to subagents` : 'no subagents'} />}
      </dl>

      <section className={styles.section} aria-labelledby="metrics-categories">
        <h3 id="metrics-categories" className={styles.h3}>
          Tool calls by category
        </h3>
        {c.byCategory.length > 0 ? (
          <>
            <Bars rows={c.byCategory} label="Tool calls by category" iconOf={(k) => CATEGORY_ICON[k as ToolCategory] ?? 'dot'} nameOf={categoryLabel} onPick={pickCategory} />
            {c.categorised < c.total && <p className={styles.foot}>{c.total - c.categorised} calls have no category.</p>}
          </>
        ) : (
          <p className={styles.muted}>{c.total ? 'This run’s source does not categorise its tool calls; see the calls by tool below.' : 'No tool calls recorded.'}</p>
        )}
      </section>

      {(!compact || c.byCategory.length === 0) && c.byTool.length > 0 && (
        <section className={styles.section} aria-labelledby="metrics-tools">
          <h3 id="metrics-tools" className={styles.h3}>
            Tool calls by tool
          </h3>
          <Bars rows={c.byTool.slice(0, 10)} label="Tool calls by tool" nameOf={(k) => k} onPick={pickTool} />
          {c.byTool.length > 10 && <p className={styles.foot}>{c.byTool.length - 10} more tools.</p>}
        </section>
      )}

      <section className={styles.section} aria-labelledby="metrics-usage">
        <h3 id="metrics-usage" className={styles.h3}>
          Tokens and model per agent
        </h3>
        {m.usage.agents.length === 0 ? (
          <p className={styles.muted}>No agents registered yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Model</th>
                  <th scope="col" className={styles.right}>
                    Tokens
                  </th>
                  {!compact && <th scope="col">Breakdown</th>}
                  {!compact && <th scope="col">Reported by</th>}
                </tr>
              </thead>
              <tbody>
                {m.usage.agents.map((a) => {
                  const look = agentLook(exec, world, a.agentId);
                  return (
                    <tr key={a.agentId}>
                      <th scope="row">
                        <button type="button" className={styles.agent} onClick={() => s.selectAgent(a.agentId)}>
                          <AgentDot color={look.color} />
                          {a.name}
                        </button>
                      </th>
                      <td>{a.model ? <code title={a.model}>{a.model}</code> : <NotReported />}</td>
                      <td className={styles.right}>{a.totalTokens !== null ? <span title={formatInt(a.totalTokens)}>{formatTokens(a.totalTokens)}</span> : <NotReported />}</td>
                      {!compact && <td className={`${styles.muted} ${styles.wrap}`}>{a.usage ? usageParts(a.usage) : '—'}</td>}
                      {!compact && (
                        <td>
                          {a.reportedBy ? (
                            <Chip icon="eye" tone="info" title={a.reportedBy}>
                              {claudeCode ? 'Claude Code' : 'reported'}
                            </Chip>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {claudeCode && m.usage.agents.some((a) => a.totalTokens === null) && (
          <p className={styles.foot}>Claude Code reports usage for subagents only, in the Agent tool result. Its hooks do not report the main agent’s tokens.</p>
        )}
      </section>
    </div>
  );
}
