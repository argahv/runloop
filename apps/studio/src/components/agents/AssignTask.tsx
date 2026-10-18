'use client';
/**
 * Assign task (plan §4.4, §5): a real agent's headless Claude Code run,
 * approved by the user. Compose → review the exact command (model, budget,
 * tools, workspace, environment names) → approve → follow its output → the
 * outcome as Claude Code reported it ("Claude Code reports done").
 *
 * Nothing runs until "Approve and run": the preview's single-use nonce is
 * what the runtime spawns with, and it expires after 5 minutes.
 */
import {
  DISPATCH_COPY,
  DISPATCH_PRESETS,
  SSE_END_EVENT,
  type AgentPresence,
  type DispatchOutputFrame,
  type DispatchPolicyResponse,
  type DispatchPreset,
  type DispatchPreview,
  type DispatchSummary,
} from '@runloop-world/events';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { linkTo, ROUTES } from '../../state/deeplink';
import { formatWhen } from '../../state/format';
import { refreshAgents } from '../../world/connect';
import { useWorldStore } from '../../world/context';
import { WorldApiError } from '../../world/api';
import type { CapabilityView } from '../../world/selectors';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { approveDispatch, cancelDispatch, dispatchStreamUrl, getDispatch, getDispatchPolicy, previewDispatch } from './AssignTaskApi';
import { commandLine, costText, dispatchStatusView, expiresIn, outputLines, type DispatchStatusView } from './AssignTaskView';
import base from './agents.module.css';
import styles from './AssignTask.module.css';

const PRESET_TEXT: Record<DispatchPreset, { title: string; text: string }> = {
  read_only: { title: 'Read-only', text: 'Claude Code may read and search files. It cannot edit or run commands.' },
  edit_test: { title: 'Edit + test', text: 'Adds editing files and running pnpm test. Nothing else is allowed.' },
};

const errorText = (e: unknown) =>
  e instanceof WorldApiError ? (e.message.endsWith('.') ? e.message : `${e.message}.`) : `Could not reach the runtime: ${e instanceof Error ? e.message : String(e)}.`;

/** Status line with icon and words (never colour alone). */
function StatusLine({ view }: { view: DispatchStatusView }) {
  return (
    <span className={styles.status} data-tone={view.tone}>
      <Icon name={view.icon} size={16} />
      {view.title}
    </span>
  );
}

/**
 * The agent panel's task section: the latest dispatch (from the world's
 * agent presence) and the Assign task button, disabled with its reason.
 */
export function AssignTaskSection({
  agentId,
  agentName,
  workspaceLabel,
  submit,
  latest,
}: {
  agentId: string;
  agentName: string;
  workspaceLabel: string | null;
  submit: CapabilityView | undefined;
  latest: AgentPresence['dispatch'];
}) {
  const [open, setOpen] = useState(false);
  const [watch, setWatch] = useState<string | null>(null);
  const [summary, setSummary] = useState<DispatchSummary | null>(null);
  const available = submit?.available ?? false;

  // The world says which dispatch is the latest and its phase; details come from the API.
  useEffect(() => {
    if (!latest) return setSummary(null);
    let live = true;
    getDispatch(latest.dispatchId)
      .then((r) => live && setSummary(r.dispatch))
      .catch(() => live && setSummary(null));
    return () => {
      live = false;
    };
  }, [latest?.dispatchId, latest?.phase]);

  const view = summary ? dispatchStatusView(summary) : null;
  return (
    <section className={styles.section} aria-labelledby={`${agentId}-tasks`}>
      <div className={styles.sectionHead}>
        <h3 id={`${agentId}-tasks`} className={styles.h3}>
          Tasks
        </h3>
        <span className={styles.note}>Launched by Runloop · traced</span>
      </div>
      {summary && view && (
        <div className={styles.card}>
          <StatusLine view={view} />
          <span className={styles.task} title={summary.taskPreview}>
            “{summary.taskPreview}”
          </span>
          <span className={styles.note}>
            {formatWhen(summary.startedAt)} · {summary.model} · {costText(summary.reportedCostUsd)}
          </span>
          <span className={styles.links}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setWatch(summary.dispatchId);
                setOpen(true);
              }}
            >
              {view.active ? 'Follow' : 'Details'}
            </button>
            {summary.runId && (
              <Link className={styles.linkButton} href={linkTo(ROUTES.traces, { runId: summary.runId })}>
                Trace
              </Link>
            )}
          </span>
        </div>
      )}
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          icon="play"
          disabled={!available}
          title={available ? `Run Claude Code headless in ${workspaceLabel ?? 'its workspace'}` : (submit?.reason ?? 'Not reported by this runtime')}
          onClick={() => {
            setWatch(null);
            setOpen(true);
          }}
        >
          Assign task
        </Button>
      </div>
      {!available && <p className={styles.note}>{submit?.reason ? `${submit.reason}.` : 'This runtime does not report whether it can dispatch tasks.'}</p>}
      <AssignTaskDialog open={open} onClose={() => setOpen(false)} agentId={agentId} agentName={agentName} workspaceLabel={workspaceLabel} watch={watch} />
    </section>
  );
}

