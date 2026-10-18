'use client';
import type { AgentSummary } from '@runloop-world/events';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CC } from '../../lib/claude-code';
import { ROUTES } from '../../state/deeplink';
import { createAgent, WorldApiError } from '../../world/api';
import { refreshAgents } from '../../world/connect';
import { useWorld, useWorldStore } from '../../world/context';
import { Button } from '../../ui/Button';
import { CommandSnippet } from '../../ui/CommandSnippet';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import styles from './agents.module.css';

type Step = 1 | 2 | 3 | 'done';
type Source = { kind: 'arrival'; sessionId: string } | { kind: 'path' };

const STEPS = ['Agent', 'Lot', 'Workspace'] as const;

/** Lot names from their position: "North row · 1". */
function lotName(id: string): string {
  const n = Number(id.replace(/\D+/g, ''));
  return Number.isFinite(n) && n > 0 ? `Lot ${n}` : id;
}

/**
 * Add to World (plan §5, UX §8): Claude Code and a name → a free Agent
 * District lot → a workspace (an Arrival or a typed folder). The building
 * appears dimmed as "Waiting for first event" until a hook really arrives;
 * nothing here pretends the agent is connected.
 */
export default function AddToWorldDialog({ open, onClose, fromSessionId }: { open: boolean; onClose: () => void; fromSessionId?: string | null }) {
  const id = useId();
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents);
  const arrivals = useWorld((s) => s.arrivals);
  const agentsApi = useWorld((s) => s.agentsApi);
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [lotId, setLotId] = useState<string | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'path' });
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AgentSummary | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const taken = useMemo(() => new Map((agents ?? []).map((a) => [a.lotId, a.displayName])), [agents]);
  const lots = town?.agentLots ?? [];
  const firstFree = lots.find((l) => !taken.has(l.id))?.id ?? null;

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setError(null);
    setCreated(null);
    setBusy(false);
    setName((agents?.length ?? 0) === 0 ? 'Engineering House' : '');
    setLotId(firstFree);
    setSource(fromSessionId ? { kind: 'arrival', sessionId: fromSessionId } : arrivals[0] ? { kind: 'arrival', sessionId: arrivals[0].sessionId } : { kind: 'path' });
    setPath('');
    // Reset only when the dialog opens (agents, arrivals and the first free lot are read once per opening).
  }, [open]);

  const nameOk = name.trim().length > 0 && name.trim().length <= 60;
  const lotOk = lotId !== null && !taken.has(lotId);
  const sourceOk = source.kind === 'arrival' ? arrivals.some((a) => a.sessionId === source.sessionId) : path.trim().length > 0;
  const apiMissing = agentsApi === 'unavailable';

  const submit = async () => {
    if (!lotId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createAgent({
        displayName: name.trim(),
        lotId,
        workspace: source.kind === 'arrival' ? { fromSessionId: source.sessionId } : { path: path.trim() },
      });
      setCreated(res.agent);
      setStep('done');
      void refreshAgents(store);
      store.getState().setMode('agents');
      store.getState().focusEntity({ kind: 'agent', id: res.agent.agentId });
    } catch (e) {
      if (e instanceof WorldApiError) {
        // Send the viewer back to the step the problem is about (the message never contains a path).
        const where = e.code === 'lot_unavailable' || e.code === 'unknown_entity' ? 2 : e.code === 'world_error' ? null : 3;
        setError(e.message.endsWith('.') ? e.message : `${e.message}.`);
        if (where) setStep(where);
      } else setError(e instanceof Error ? `Could not reach the runtime: ${e.message}.` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    setError(null);
    if (step === 1 && nameOk) setStep(2);
    else if (step === 2 && lotOk) setStep(3);
    else if (step === 3 && sourceOk) void submit();
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy={`${id}-title`} initialFocus={nameRef} className={styles.dialog}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
      >
        <header className={styles.dialogHead}>
          <h2 id={`${id}-title`} className={styles.dialogTitle}>
            Add to World
          </h2>
          <p className={styles.dialogLede}>Give a real Claude Code agent a building in the Agent District. The town keeps living whether it is connected or not.</p>
          {step !== 'done' && (
            <ol className={styles.stepper} aria-label="Steps">
              {STEPS.map((label, i) => (
                <li key={label} data-state={step === i + 1 ? 'current' : (step as number) > i + 1 ? 'done' : 'todo'} aria-current={step === i + 1 ? 'step' : undefined}>
                  <span className={styles.stepNum}>{(step as number) > i + 1 ? <Icon name="check" size={12} /> : i + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          )}
        </header>

        <div className={styles.dialogBody}>
          {apiMissing && (
            <p className={styles.notice}>
              <Icon name="alert" size={14} />
              This runtime does not serve the agents API yet (GET /api/agents answered 404), so agents cannot be added from here. The town still runs.
            </p>
          )}

          {step === 1 && (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Which agent</legend>
              <label className={styles.choice} data-checked>
                <input type="radio" name={`${id}-adapter`} checked readOnly />
                <span className={styles.choiceBody}>
                  <span className={styles.choiceTitle}>Claude Code</span>
                  <span className={styles.choiceText}>Observed through the Runloop plugin's hooks. Runloop records what it reports; it does not run or approve its tools.</span>
                </span>
              </label>
              <p className={styles.hint}>Claude Code is the only adapter so far.</p>
              <label className={styles.label} htmlFor={`${id}-name`}>
                Building name
              </label>
              <input
                ref={nameRef}
                id={`${id}-name`}
                className={styles.input}
                value={name}
                maxLength={60}
                placeholder="Engineering House"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!nameOk && name.length > 0}
              />
            </fieldset>
          )}

          {step === 2 && (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>A lot in the Agent District</legend>
              {lots.length === 0 ? (
                <p className={styles.hint}>This town has no agent lots.</p>
              ) : (
                <div className={styles.lots} role="radiogroup" aria-label="Agent lots">
                  {lots.map((l) => {
                    const who = taken.get(l.id);
                    return (
                      <label key={l.id} className={styles.lot} data-checked={lotId === l.id || undefined} data-taken={who ? true : undefined}>
                        <input type="radio" name={`${id}-lot`} value={l.id} checked={lotId === l.id} disabled={!!who} onChange={() => setLotId(l.id)} />
                        <span className={styles.lotName}>{lotName(l.id)}</span>
                        <span className={styles.lotMeta}>{who ? `Taken · ${who}` : `Free · ${l.rect[2]}×${l.rect[3]}`}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className={styles.hint}>Lots are reserved for real agents: residents never walk onto them.</p>
            </fieldset>
          )}

          {step === 3 && (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Its workspace</legend>
              <p className={styles.hint}>Claude Code sessions started inside this folder will bind to the agent. The full path stays on this machine; the world only shows the folder's name.</p>
              {arrivals.length > 0 && (
                <>
                  <span className={styles.label}>A session Runloop has already seen (Arrivals)</span>
                  {arrivals.map((a) => (
                    <label key={a.sessionId} className={styles.choice} data-checked={(source.kind === 'arrival' && source.sessionId === a.sessionId) || undefined}>
                      <input
                        type="radio"
                        name={`${id}-src`}
                        checked={source.kind === 'arrival' && source.sessionId === a.sessionId}
                        onChange={() => setSource({ kind: 'arrival', sessionId: a.sessionId })}
                      />
                      <span className={styles.choiceBody}>
                        <span className={styles.choiceTitle}>{a.projectLabel}</span>
                        <span className={styles.choiceText}>
                          {a.pathHint ?? 'folder not known since the last restart'} · session {a.sessionId.slice(0, 8)} · {a.runIds.length} {a.runIds.length === 1 ? 'run' : 'runs'}
                        </span>
                      </span>
                    </label>
                  ))}
                </>
              )}
              <label className={styles.choice} data-checked={source.kind === 'path' || undefined}>
                <input type="radio" name={`${id}-src`} checked={source.kind === 'path'} onChange={() => setSource({ kind: 'path' })} />
                <span className={styles.choiceBody}>
                  <span className={styles.choiceTitle}>A folder on this machine</span>
                  <span className={styles.choiceText}>It must exist, sit outside Runloop's data folder and not belong to another agent.</span>
                </span>
              </label>
              {source.kind === 'path' && (
                <input
                  className={styles.input}
                  value={path}
                  placeholder="/Users/you/code/my-project"
                  aria-label="Workspace folder (absolute path)"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPath(e.target.value)}
                />
              )}
            </fieldset>
          )}

          {step === 'done' && created && (
            <div className={styles.done}>
              <p className={styles.doneTitle}>
                <Icon name="hourglass" size={16} />
                {created.displayName} is in the Agent District, waiting for its first event.
              </p>
              <p className={styles.hint}>
                The building stays dimmed until Claude Code really sends a hook from {created.workspace ? `“${created.workspace.label}”` : 'its workspace'}. Install the plugin once, then run <code>claude</code> in that folder:
              </p>
              <CommandSnippet command={CC.shellInstall} />
              <p className={styles.hint}>
                Or load it from a Runloop checkout with <code>{CC.pluginDir}</code>. Details and <code>--doctor</code> are on <Link href={ROUTES.integrations}>Connect</Link>.
              </p>
            </div>
          )}

          {error && (
            <p className={styles.error} role="alert">
              <Icon name="xCircle" size={14} />
              {error} Nothing was saved.
            </p>
          )}
        </div>

        <footer className={styles.dialogFoot}>
          {step === 'done' ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={step === 1 ? onClose : () => setStep(((step as number) - 1) as Step)}>
                {step === 1 ? 'Cancel' : 'Back'}
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={apiMissing || (step === 1 ? !nameOk : step === 2 ? !lotOk : !sourceOk)}
              >
                {step === 3 ? 'Add to World' : 'Next'}
              </Button>
            </>
          )}
        </footer>
      </form>
    </Dialog>
  );
}
