'use client';
import { diffRuns, type AgentDiff, type CountEntry, type DiffNote, type DigestCall, type FieldDiff, type FileTouch, type KeyedCountDiff, type RunDiff, type RunDigest, type TestChange } from '@runloop-world/core';
import type { RunSummary } from '@runloop-world/events';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { compareHref, isPinned, parseComparePair, pinnedRuns, resolvePair, type ComparePair } from '../../state/baselines';
import { CHANGE, changeView, noteText, outcomeChange, outcomeText, SIDE_LETTER, SIDE_NAME, type ChangeView, type Side } from '../../state/compare';
import { useStudio, useStudioStore } from '../../state/context';
import { ROUTES, linkTo } from '../../state/deeplink';
import { EMPTY_FILTER, type TraceFilter } from '../../state/filters';
import { formatWhen, runNumber } from '../../state/format';
import { selectRun } from '../../state/hooks';
import { CATEGORY_ICON, categoryLabel, formatInt, formatTokens, shortModel } from '../../state/labels';
import { isTracedRun, runSourceLabel, runSubtitle } from '../../state/runs';
import { formatDuration } from '../../state/timeline';
import { callStatusView, runStatusView } from '../../state/view';
import { Button, ButtonLink } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chip, StatusBadge } from '../../ui/Chip';
import { Icon, type IconName } from '../../ui/Icon';
import { EmptyState, ErrorState, Skeleton } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { PinButton } from '../Baseline';
import { OfflineState } from '../RunStates';
import { useRunDigest, type DigestLoad } from '../useRunDigest';
import { useStartDemo } from '../useStartDemo';
import pages from './Pages.module.css';
import styles from './Experiments.module.css';

/**
 * Experiments (Milestone C): pin a baseline, run the agent again, compare.
 * Both runs are loaded from the event API and folded with core; the diff is
 * core's `diffRuns`. Test runs, failures, files, categories, usage reports
 * and the divergence link to the events behind them.
 */
