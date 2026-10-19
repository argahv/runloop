'use client';
/**
 * Add to World inside the town (immersive contract §4.3). The viewer has
 * picked a free lot in the Agent District; this card, anchored to that lot,
 * collects the building's name and the workspace (an Arrival or a folder),
 * shows how Claude Code connects, and creates the agent. The building then
 * stands as an unpainted model, "Waiting for first event", until a real hook
 * arrives: nothing here claims a connection. Errors keep their codes
 * (`lot_unavailable` sends the viewer back to picking a lot).
 *
 * `layout="dialog"` is the 2D route (no WebGL, the 2D map view, other pages):
 * the dialog with its lot radio group.
 */
import type { AgentSummary } from '@runloop-world/events';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CC } from '../../lib/claude-code';
import { useStudio } from '../../state/context';
import { createAgent, WorldApiError } from '../../world/api';
import { refreshAgents } from '../../world/connect';
import { useWorld, useWorldStore } from '../../world/context';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { CommandSnippet } from '../../ui/CommandSnippet';
import { Icon } from '../../ui/Icon';
import { lotLabel } from '../world/hud/lots';
import AddedAgentStatus from './AddedAgentStatus';
import AddToWorldDialog from './AddToWorldDialog';
import styles from './agents.module.css';

type Source = { kind: 'arrival'; sessionId: string } | { kind: 'path' };


export default function AddToWorldFlow({
  layout,
  lotId,
  onLotChange,
  onClose,
  onDone,
  onArrived,
  fromSessionId = null,
}: {
  layout: 'anchored' | 'dialog';
  lotId: string | null;
  /** Back to lot picking (null), with the reason when the runtime refused the lot. */
  onLotChange: (lotId: string | null, reason?: string) => void;
  onClose: () => void;
  /** After "Done": the new agent's id. */
  onDone?: (agentId: string) => void;
  /** The new agent's first real event arrived while the last step was open (hand over to its card). */
  onArrived?: (agentId: string) => void;
  fromSessionId?: string | null;
}) {
  if (layout === 'dialog') return <AddToWorldDialog open onClose={onClose} fromSessionId={fromSessionId} />;
  return <AnchoredFlow lotId={lotId} onLotChange={onLotChange} onClose={onClose} onDone={onDone} onArrived={onArrived} fromSessionId={fromSessionId} />;
}