type Step = 'compose' | 'review' | 'run';

export default function AssignTaskDialog({
  open,
  onClose,
  agentId,
  agentName,
  workspaceLabel,
  watch,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  workspaceLabel: string | null;
  /** Open on this dispatch's progress instead of a new task. */
  watch?: string | null;
}) {
  const id = useId();
  const store = useWorldStore();
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const [step, setStep] = useState<Step>('compose');
  const [policy, setPolicy] = useState<DispatchPolicyResponse | null>(null);
  const [task, setTask] = useState('');
  const [preset, setPreset] = useState<DispatchPreset>('read_only');
  const [model, setModel] = useState('haiku');
  const [budget, setBudget] = useState('0.25');
  const [timeout, setTimeoutMin] = useState('10');
  const [preview, setPreview] = useState<DispatchPreview | null>(null);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DispatchSummary | null>(null);
  const [frames, setFrames] = useState<DispatchOutputFrame[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Reset on open; load the policy (defaults, allowed models, caps) and the CLI probe.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setConfirmCancel(false);
    setPreview(null);
    setFrames([]);
    setSummary(null);
    setDispatchId(watch ?? null);
    setStep(watch ? 'run' : 'compose');
    if (!watch) setTask('');
    getDispatchPolicy()
      .then((p) => {
        setPolicy(p);
        if (!watch) {
          setModel(p.policy.models[0] ?? 'haiku');
          setBudget(String(p.policy.defaultBudgetUsd));
          setTimeoutMin(String(p.policy.defaultTimeoutMin));
        }
      })
      .catch((e: unknown) => setError(e instanceof WorldApiError && e.code === 'dispatch_disabled' ? 'Task dispatch is off in this runtime.' : errorText(e)));
  }, [open, watch]);

  // The approval countdown.
  useEffect(() => {
    if (!open || step !== 'review') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, step]);

  // Follow a dispatch: its output over SSE, its summary by polling (stopping, run id, outcome).
  useEffect(() => {
    if (!open || step !== 'run' || !dispatchId) return;
    let live = true;
    const refresh = () =>
      getDispatch(dispatchId)
        .then((r) => {
          if (!live) return;
          setSummary(r.dispatch);
          if (r.dispatch.status === 'finished') void refreshAgents(store);
        })
        .catch((e: unknown) => live && setError(errorText(e)));
    void refresh();
    const poll = setInterval(refresh, 2000);
    const es = new EventSource(dispatchStreamUrl(dispatchId));
    es.onmessage = (m) => {
      try {
        const f = JSON.parse(m.data as string) as DispatchOutputFrame;
        setFrames((prev) => [...prev, f]);
      } catch {
        // ignore a frame that does not parse
      }
    };
    es.addEventListener(SSE_END_EVENT, () => {
      es.close();
      void refresh();
    });
    return () => {
      live = false;
      clearInterval(poll);
      es.close();
    };
  }, [open, step, dispatchId, store]);

  const budgetNum = Number(budget);
  const timeoutNum = Number(timeout);
  const caps = policy?.policy;
  const budgetOk = Number.isFinite(budgetNum) && budgetNum >= 0.01 && budgetNum <= (caps?.maxBudgetUsd ?? 1);
  const timeoutOk = Number.isInteger(timeoutNum) && timeoutNum >= 1 && timeoutNum <= (caps?.maxTimeoutMin ?? 30);
  const taskOk = task.trim().length > 0 && !task.trim().startsWith('-');
  const cliOk = policy?.cli.state === 'ok';
  const canPreview = !!caps?.enabled && cliOk && taskOk && budgetOk && timeoutOk && !busy;

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await previewDispatch(agentId, { task: task.trim(), preset, model, maxBudgetUsd: budgetNum, timeoutMin: timeoutNum });
      setPreview(r.preview);
      setNow(Date.now());
      setStep('review');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const doApprove = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await approveDispatch(preview.previewId, preview.approvalNonce);
      setSummary(r.dispatch);
      setDispatchId(r.dispatch.dispatchId);
      setStep('run');
    } catch (e) {
      // The nonce is spent by any attempt: a retry needs a fresh preview.
      setError(`${errorText(e)} Nothing was run.`);
      setPreview(null);
      setStep('compose');
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!dispatchId) return;
    setBusy(true);
    try {
      setSummary((await cancelDispatch(dispatchId)).dispatch);
      setConfirmCancel(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const lines = useMemo(() => outputLines(frames), [frames]);
  const outputRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  const view = summary ? dispatchStatusView(summary) : null;
  const where = workspaceLabel ? `“${workspaceLabel}”` : 'its workspace';

  return (
    <Dialog open={open} onClose={onClose} labelledBy={`${id}-title`} describedBy={`${id}-lede`} initialFocus={step === 'compose' ? taskRef : undefined} className={`${base.dialog} ${styles.dialog}`}>
      <form
        className={base.form}
        // The fields are checked here (and by the runtime against the policy), with reasons shown inline.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'compose' && canPreview) void doPreview();
          else if (step === 'review' && preview) void doApprove();
        }}
      >
        <header className={base.dialogHead}>
          <h2 id={`${id}-title`} className={base.dialogTitle}>
            {step === 'run' ? 'Task' : `Assign a task to ${agentName}`}
          </h2>
          <p id={`${id}-lede`} className={base.dialogLede}>
            {step === 'run'
              ? `Claude Code, headless, in ${where}. Its hooks trace the session like any other.`
              : `Claude Code runs headless in ${where}. Nothing runs until you approve the exact command.`}
          </p>
        </header>

        <div className={base.dialogBody}>
          {policy && !cliOk && step !== 'run' && (
            <p className={base.notice}>
              <Icon name="alert" size={14} />
              Claude Code cannot be run: {policy.cli.reason ?? 'not checked yet'}.
            </p>
          )}
          {caps && !caps.enabled && step !== 'run' && (
            <p className={base.notice}>
              <Icon name="lock" size={14} />
              Your organisation&apos;s policy does not allow task dispatch.
            </p>
          )}

          {step === 'compose' && (
            <>
              <label className={base.label} htmlFor={`${id}-task`}>
                Task
              </label>
              <textarea
                ref={taskRef}
                id={`${id}-task`}
                className={styles.textarea}
                value={task}
                rows={4}
                maxLength={8000}
                placeholder="Summarise what src/ does and list its tests."
                onChange={(e) => setTask(e.target.value)}
                aria-invalid={task.trim().startsWith('-') || undefined}
                aria-describedby={`${id}-task-hint`}
              />
              <span id={`${id}-task-hint`} className={base.hint}>
                {task.trim().startsWith('-') ? 'A task cannot start with “-” (Claude Code would read it as an option).' : 'Passed to claude -p as one argument; no shell is involved.'}
              </span>

              <fieldset className={base.fieldset}>
                <legend className={styles.legend}>Tools (permission mode dontAsk: anything not listed is denied)</legend>
                {(caps?.presets ?? (['read_only', 'edit_test'] as DispatchPreset[])).map((p) => (
                  <label key={p} className={base.choice} data-checked={preset === p || undefined}>
                    <input type="radio" name={`${id}-preset`} checked={preset === p} onChange={() => setPreset(p)} />
                    <span className={base.choiceBody}>
                      <span className={base.choiceTitle}>{PRESET_TEXT[p].title}</span>
                      <span className={base.choiceText}>{PRESET_TEXT[p].text}</span>
                      <span className={styles.tools}>{DISPATCH_PRESETS[p].join('  ')}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className={styles.row3}>
                <label className={styles.field}>
                  <span className={base.label}>Model</span>
                  <select className={base.input} value={model} onChange={(e) => setModel(e.target.value)}>
                    {(caps?.models ?? ['haiku']).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={base.label}>Budget (USD, max ${caps?.maxBudgetUsd ?? 1})</span>
                  <input className={base.input} type="number" inputMode="decimal" min={0.01} max={caps?.maxBudgetUsd ?? 1} step={0.01} value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={!budgetOk || undefined} />
                </label>
                <label className={styles.field}>
                  <span className={base.label}>Timeout (min, max {caps?.maxTimeoutMin ?? 30})</span>
                  <input className={base.input} type="number" inputMode="numeric" min={1} max={caps?.maxTimeoutMin ?? 30} step={1} value={timeout} onChange={(e) => setTimeoutMin(e.target.value)} aria-invalid={!timeoutOk || undefined} />
                </label>
              </div>
              <Facts preset={preset} />
            </>
          )}

          {step === 'review' && preview && (
            <>
              <span className={base.label}>Exactly what will run (in {where})</span>
              <ExactCommand command={commandLine(preview.argv)} />
              <dl className={styles.kv}>
                <dt>Model</dt>
                <dd>{preview.model}</dd>
                <dt>Budget</dt>
                <dd>${preview.maxBudgetUsd} at most (--max-budget-usd, enforced by Claude Code)</dd>
                <dt>Timeout</dt>
                <dd>{preview.timeoutMin} min (enforced by Runloop)</dd>
                <dt>Tools</dt>
                <dd className={styles.chips}>
                  <Chip>{PRESET_TEXT[preview.preset].title}</Chip>
                  {preview.allowedTools.map((t) => (
                    <Chip key={t} mono>
                      {t}
                    </Chip>
                  ))}
                </dd>
                <dt>Permissions</dt>
                <dd>dontAsk: tools not listed are denied, nothing prompts</dd>
                <dt>Environment</dt>
                <dd className={styles.mono}>{preview.envKeys.join(' ')}</dd>
                <dt>Tracing</dt>
                <dd>
                  {preview.usesPluginDir
                    ? 'Loads the Runloop plugin for this session (--plugin-dir): this workspace has not sent a hook yet.'
                    : 'Through the Runloop plugin already installed for this workspace.'}{' '}
                  Session {preview.sessionId.slice(0, 8)} binds to {agentName}.
                </dd>
                <dt>Claude Code</dt>
                <dd>{preview.cliVersion ?? 'version not reported'}</dd>
              </dl>
              <Facts preset={preview.preset} />
              <p className={styles.note} aria-live="polite">
                <Icon name="clock" size={12} /> This approval is valid once, for {expiresIn(preview.expiresAt, now)}.
              </p>
            </>
          )}

          {step === 'run' && (
            <>
              {view && summary && (
                <div className={styles.result}>
                  <StatusLine view={view} />
                  <span className={styles.note}>{view.detail}</span>
                  {summary.outcome === 'completed' && summary.resultText && <blockquote className={styles.quote}>{summary.resultText}</blockquote>}
                  <span className={styles.note}>
                    {costText(summary.reportedCostUsd)}
                    {summary.reportedTurns !== null ? ` · ${summary.reportedTurns} turns` : ''} · {summary.model} · {summary.allowedTools.join(' ')}
                  </span>
                  <span className={styles.task}>“{summary.taskPreview}”</span>
                  <span className={styles.links}>
                    {summary.runId ? (
                      <>
                        <Link className={styles.linkButton} href={linkTo(ROUTES.traces, { runId: summary.runId })} onClick={onClose}>
                          Open the trace
                        </Link>
                        <Link className={styles.linkButton} href={linkTo(ROUTES.world, { runId: summary.runId })} onClick={onClose}>
                          Watch in Live World
                        </Link>
                      </>
                    ) : (
                      <span className={styles.note}>The trace appears with the session&apos;s first hook.</span>
                    )}
                  </span>
                </div>
              )}
              <span className={base.label}>Output (stream-json, as Claude Code printed it)</span>
              <ol ref={outputRef} className={styles.output} aria-live="polite" aria-label="Claude Code output">
                {lines.length === 0 ? (
                  <li className={styles.muted}>{summary && summary.status !== 'running' ? 'No output kept (Runloop keeps it in memory only).' : 'Waiting for output…'}</li>
                ) : (
                  lines.map((l) => (
                    <li key={l.key} data-kind={l.kind}>
                      {l.kind === 'tool' && <Icon name="terminal" size={12} />}
                      {l.text}
                    </li>
                  ))
                )}
              </ol>
              {summary?.outputTruncated && <span className={styles.note}>Output past 1 MiB was not kept; the final result was still read.</span>}
              {confirmCancel && (
                <div className={styles.confirm} role="alertdialog" aria-labelledby={`${id}-cancel`}>
                  <span id={`${id}-cancel`}>Stop Claude Code? It gets SIGTERM, then SIGKILL after 10 s. {DISPATCH_COPY.edits} even if you stop it.</span>
                  <span className={styles.links}>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
                      Keep running
                    </Button>
                    <Button size="sm" variant="danger" icon="stop" busy={busy} onClick={() => void doCancel()}>
                      Stop task
                    </Button>
                  </span>
                </div>
              )}
            </>
          )}

          {error && (
            <p className={base.error} role="alert">
              <Icon name="xCircle" size={14} />
              {error}
            </p>
          )}
        </div>

        <footer className={base.dialogFoot}>
          {step === 'compose' && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!canPreview}>
                Preview command
              </Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button variant="ghost" onClick={() => setStep('compose')}>
                Back
              </Button>
              <Button type="submit" variant="primary" icon="play" busy={busy} disabled={!preview || expiresIn(preview.expiresAt, now) === 'expired'}>
                Approve and run
              </Button>
            </>
          )}
          {step === 'run' && (
            <>
              {view?.active && !confirmCancel && (
                <Button variant="danger" icon="stop" disabled={summary?.stopping} onClick={() => setConfirmCancel(true)}>
                  {summary?.stopping ? 'Stopping…' : 'Cancel task'}
                </Button>
              )}
              <Button variant={view?.active ? 'ghost' : 'primary'} onClick={onClose}>
                {view?.active ? 'Close (keeps running)' : 'Close'}
              </Button>
            </>
          )}
        </footer>
      </form>
    </Dialog>
  );
}

/** The whole command, wrapped (nothing hidden behind a scroll), with a copy button. */
function ExactCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied('idle'), 1800);
  };
  return (
    <div className={styles.command}>
      <pre>
        <span aria-hidden="true">$ </span>
        {command}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon={copied === 'copied' ? 'check' : copied === 'failed' ? 'x' : 'copy'}
        aria-label={copied === 'copied' ? 'Copied' : 'Copy the command'}
        onClick={() => void copy()}
      />
    </div>
  );
}

/** The cost and side-effect facts the dialog always states (plan §4.4 copy). */
function Facts({ preset }: { preset: DispatchPreset }) {
  return (
    <ul className={styles.facts}>
      <li>
        <Icon name="coins" size={14} />
        <span>
          <strong>{DISPATCH_COPY.billing}.</strong> Claude Code enforces the budget; Runloop enforces the timeout and does not meter cost.
        </span>
      </li>
      <li data-warn={preset === 'edit_test' || undefined}>
        <Icon name={preset === 'edit_test' ? 'alert' : 'pencil'} size={14} />
        <span>
          <strong>{DISPATCH_COPY.edits}.</strong> {preset === 'edit_test' ? 'There is no sandbox or branch: review them with git.' : 'This preset cannot edit; Edit + test can.'}
        </span>
      </li>
      <li>
        <Icon name="check" size={14} />
        <span>
          When it ends you see what Claude Code reported (“{DISPATCH_COPY.done}”), not a check by Runloop.
        </span>
      </li>
    </ul>
  );
}