export default function ExperimentsPage() {
  const runtime = useStudio((s) => s.runtime.status);
  const runs = useStudio((s) => s.runs);
  const [requested, setRequested] = useState<ComparePair | null>(null);
  const [retry, setRetry] = useState({ a: 0, b: 0 });

  // The deep link (?a=&b=) is read once; picks after that are explicit.
  useEffect(() => setRequested(parseComparePair(new URLSearchParams(window.location.search))), []);
  const ready = requested !== null && runtime === 'online';
  const pair = useMemo(() => (ready ? resolvePair(runs, requested) : { a: null, b: null }), [ready, runs, requested]);

  // Keep the URL on the pair being shown, so a reload or a shared link restores it.
  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    for (const side of ['a', 'b'] as const) {
      if (pair[side]) url.searchParams.set(side, pair[side]);
      else url.searchParams.delete(side);
    }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [ready, pair]);

  const runA = runs.find((r) => r.runId === pair.a) ?? null;
  const runB = runs.find((r) => r.runId === pair.b) ?? null;
  const loadA = useRunDigest(runA, retry.a);
  const loadB = useRunDigest(runB, retry.b);
  const diff = useMemo(() => (loadA.digest && loadB.digest ? diffRuns(loadA.digest, loadB.digest) : null), [loadA.digest, loadB.digest]);

  const pick = (side: Side, runId: string) => setRequested({ ...pair, [side]: runId || null });
  const swap = () => setRequested({ a: pair.b, b: pair.a });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ tone: 'ok', title: 'Link copied', description: 'It opens this comparison on any Studio connected to this runtime.' });
    } catch {
      toast({ tone: 'err', title: 'Could not copy the link', description: 'Copy it from the address bar instead.' });
    }
  };

  return (
    <div className={pages.page}>
      <div className={`${pages.pageInner} ${styles.inner}`}>
        <header className={pages.pageHead}>
          <div>
            <h1 className={pages.h1}>Experiments</h1>
            <p className={pages.lede}>Compare a baseline with a candidate run: outcome, tests, files, tool activity, tokens and permissions, and the first moment they diverged. Underlined values open the event behind them in Traces.</p>
          </div>
          {ready && pair.a && pair.b && (
            <Button size="sm" variant="ghost" icon="link" onClick={() => void copyLink()}>
              Copy link
            </Button>
          )}
        </header>

        {runtime === 'offline' ? (
          <Card>
            <OfflineState />
          </Card>
        ) : !ready ? (
          <LoadingCompare />
        ) : runs.length === 0 ? (
          <Card>
            <NothingYet />
          </Card>
        ) : (
          <>
            <section className={styles.pickers} aria-label="Runs to compare">
              <SidePicker side="a" runs={runs} value={pair.a} run={runA} load={loadA} onPick={(id) => pick('a', id)} />
              <div className={styles.swap}>
                <Button variant="secondary" size="sm" iconOnly icon="swap" aria-label="Swap baseline and candidate" title="Swap baseline and candidate" onClick={swap} disabled={!pair.a && !pair.b} />
              </div>
              <SidePicker side="b" runs={runs} value={pair.b} run={runB} load={loadB} onPick={(id) => pick('b', id)} />
            </section>

            {!pair.a || !pair.b ? (
              <Card>
                <TeachCompare runs={runs} pair={pair} />
              </Card>
            ) : !runA || !runB ? (
              <Card>
                <ErrorState title="A run in this link is not in this runtime" saved="Nothing was changed. Choose another run above.">
                  <p>
                    {!runA ? 'The baseline' : 'The candidate'} (<code>{(!runA ? pair.a : pair.b)!.slice(0, 8)}</code>) was not found. It may have been recorded by another runtime or data directory.
                  </p>
                </ErrorState>
              </Card>
            ) : loadA.status === 'error' || loadB.status === 'error' ? (
              <Card>
                <ErrorState
                  title={`Could not load the ${loadA.status === 'error' ? 'baseline' : 'candidate'}’s events`}
                  saved="Both runs are still recorded; nothing was changed."
                  onRetry={() => setRetry((r) => (loadA.status === 'error' ? { ...r, a: r.a + 1 } : { ...r, b: r.b + 1 }))}
                >
                  <p>{loadA.status === 'error' ? loadA.error : loadB.error}</p>
                </ErrorState>
              </Card>
            ) : !diff ? (
              <LoadingCompare pickersShown />
            ) : (
              <Comparison diff={diff} runA={runA} runB={runB} partial={(loadA.status === 'ready' && loadA.partial) || (loadB.status === 'ready' && loadB.partial)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── navigation to events ───────────────────────────────────────────────

/** Open a run in Traces at an event (or with a filter). Modified clicks keep the link's default (a new tab). */
function useOpenInTraces() {
  const store = useStudioStore();
  const router = useRouter();
  return (e: MouseEvent, runId: string, opts: { seq?: number; filter?: TraceFilter }) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    selectRun(store, runId);
    const s = store.getState();
    s.setFilter(opts.filter ?? EMPTY_FILTER);
    s.setTab('timeline');
    if (opts.seq !== undefined) s.focusDeepLink({ seq: opts.seq, agentId: null });
    router.push(ROUTES.traces);
  };
}

/** A link to one event of a run in Traces. */
function EventLink({ runId, seq, children, label }: { runId: string; seq: number; children?: ReactNode; label?: string }) {
  const open = useOpenInTraces();
  return (
    <a href={linkTo(ROUTES.traces, { runId, seq })} className={styles.eventLink} onClick={(e) => open(e, runId, { seq })} aria-label={label} title={label ?? `Open event #${seq} in Traces`}>
      {children ?? `#${seq}`}
    </a>
  );
}

// ── pickers ────────────────────────────────────────────────────────────

function SideTag({ side }: { side: Side }) {
  return (
    <span className={styles.sideTag} data-side={side} aria-hidden="true">
      {SIDE_LETTER[side]}
    </span>
  );
}

function optionText(runs: readonly RunSummary[], r: RunSummary): string {
  const n = runNumber(runs, r.runId);
  // Traced titles already name the project ("Claude Code · repo"); the subtitle starts with it too.
  const project = r.source?.projectLabel;
  const full = runSubtitle(r);
  const sub = full && project && r.title.endsWith(project) && full.startsWith(`${project} · `) ? full.slice(project.length + 3) : full;
  const status = runStatusView(r.status, r.paused, isTracedRun(r)).text;
  return `#${n} · ${r.title}${sub ? ` · ${sub}` : ''} · ${formatWhen(r.createdAt)} · ${status}`;
}

function SidePicker({ side, runs, value, run, load, onPick }: { side: Side; runs: RunSummary[]; value: string | null; run: RunSummary | null; load: DigestLoad; onPick: (runId: string) => void }) {
  const id = `compare-${side}`;
  const pinned = pinnedRuns(runs);
  const others = runs.filter((r) => !isPinned(r));
  const unknown = value !== null && !run;
  return (
    <div className={styles.picker} data-side={side}>
      <div className={styles.pickerHead}>
        <SideTag side={side} />
        <label htmlFor={id} className={styles.pickerLabel}>
          {SIDE_NAME[side]}
        </label>
        <span className={styles.pickerHint}>{side === 'a' ? 'what you compare against' : 'the run you want to judge'}</span>
      </div>
      <div className={styles.selectWrap}>
        <select id={id} className={styles.select} value={value ?? ''} onChange={(e) => onPick(e.target.value)}>
          <option value="" disabled>
            Choose a run…
          </option>
          {unknown && <option value={value!}>Unknown run {value!.slice(0, 8)}</option>}
          {pinned.length > 0 && (
            <optgroup label="Baselines (pinned)">
              {pinned.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {optionText(runs, r)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={pinned.length > 0 ? 'Other runs' : 'Runs'}>
            {others.map((r) => (
              <option key={r.runId} value={r.runId}>
                {optionText(runs, r)}
              </option>
            ))}
          </optgroup>
        </select>
        <Icon name="chevronDown" size={14} className={styles.selectIcon} />
      </div>
      {run ? <RunFacts run={run} load={load} /> : <p className={styles.pickerEmpty}>{unknown ? 'This run is not in this runtime.' : side === 'a' ? 'No baseline yet: pin a run, or choose any run here.' : 'Choose the run to compare.'}</p>}
    </div>
  );
}

function RunFacts({ run, load }: { run: RunSummary; load: DigestLoad }) {
  const traced = isTracedRun(run);
  const d = load.digest;
  const open = useOpenInTraces();
  return (
    <div className={styles.facts}>
      <div className={styles.factChips}>
        <StatusBadge view={runStatusView(run.status, run.paused, traced)} />
        <Chip tone={traced ? 'info' : 'muted'} icon={traced ? 'eye' : 'terminal'} title={traced ? 'Recorded from what Claude Code reported; Runloop did not run or verify it' : 'Runloop’s runtime ran the tools itself'}>
          {runSourceLabel(run)}
        </Chip>
      </div>
      <p className={styles.factLine}>
        started {formatWhen(run.createdAt)} · {formatInt(run.lastSequence)} events
        {d?.durationMs != null ? ` · ${formatDuration(d.durationMs)}` : run.status === 'running' ? ' · still recording' : ''}
        {d?.speed != null ? ` · demo pace ${d.speed}×` : ''}
      </p>
      <div className={styles.factActions}>
        <a href={linkTo(ROUTES.traces, { runId: run.runId })} className={styles.factLink} onClick={(e) => open(e, run.runId, {})}>
          <Icon name="traces" size={13} /> Open in Traces
        </a>
        <PinButton run={run} />
      </div>
    </div>
  );
}

// ── states ─────────────────────────────────────────────────────────────

function LoadingCompare({ pickersShown }: { pickersShown?: boolean }) {
  return (
    <div className={styles.loading} role="status" aria-busy="true" aria-label="Loading both runs">
      {!pickersShown && (
        <div className={styles.pickers}>
          <Skeleton height={132} radius={12} />
          <span />
          <Skeleton height={132} radius={12} />
        </div>
      )}
      <div className={styles.verdict}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={104} radius={10} />
        ))}
      </div>
      <Skeleton height={168} radius={12} />
    </div>
  );
}

const STEPS = [
  { title: 'Pin a run', body: 'Pin the run you trust as a baseline: from its header, the run history, or the picker above.' },
  { title: 'Run your agent again', body: 'Change one thing (CLAUDE.md, a skill, a model, a hook) and run the same task again with Claude Code, or rerun the demo.' },
  { title: 'Compare', body: 'Pick the new run as the candidate. Experiments shows what differed, with a link to every event behind it.' },
] as const;

/** The empty state that teaches the loop: pin, run again, compare. */
function TeachCompare({ runs, pair }: { runs: RunSummary[]; pair: ComparePair }) {
  const demo = useStartDemo();
  const pinned = pinnedRuns(runs);
  const newestBase = pinned[0];
  const runAgain = newestBase ? runs.some((r) => r.runId !== newestBase.runId && Date.parse(r.createdAt) > Date.parse(newestBase.pinnedAt!)) : false;
  // Step 2 is done only by a run recorded after the baseline was pinned (not by the picker's default).
  const done = [pinned.length > 0 || pair.a !== null, runAgain, false];
  const current = done.findIndex((d) => !d);
  const candidate = runs.find((r) => r.status !== 'running') ?? runs[0];
  return (
    <div className={styles.teach}>
      <div className={styles.teachHead}>
        <span className={styles.teachIcon} aria-hidden="true">
          <Icon name="compare" size={22} />
        </span>
        <div>
          <h2 className={styles.teachTitle}>Pin a run, run your agent again, compare</h2>
          <p className={styles.teachText}>A comparison needs two runs of the same task: a baseline you trust and a candidate made after a change.</p>
        </div>
      </div>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={step.title} className={styles.step} data-done={done[i] || undefined} data-current={i === current || undefined}>
            <span className={styles.stepMark} aria-hidden="true">
              {done[i] ? <Icon name="check" size={13} /> : i + 1}
            </span>
            <div className={styles.stepBody}>
              <span className={styles.stepTitle}>
                {step.title}
                <span className="sr-only">{done[i] ? ' (done)' : i === current ? ' (next)' : ''}</span>
              </span>
              <p className={styles.stepText}>{step.body}</p>
              {i === current && i === 0 && candidate && (
                <div className={styles.stepActions}>
                  <PinButton run={candidate} variant="primary" />
                  <span className={styles.stepNote}>
                    #{runNumber(runs, candidate.runId)} · {candidate.title}
                  </span>
                </div>
              )}
              {i === current && i === 1 && (
                <div className={styles.stepActions}>
                  <Button size="sm" variant="primary" icon="play" onClick={() => void demo.start()} busy={demo.starting} disabled={demo.disabledReason !== null} title={demo.disabledReason ?? undefined}>
                    Run demo mission
                  </Button>
                  <ButtonLink href={ROUTES.integrations} size="sm" variant="ghost" icon="integrations">
                    Trace Claude Code
                  </ButtonLink>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NothingYet() {
  const demo = useStartDemo();
  return (
    <EmptyState
      icon="compare"
      title="Nothing to compare yet"
      actions={
        <>
          <Button variant="primary" icon="play" onClick={() => void demo.start()} busy={demo.starting} disabled={demo.disabledReason !== null} title={demo.disabledReason ?? undefined}>
            Run demo mission
          </Button>
          <ButtonLink href={ROUTES.integrations} variant="ghost" icon="integrations">
            Connect Claude Code
          </ButtonLink>
        </>
      }
    >
      <p>Pin a run, run your agent again, compare. Record a first run to start: trace a Claude Code session or run the scripted demo.</p>
    </EmptyState>
  );
}

// ── the comparison ─────────────────────────────────────────────────────

const NotReported = ({ why }: { why?: string }) => (
  <span className={styles.none} title={why}>
    not reported
  </span>
);

function ChangeChip({ view, showDetail = true }: { view: ChangeView; showDetail?: boolean }) {
  return (
    <span className={styles.changeCell}>
      <span className={styles.change} data-tone={view.tone} title={view.detail ?? undefined}>
        <Icon name={view.icon} size={12} />
        {view.text}
      </span>
      {showDetail && view.detail && <span className={styles.changeDetail}>{view.detail}</span>}
    </span>
  );
}

function Comparison({ diff, runA, runB, partial }: { diff: RunDiff; runA: RunSummary; runB: RunSummary; partial: boolean }) {
  const ids: Record<Side, string> = { a: runA.runId, b: runB.runId };
  const traced: [boolean, boolean] = [diff.a.mode === 'traced', diff.b.mode === 'traced'];
  return (
    <>
      <Callouts diff={diff} partial={partial} />
      <Verdict diff={diff} ids={ids} traced={traced} />
      <DivergenceCard diff={diff} ids={ids} />
      <div className={styles.grid2}>
        <OutcomeTests diff={diff} ids={ids} traced={traced} />
        <FilesCard diff={diff} ids={ids} />
      </div>
      <div className={styles.grid2}>
        <ToolActivity diff={diff} ids={ids} />
        <div className={styles.stack}>
          <TokensCard diff={diff} ids={ids} />
          <PermissionsCard diff={diff} ids={ids} />
        </div>
      </div>
    </>
  );
}

function Callouts({ diff, partial }: { diff: RunDiff; partial: boolean }) {
  const notes: { icon: IconName; tone: 'info' | 'warn'; text: ReactNode }[] = [];
  if (diff.sameRun) notes.push({ icon: 'alert', tone: 'warn', text: 'Both sides are the same run, so nothing differs. Choose another candidate.' });
  if (!diff.sameMode) {
    const exec = diff.a.mode === 'executed' ? 'baseline' : 'candidate';
    notes.push({
      icon: 'eye',
      tone: 'info',
      text: (
        <>
          The {exec} was <strong>executed</strong> by Runloop; the other run was <strong>traced</strong> from what Claude Code reported. Counts come from different instruments, and the executed run’s categories come from Runloop’s own tools.
        </>
      ),
    });
  }
  const running = [!diff.a.ended && 'baseline', !diff.b.ended && 'candidate'].filter(Boolean);
  if (running.length) notes.push({ icon: 'pulse', tone: 'info', text: `The ${running.join(' and the ')} ${running.length > 1 ? 'are' : 'is'} still recording: outcome, duration and files are compared once ${running.length > 1 ? 'they end' : 'it ends'}.` });
  if (partial) notes.push({ icon: 'ellipsis', tone: 'warn', text: 'Some events have not arrived yet; the comparison covers the events received so far.' });
  if (notes.length === 0) return null;
  return (
    <ul className={styles.callouts}>
      {notes.map((n, i) => (
        <li key={i} className={styles.callout} data-tone={n.tone}>
          <Icon name={n.icon} size={15} />
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A summary tile: the candidate's value as the headline, the baseline's as the reference, then the change. */
function Tile({ label, icon, a, b, change, foot }: { label: string; icon: IconName; a: ReactNode; b: ReactNode; change: ChangeView; foot?: ReactNode }) {
  return (
    <div className={styles.tile}>
      <dt className={styles.tileLabel}>
        <Icon name={icon} size={13} />
        {label}
      </dt>
      <dd className={styles.tileMain}>
        <SideTag side="b" />
        <span className="sr-only">Candidate:</span>
        {b}
      </dd>
      <dd className={styles.tileRef}>
        <SideTag side="a" />
        <span className="sr-only">Baseline:</span>
        {a}
      </dd>
      <dd className={styles.tileChange}>
        <ChangeChip view={change} />
      </dd>
      {foot && <dd className={styles.tileFoot}>{foot}</dd>}
    </div>
  );
}

const num = (v: number | null, fmt: (n: number) => string = formatInt) => (v === null ? <NotReported /> : fmt(v));

/** A run's outcome as icon + text ("ended" for a traced session that ended normally). */
function OutcomeBadge({ digest }: { digest: RunDigest }) {
  const traced = digest.mode === 'traced';
  const view = digest.outcome ? runStatusView(digest.outcome, false, traced) : runStatusView('running');
  return <StatusBadge view={{ ...view, text: outcomeText(digest.outcome, traced) }} />;
}

function Verdict({ diff, ids, traced }: { diff: RunDiff; ids: Record<Side, string>; traced: [boolean, boolean] }) {
  const ta = diff.a.tests?.latest ?? null;
  const tb = diff.b.tests?.latest ?? null;
  const testValue = (t: typeof ta, side: Side) =>
    t ? (
      <EventLink runId={ids[side]} seq={t.seq} label={`${SIDE_NAME[side]}: latest test run, ${t.passed} of ${t.tests} passed`}>
        {t.passed}/{t.tests}
      </EventLink>
    ) : (
      <NotReported why="No tool call reported test counts" />
    );
  const outcome = (side: Side) => <OutcomeBadge digest={diff[side]} />;
  return (
    <section aria-label="Summary">
      <dl className={styles.verdict}>
        <Tile label="Outcome" icon="flag" a={outcome('a')} b={outcome('b')} change={outcomeChange(diff.outcome, traced)} />
        <Tile label="Tests passing" icon="flask" a={testValue(ta, 'a')} b={testValue(tb, 'b')} change={changeView(diff.tests.failed, CHANGE.failing)} foot={ta || tb ? 'latest test run' : undefined} />
        <Tile label="Failures" icon="alert" a={formatInt(diff.failures.a!)} b={formatInt(diff.failures.b!)} change={changeView(diff.failures, CHANGE.failures)} />
        <Tile label="Duration" icon="clock" a={num(diff.durationMs.a, formatDuration)} b={num(diff.durationMs.b, formatDuration)} change={changeView(diff.durationMs, CHANGE.duration)} />
        <Tile label="Tool calls" icon="terminal" a={formatInt(diff.toolCalls.a!)} b={formatInt(diff.toolCalls.b!)} change={changeView(diff.toolCalls, CHANGE.toolCalls)} />
        <Tile label="Tokens" icon="coins" a={num(diff.tokens.a, formatTokens)} b={num(diff.tokens.b, formatTokens)} change={changeView(diff.tokens, CHANGE.tokens)} foot={diff.tokens.a !== null || diff.tokens.b !== null ? 'as reported by the source' : undefined} />
      </dl>
    </section>
  );
}

// ── first divergence ───────────────────────────────────────────────────

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

function categoryName(c: DigestCall['category']): string {
  return c === 'uncategorised' ? 'Uncategorised' : categoryLabel(c);
}

function categoryIcon(c: string): IconName {
  return (CATEGORY_ICON as Record<string, IconName>)[c] ?? 'dot';
}

function CallCard({ side, call, runId, total }: { side: Side; call: DigestCall | null; runId: string; total: number }) {
  if (!call) {
    return (
      <div className={styles.callCard} data-side={side} data-missing>
        <div className={styles.callHead}>
          <SideTag side={side} />
          <span className={styles.callSide}>{SIDE_NAME[side]}</span>
        </div>
        <p className={styles.callMissing}>No more calls: the {SIDE_NAME[side].toLowerCase()} made {total} in all.</p>
      </div>
    );
  }
  const status = callStatusView(call.status);
  return (
    <div className={styles.callCard} data-side={side}>
      <div className={styles.callHead}>
        <SideTag side={side} />
        <span className={styles.callSide}>{SIDE_NAME[side]}</span>
        <span className={styles.callIndex}>call {call.index + 1}</span>
      </div>
      <p className={styles.callWhat}>
        <Icon name={categoryIcon(call.category)} size={15} />
        <span className={styles.callTool}>{call.tool}</span>
        {call.target ? <code className={styles.callTarget}>{call.target}</code> : <span className={styles.none}>no target reported</span>}
      </p>
      <div className={styles.callMeta}>
        <Chip icon={categoryIcon(call.category)} title={call.categorySource === 'runtime_tool' ? 'Category of Runloop’s own tool' : undefined}>
          {categoryName(call.category)}
        </Chip>
        <StatusBadge view={status} />
        {call.metrics && (
          <Chip tone={call.metrics.failed > 0 ? 'err' : 'ok'} icon="flask">
            {call.metrics.passed}/{call.metrics.tests} passed
          </Chip>
        )}
      </div>
      <div className={styles.callLinks}>
        <EventLink runId={runId} seq={call.seq} label={`Open the ${SIDE_NAME[side].toLowerCase()}’s call ${call.index + 1} (event #${call.seq}) in Traces`}>
          Open #{call.seq}
        </EventLink>
        {call.endSeq !== null && (
          <EventLink runId={runId} seq={call.endSeq} label={`Open its result (event #${call.endSeq}) in Traces`}>
            result #{call.endSeq}
          </EventLink>
        )}
      </div>
    </div>
  );
}

function DivergenceCard({ diff, ids }: { diff: RunDiff; ids: Record<Side, string> }) {
  const d = diff.firstDivergence;
  // `lead` says what matched before the divergence (nothing when it is the first call); `what` names the divergence.
  const lead = !d || d.index === 0 ? '' : `Both runs made the same ${d.index === 1 ? 'first call' : `first ${d.index} calls`} with the same results. `;
  const more = d?.a ? 'baseline' : 'candidate';
  const what = !d
    ? null
    : d.kind === 'call'
      ? d.index === 0
        ? 'The runs differ from their first tool call.'
        : `The ${ordinal(d.index + 1)} call differs.`
      : d.kind === 'result'
        ? d.index === 0
          ? 'Both runs began with the same call, with a different result.'
          : `The ${ordinal(d.index + 1)} call is the same, with a different result.`
        : d.index === 0
          ? `Only the ${more} made tool calls.`
          : `Then only the ${more} made more calls.`;
  return (
    <Card
      title="First divergence"
      subtitle="Calls compared in order by category, tool and target (where both runs name one), then by result"
      className={styles.card}
      labelledBy="cmp-divergence"
    >
      <div className={styles.cardBody}>
        {!d ? (
          <p className={styles.divergenceLead}>
            <Icon name="checkCircle" size={16} />
            {diff.a.calls.length === 0 ? 'Neither run made a tool call.' : `No divergence: both runs made the same ${diff.a.calls.length} calls with the same results.`}
          </p>
        ) : (
          <>
            <p className={styles.divergenceLead}>
              <Icon name="target" size={16} />
              <span>
                {lead}
                <strong>{what}</strong>
              </span>
            </p>
            <div className={styles.callPair}>
              <CallCard side="a" call={d.a} runId={ids.a} total={diff.a.calls.length} />
              <CallCard side="b" call={d.b} runId={ids.b} total={diff.b.calls.length} />
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ── tables ─────────────────────────────────────────────────────────────

interface Row {
  label: string;
  icon?: IconName;
  a: ReactNode;
  b: ReactNode;
  change: ChangeView | null;
}

function DiffTable({ rows, caption }: { rows: Row[]; caption: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Measure</span>
            </th>
            <th scope="col">
              <span className={styles.colHead}>
                <SideTag side="a" /> <span className={styles.colHeadText}>Baseline</span>
              </span>
            </th>
            <th scope="col">
              <span className={styles.colHead}>
                <SideTag side="b" /> <span className={styles.colHeadText}>Candidate</span>
              </span>
            </th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">
                <span className={styles.rowLabel}>
                  {r.icon && <Icon name={r.icon} size={13} />}
                  {r.label}
                </span>
              </th>
              <td className={styles.numCell}>{r.a}</td>
              <td className={styles.numCell}>{r.b}</td>
              <td>{r.change ? <ChangeChip view={r.change} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A count, linked to an event when one is given. */
function linked(value: ReactNode, runId: string, seq: number | null | undefined, label: string): ReactNode {
  return seq != null ? (
    <EventLink runId={runId} seq={seq} label={label}>
      {value}
    </EventLink>
  ) : (
    value
  );
}

const fieldValue = (f: FieldDiff<number>, side: Side, fmt: (n: number) => string = formatInt) => num(f[side], fmt);

function TestNames({ title, icon, tone, names, ids }: { title: string; icon: IconName; tone: 'ok' | 'err' | 'warn'; names: TestChange[]; ids: Record<Side, string> }) {
  if (names.length === 0) return null;
  return (
    <div className={styles.names}>
      <h3 className={styles.namesTitle} data-tone={tone}>
        <Icon name={icon} size={13} />
        {title}
        <span className={styles.count}>{names.length}</span>
      </h3>
      <ul className={styles.nameList}>
        {names.map((t) => (
          <li key={t.name}>
            <span className={styles.testName}>{t.name}</span>
            <span className={styles.nameLinks}>
              {t.aSeq !== null && <EventLink runId={ids.a} seq={t.aSeq} label={`Baseline’s test run (event #${t.aSeq})`}>A #{t.aSeq}</EventLink>}
              {t.bSeq !== null && <EventLink runId={ids.b} seq={t.bSeq} label={`Candidate’s test run (event #${t.bSeq})`}>B #{t.bSeq}</EventLink>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Why fixed / newly failing tests may be incomplete for a side. */
function namesCaveat(diff: RunDiff, side: Side): string {
  const who = `The ${SIDE_NAME[side].toLowerCase()}`;
  return diff[side].tests === null
    ? `${who} reported no test runs, so fixed and newly failing tests cannot be listed.`
    : `${who}’s latest test run did not name every failing test, so fixed and newly failing tests may be incomplete.`;
}

/** Why "failed along the way, one side only" is not listed (a side's test runs left failures unnamed). */
function alongCaveat(diff: RunDiff, note: DiffNote): string {
  const unnamed = (side: Side) => {
    const runs = diff[side].tests?.runs ?? [];
    const named = runs.reduce((n, r) => n + Math.min(r.failingTests.length, r.failed), 0);
    const failed = runs.reduce((n, r) => n + r.failed, 0);
    return `the ${SIDE_NAME[side].toLowerCase()}’s test runs named ${named} of ${failed} failures`;
  };
  if (note === 'not_reported') return `Tests that failed along the way in one run only cannot be listed: ${unnamed('a')}, and ${unnamed('b')}.`;
  const side: Side = note === 'not_reported_a' ? 'a' : 'b';
  const other = side === 'a' ? 'candidate' : 'baseline';
  return `Tests that failed along the way only in the ${other} cannot be listed: ${unnamed(side)}, so an unnamed one may be the same test.`;
}

function OutcomeTests({ diff, ids, traced }: { diff: RunDiff; ids: Record<Side, string>; traced: [boolean, boolean] }) {
  const t = diff.tests;
  const latest = (side: Side) => diff[side].tests?.latest ?? null;
  const firstFailure = (side: Side) => diff[side].failures.items[0]?.seq ?? null;
  const testCell = (side: Side) => {
    const l = latest(side);
    return l ? linked(`${l.passed}/${l.tests}`, ids[side], l.seq, `${SIDE_NAME[side]}: latest test run`) : <NotReported why="No tool call reported test counts" />;
  };
  const rows: Row[] = [
    { label: 'Outcome', icon: 'flag', a: <OutcomeBadge digest={diff.a} />, b: <OutcomeBadge digest={diff.b} />, change: outcomeChange(diff.outcome, traced) },
    { label: 'Latest test run', icon: 'flask', a: testCell('a'), b: testCell('b'), change: changeView(t.passed, CHANGE.passed) },
    { label: 'Failing tests', icon: 'xCircle', a: fieldValue(t.failed, 'a'), b: fieldValue(t.failed, 'b'), change: changeView(t.failed, CHANGE.failing) },
    { label: 'Test runs', icon: 'refresh', a: fieldValue(t.runs, 'a'), b: fieldValue(t.runs, 'b'), change: changeView(t.runs, CHANGE.testRuns) },
    {
      label: 'Failures',
      icon: 'alert',
      a: linked(formatInt(diff.failures.a!), ids.a, firstFailure('a'), 'Baseline’s first failure'),
      b: linked(formatInt(diff.failures.b!), ids.b, firstFailure('b'), 'Candidate’s first failure'),
      change: changeView(diff.failures, CHANGE.failures),
    },
    { label: 'Failed calls', icon: 'x', a: fieldValue(diff.failedCalls, 'a'), b: fieldValue(diff.failedCalls, 'b'), change: changeView(diff.failedCalls, CHANGE.failedCalls) },
  ];
  const { onlyA, onlyB } = t.failedAlongTheWay;
  const anyTests = diff.a.tests || diff.b.tests;
  return (
    <Card title="Outcome and tests" subtitle="Test counts as the runner reported them; names when it gave them" className={styles.card} labelledBy="cmp-tests">
      <div className={styles.cardBody}>
        <DiffTable rows={rows} caption="Outcome and tests, baseline against candidate" />
        {anyTests && (
          <div className={styles.namesGrid}>
            <TestNames title="Fixed in the candidate" icon="checkCircle" tone="ok" names={t.fixed} ids={ids} />
            <TestNames title="Newly failing" icon="xCircle" tone="err" names={t.newlyFailing} ids={ids} />
            <TestNames title="Still failing" icon="alert" tone="warn" names={t.stillFailing} ids={ids} />
            <TestNames title="Failed along the way, baseline only" icon="refresh" tone="warn" names={onlyA} ids={ids} />
            <TestNames title="Failed along the way, candidate only" icon="refresh" tone="warn" names={onlyB} ids={ids} />
            {t.fixed.length + t.newlyFailing.length + t.stillFailing.length + onlyA.length + onlyB.length === 0 && (
              <p className={styles.muted}>
                <Icon name="check" size={13} /> No failing test names differ between the two runs{t.namesComparable && t.failedAlongTheWay.complete ? '' : ' (as far as names were reported)'}.
              </p>
            )}
            {t.namesNote && t.namesNote !== 'not_reported' && <p className={styles.foot}>{namesCaveat(diff, t.namesNote === 'not_reported_a' ? 'a' : 'b')}</p>}
            {t.failedAlongTheWay.note && <p className={styles.foot}>{alongCaveat(diff, t.failedAlongTheWay.note)}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── files ──────────────────────────────────────────────────────────────

function touchText(f: FileTouch): string {
  const parts = [f.reads ? `read ${f.reads}×` : null, f.writes ? `written ${f.writes}×` : null].filter(Boolean).join(' · ');
  return f.failed ? `${parts} (${f.failed === f.reads + f.writes ? 'failed' : `${f.failed} failed`})` : parts;
}

function FileItem({ f, side, runId }: { f: FileTouch; side: Side; runId: string }) {
  return (
    <li className={styles.file}>
      <span className={styles.fileIcon} data-written={f.writes > 0 || undefined}>
        <Icon name={f.writes > 0 ? 'pencil' : 'file'} size={13} />
      </span>
      <code className={styles.filePath} title={f.path}>
        {f.path}
      </code>
      <span className={styles.fileMeta}>
        {touchText(f)} · <EventLink runId={runId} seq={f.firstWriteSeq ?? f.firstSeq} label={`${SIDE_NAME[side]}: first ${f.writes ? 'write of' : 'read of'} ${f.path}`} />
      </span>
    </li>
  );
}

function FilesCard({ diff, ids }: { diff: RunDiff; ids: Record<Side, string> }) {
  const f = diff.files;
  const total = f.onlyA.length + f.onlyB.length + f.both.length;
  const column = (title: string, side: Side | 'both', body: ReactNode, n: number) => (
    <div className={styles.fileCol}>
      <h3 className={styles.fileColTitle}>
        {side === 'both' ? (
          <span className={styles.bothTags} aria-hidden="true">
            <SideTag side="a" />
            <SideTag side="b" />
          </span>
        ) : (
          <SideTag side={side} />
        )}
        {title}
        <span className={styles.count}>{n}</span>
      </h3>
      {n === 0 ? <p className={styles.muted}>none</p> : <ul className={styles.fileList}>{body}</ul>}
    </div>
  );
  return (
    <Card title="Files" subtitle="Named by read and edit calls; shell commands may touch others" className={styles.card} labelledBy="cmp-files">
      <div className={styles.cardBody}>
        {f.note && (
          <p className={styles.foot}>
            <Icon name="alert" size={13} /> File lists are {f.note.startsWith('running') ? 'not final' : 'incomplete'}: {noteText(f.note)}
            {f.note.startsWith('not_reported') ? ' (some read or edit calls did not name their file, as in logs recorded before targets existed)' : ''}.
          </p>
        )}
        {total === 0 ? (
          <p className={styles.muted}>
            {diff.a.files.untargeted + diff.b.files.untargeted === 0
              ? 'Neither run read or edited a named file.'
              : `No file names to compare: ${diff.a.files.untargeted} read or edit call${diff.a.files.untargeted === 1 ? '' : 's'} in the baseline and ${diff.b.files.untargeted} in the candidate did not name their file.`}
          </p>
        ) : (
          <div className={styles.fileCols}>
            {column('Only in the baseline', 'a', f.onlyA.map((x) => <FileItem key={x.path} f={x} side="a" runId={ids.a} />), f.onlyA.length)}
            {column('In both', 'both', f.both.map((x) => (
              <li key={x.path} className={styles.file}>
                <span className={styles.fileIcon} data-written={x.a!.writes + x.b!.writes > 0 || undefined}>
                  <Icon name={x.a!.writes + x.b!.writes > 0 ? 'pencil' : 'file'} size={13} />
                </span>
                <code className={styles.filePath} title={x.path}>
                  {x.path}
                </code>
                <span className={styles.fileMeta}>
                  <EventLink runId={ids.a} seq={x.a!.firstWriteSeq ?? x.a!.firstSeq} label={`Baseline: ${touchText(x.a!)} (first at #${x.a!.firstSeq})`}>
                    A {touchText(x.a!)}
                  </EventLink>
                  {' · '}
                  <EventLink runId={ids.b} seq={x.b!.firstWriteSeq ?? x.b!.firstSeq} label={`Candidate: ${touchText(x.b!)} (first at #${x.b!.firstSeq})`}>
                    B {touchText(x.b!)}
                  </EventLink>
                </span>
              </li>
            )), f.both.length)}
            {column('Only in the candidate', 'b', f.onlyB.map((x) => <FileItem key={x.path} f={x} side="b" runId={ids.b} />), f.onlyB.length)}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── tool activity ──────────────────────────────────────────────────────

function ToolActivity({ diff, ids }: { diff: RunDiff; ids: Record<Side, string> }) {
  const open = useOpenInTraces();
  const max = Math.max(1, ...diff.categories.map((r) => Math.max(r.count.a ?? 0, r.count.b ?? 0)));
  /** Traced runs filter by category; executed runs (no category on the wire) by the tools of that category. */
  const filterFor = (side: Side, key: string): TraceFilter => {
    const digest: RunDigest = diff[side];
    if (digest.mode === 'traced') return { ...EMPTY_FILTER, categories: [key] };
    return { ...EMPTY_FILTER, tools: [...new Set(digest.calls.filter((c) => c.category === key).map((c) => c.tool))] };
  };
  const bar = (row: KeyedCountDiff, side: Side) => {
    const entry: CountEntry | null = row[side];
    const n = entry?.count ?? 0;
    const label = `${SIDE_NAME[side]}: ${n} ${categoryName(row.key as DigestCall['category']).toLowerCase()} call${n === 1 ? '' : 's'}${entry?.failed ? `, ${entry.failed} failed` : ''}`;
    const inner = (
      <>
        <SideTag side={side} />
        <span className={styles.barTrack} aria-hidden="true">
          <span className={styles.barFill} data-side={side} style={{ '--w': `${(n / max) * 100}%` } as CSSProperties} />
        </span>
        <span className={styles.barCount}>{n}</span>
        <span className={styles.barFailed}>{entry?.failed ? `${entry.failed} failed` : ''}</span>
      </>
    );
    return entry ? (
      <a
        href={linkTo(ROUTES.traces, { runId: ids[side], seq: entry.firstSeq })}
        className={styles.barLine}
        aria-label={`${label}. Show them in Traces`}
        title={`${label}. Show them in Traces`}
        onClick={(e) => open(e, ids[side], { seq: entry.firstSeq, filter: filterFor(side, row.key) })}
      >
        {inner}
      </a>
    ) : (
      <div className={styles.barLine} aria-label={label}>
        {inner}
      </div>
    );
  };
  return (
    <Card title="Tool activity by category" subtitle="Calls per category; select a bar to see those calls in Traces" className={styles.card} labelledBy="cmp-tools">
      <div className={styles.cardBody}>
        {diff.categories.length === 0 ? (
          <p className={styles.muted}>Neither run made a tool call.</p>
        ) : (
          <ul className={styles.cats} aria-label="Tool calls by category">
            {diff.categories.map((row) => (
              <li key={row.key} className={styles.cat}>
                <span className={styles.catLabel}>
                  <Icon name={categoryIcon(row.key)} size={14} />
                  {categoryName(row.key as DigestCall['category'])}
                </span>
                <div className={styles.catBars}>
                  {bar(row, 'a')}
                  {bar(row, 'b')}
                </div>
                <span className={styles.catChange}>
                  <ChangeChip view={changeView(row.count, CHANGE.toolCalls)} showDetail={false} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {diff.tools.length > 0 && (
          <details className={styles.byTool}>
            <summary>By tool ({diff.tools.length})</summary>
            <DiffTable
              caption="Tool calls by tool"
              rows={diff.tools.map((r) => ({
                label: r.key,
                a: r.a ? linked(r.a.count, ids.a, r.a.firstSeq, `Baseline: first ${r.key} call`) : 0,
                b: r.b ? linked(r.b.count, ids.b, r.b.firstSeq, `Candidate: first ${r.key} call`) : 0,
                change: changeView(r.count, CHANGE.toolCalls),
              }))}
            />
          </details>
        )}
        {!diff.sameMode && <p className={styles.foot}>The executed run’s categories come from Runloop’s own tools (a command that reported test counts is a test run).</p>}
      </div>
    </Card>
  );
}

// ── tokens and permissions ─────────────────────────────────────────────

function TokensCard({ diff, ids }: { diff: RunDiff; ids: Record<Side, string> }) {
  const claudeCode = diff.a.sourceKind === 'claude-code' || diff.b.sourceKind === 'claude-code';
  const anything = diff.agents.some((r) => r.a?.tokens != null || r.b?.tokens != null || r.a?.model || r.b?.model);
  const cell = (r: AgentDiff, side: Side) => {
    const g = r[side];
    if (!g) return <span className={styles.none}>not in this run</span>;
    return (
      <span className={styles.agentCell}>
        <span className={styles.agentTokens}>{g.tokens !== null ? linked(formatTokens(g.tokens), ids[side], g.usageSeq, `${SIDE_NAME[side]}: usage report for ${g.name}`) : <NotReported />}</span>
        <span className={styles.agentModel}>{g.model ? <code title={g.model}>{shortModel(g.model)}</code> : 'model not reported'}</span>
      </span>
    );
  };
  return (
    <Card title="Tokens and models per agent" subtitle="Only what the source reported; never estimated" className={styles.card} labelledBy="cmp-tokens">
      <div className={styles.cardBody}>
        {!anything ? (
          <p className={styles.muted}>
            <Icon name="slash" size={13} /> Neither run reported tokens or a model for any of its {diff.agents.length} agents, so there is nothing to compare.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Tokens and models per agent</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">
                    <span className={styles.colHead}>
                      <SideTag side="a" /> <span className={styles.colHeadText}>Baseline</span>
                    </span>
                  </th>
                  <th scope="col">
                    <span className={styles.colHead}>
                      <SideTag side="b" /> <span className={styles.colHeadText}>Candidate</span>
                    </span>
                  </th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {diff.agents.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">
                      <span className={styles.rowLabel}>{r.key}</span>
                    </th>
                    <td className={styles.numCell}>{cell(r, 'a')}</td>
                    <td className={styles.numCell}>{cell(r, 'b')}</td>
                    <td>
                      <span className={styles.changeStack}>
                        {r.tokens.a === null && r.tokens.b === null ? <span className={styles.none}>no tokens either side</span> : <ChangeChip view={changeView(r.tokens, CHANGE.tokens)} showDetail={false} />}
                        {r.modelChanged && (
                          <Chip icon="swap" title="Both runs reported a model and it differs">
                            model changed
                          </Chip>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.foot}>
          {anything &&
            `Total reported: ${diff.tokens.a !== null ? formatTokens(diff.tokens.a) : 'not reported'} → ${diff.tokens.b !== null ? formatTokens(diff.tokens.b) : 'not reported'}${diff.tokens.note ? ` (${noteText(diff.tokens.note)})` : ''}. `}
          {claudeCode ? 'Claude Code reports usage for subagents only (in the Agent tool result); its hooks do not report the main agent’s tokens. ' : ''}
          {diff.a.mode === 'executed' || diff.b.mode === 'executed' ? 'The scripted demo makes its decisions without a model.' : ''}
        </p>
      </div>
    </Card>
  );
}

function PermissionsCard({ diff, ids }: { diff: RunDiff; ids: Record<Side, string> }) {
  const p = diff.permissions;
  const first = (side: Side) => diff[side].permissions.items[0]?.seq ?? null;
  const inferred = (side: Side) => diff[side].permissions.inferred;
  const na = (side: Side) => (diff[side].mode === 'executed' ? <span className={styles.none}>n/a (executed)</span> : <NotReported />);
  const executedOnly: ChangeView | null =
    diff.a.mode === 'executed' && diff.b.mode === 'executed' ? null : { tone: 'muted', icon: 'minus', text: 'not comparable', detail: 'only traced runs have turns and subagents' };
  const tracedPair = (f: FieldDiff<number>, spec: (typeof CHANGE)[keyof typeof CHANGE]) => (diff.a.mode === 'traced' && diff.b.mode === 'traced' ? changeView(f, spec) : executedOnly);
  const waitCell = (side: Side) => {
    const d = diff[side].permissions;
    if (d.requested === 0) return <span className={styles.none}>none requested</span>;
    if (d.waitMs !== null) return formatDuration(d.waitMs);
    return <NotReported why={d.inferred ? 'Only inferred answers: Runloop closed them, so there is no real wait time' : 'No answer time was recorded'} />;
  };
  const noRequests = p.requested.a === 0 && p.requested.b === 0;
  const oneSideNone = !noRequests && (p.requested.a === 0 || p.requested.b === 0);
  const waitChange: ChangeView | null = noRequests
    ? null
    : oneSideNone
      ? { tone: 'muted', icon: 'minus', text: 'not comparable', detail: `the ${p.requested.a === 0 ? 'baseline' : 'candidate'} requested no permissions` }
      : changeView(p.waitMs, CHANGE.waits);
  const rows: Row[] = [
    {
      label: 'Requested',
      icon: 'lock',
      a: linked(formatInt(p.requested.a!), ids.a, first('a'), 'Baseline’s first permission request'),
      b: linked(formatInt(p.requested.b!), ids.b, first('b'), 'Candidate’s first permission request'),
      change: changeView(p.requested, CHANGE.permissions),
    },
    { label: 'Approved', icon: 'check', a: formatInt(p.approved.a!), b: formatInt(p.approved.b!), change: changeView(p.approved, CHANGE.permissions) },
    {
      label: 'Denied',
      icon: 'slash',
      a: `${formatInt(p.denied.a!)}${inferred('a') ? ` (${inferred('a')} inferred)` : ''}`,
      b: `${formatInt(p.denied.b!)}${inferred('b') ? ` (${inferred('b')} inferred)` : ''}`,
      change: changeView(p.denied, CHANGE.denied),
    },
    { label: 'Waiting for answers', icon: 'hourglass', a: waitCell('a'), b: waitCell('b'), change: waitChange },
    { label: 'Turns', icon: 'message', a: diff.turns.a !== null ? formatInt(diff.turns.a) : na('a'), b: diff.turns.b !== null ? formatInt(diff.turns.b) : na('b'), change: tracedPair(diff.turns, CHANGE.turns) },
    {
      label: 'Subagents',
      icon: 'agent',
      a: diff.subagents.a !== null ? formatInt(diff.subagents.a) : na('a'),
      b: diff.subagents.b !== null ? formatInt(diff.subagents.b) : na('b'),
      change: tracedPair(diff.subagents, CHANGE.subagents),
    },
  ];
  return (
    <Card title="Permissions and delegation" subtitle="Waits only where the answer time was recorded" className={styles.card} labelledBy="cmp-permissions">
      <div className={styles.cardBody}>
        <DiffTable rows={rows} caption="Permissions, turns and subagents, baseline against candidate" />
      </div>
    </Card>
  );
}