function AnchoredFlow({
  lotId,
  onLotChange,
  onClose,
  onDone,
  onArrived,
  fromSessionId,
}: {
  lotId: string | null;
  onLotChange: (lotId: string | null, reason?: string) => void;
  onClose: () => void;
  onDone?: (agentId: string) => void;
  onArrived?: ((agentId: string) => void) | undefined;
  fromSessionId: string | null;
}) {
  const id = useId();
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents);
  const arrivals = useWorld((s) => s.arrivals);
  const agentsApi = useWorld((s) => s.agentsApi);
  const ingest = useStudio((s) => s.runtime.ingest);
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>({ kind: 'path' });
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AgentSummary | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Defaults once per opening: the first agent's building is "Engineering House".
  useEffect(() => {
    setName((agents?.length ?? 0) === 0 ? 'Engineering House' : '');
    setSource(fromSessionId ? { kind: 'arrival', sessionId: fromSessionId } : arrivals[0] ? { kind: 'arrival', sessionId: arrivals[0].sessionId } : { kind: 'path' });
    requestAnimationFrame(() => nameRef.current?.focus());
  }, []);

  const lot = lotId ? town?.lotById.get(lotId) : undefined;
  const taken = useMemo(() => new Set((agents ?? []).map((a) => a.lotId)), [agents]);
  const nameOk = name.trim().length > 0 && name.trim().length <= 60;
  const sourceOk = source.kind === 'arrival' ? arrivals.some((a) => a.sessionId === source.sessionId) : path.trim().length > 0;
  const apiMissing = agentsApi === 'unavailable';
  // Only a real agent lot of this town that nobody holds (a deep link can name anything).
  const lotOk = lotId !== null && lot?.use === 'agent' && !taken.has(lotId);

  const submit = async () => {
    if (!lotId || !nameOk || !sourceOk) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createAgent({
        displayName: name.trim(),
        lotId,
        workspace: source.kind === 'arrival' ? { fromSessionId: source.sessionId } : { path: path.trim() },
      });
      setCreated(res.agent);
      void refreshAgents(store);
    } catch (e) {
      if (e instanceof WorldApiError) {
        const msg = e.message.endsWith('.') ? e.message : `${e.message}.`;
        // The lot went to someone else: back to picking one (the message never contains a path).
        if (e.code === 'lot_unavailable' || e.code === 'unknown_entity') onLotChange(null, `${msg} Nothing was saved. Pick another free lot.`);
        else setError(`${msg} Nothing was saved.`);
      } else setError(`Could not reach the runtime: ${e instanceof Error ? e.message : String(e)}. Nothing was saved.`);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className={styles.flow}>
        {/* Live state, not the create answer: from the first real event this hands over to the agent's own card. */}
        <AddedAgentStatus created={created} {...(onArrived ? { onArrived } : {})} />
        <div className={styles.flowFoot}>
          <Button
            variant="primary"
            onClick={() => {
              onDone?.(created.agentId);
              onClose();
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className={styles.flow}
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 id={`${id}-title`} className={styles.flowTitle}>
          <Icon name="plus" size={16} />
          Add to World
        </h2>
        <p className={styles.hint}>
          {lotId ? lotLabel(lotId) : 'No lot'}
          {lot ? ` · ${lot.rect[2]}×${lot.rect[3]} cells` : ''} · {lotOk ? 'free' : lot?.use === 'agent' ? 'taken' : 'not an agent lot'}
          <button type="button" className={styles.inlineLink} onClick={() => onLotChange(null)}>
            Change lot
          </button>
        </p>
      </div>

      {apiMissing && (
        <p className={styles.notice}>
          <Icon name="alert" size={14} />
          This runtime does not serve the agents API (GET /api/agents answered 404), so agents cannot be added. The town still runs.
        </p>
      )}

      <label className={styles.label} htmlFor={`${id}-name`}>
        Building name
      </label>
      <input
        ref={nameRef}
        id={`${id}-name`}
        className={styles.input}
        value={name}
        maxLength={60}
        placeholder={(agents?.length ?? 0) === 0 ? 'Engineering House' : 'Docs Desk'}
        onChange={(e) => setName(e.target.value)}
        aria-invalid={!nameOk && name.length > 0}
      />

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>Workspace</legend>
        <p className={styles.hint}>Claude Code sessions started inside this folder bind to the agent. The full path stays on this machine; the world shows only the folder's name.</p>
        {arrivals.map((a) => (
          <label key={a.sessionId} className={styles.choice} data-checked={(source.kind === 'arrival' && source.sessionId === a.sessionId) || undefined}>
            <input type="radio" name={`${id}-src`} checked={source.kind === 'arrival' && source.sessionId === a.sessionId} onChange={() => setSource({ kind: 'arrival', sessionId: a.sessionId })} />
            <span className={styles.choiceBody}>
              <span className={styles.choiceTitle}>{a.projectLabel}</span>
              <span className={styles.choiceText}>
                Seen by Runloop · {a.pathHint ?? 'folder not known since the last restart'} · {a.runIds.length} {a.runIds.length === 1 ? 'run' : 'runs'}
              </span>
            </span>
          </label>
        ))}
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

      <section className={styles.connect} aria-labelledby={`${id}-connect`}>
        <div className={styles.connectHead}>
          <h3 id={`${id}-connect`} className={styles.label}>
            Connect Claude Code
          </h3>
          {ingest?.claudeCode ? (
            <Chip tone="ok" icon="check">
              ingest ready
            </Chip>
          ) : ingest ? (
            <Chip icon="slash">ingest turned off</Chip>
          ) : (
            <Chip icon="ellipsis">ingest not reported</Chip>
          )}
        </div>
        <p className={styles.hint}>The Runloop plugin's hooks report each session (tool calls, results, subagents). Runloop records what they report; it never runs or approves the agent's tools. Install it once:</p>
        <CommandSnippet command={CC.shellInstall} />
      </section>

      {error && (
        <p className={styles.error} role="alert">
          <Icon name="xCircle" size={14} />
          {error}
        </p>
      )}

      <div className={styles.flowFoot}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon="plus" busy={busy} disabled={apiMissing || !lotOk || !nameOk || !sourceOk}>
          Add to World
        </Button>
      </div>
    </form>
  );
}
