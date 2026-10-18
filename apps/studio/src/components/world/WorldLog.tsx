'use client';
import { isAmbientWorldEvent, WORLD_EVENT_TYPES, type EntityKind, type WorldEvent, type WorldProvenance } from '@runloop-world/events';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { linkTo, ROUTES } from '../../state/deeplink';
import { getWorldEventsSince } from '../../world/api';
import { useWorld, useWorldStore } from '../../world/context';
import { entityName } from '../../world/entityIndex';
import { clockParts } from '../../world/interpolate';
import { eventRunLink, eventText, provenanceChip } from '../../world/selectors';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import styles from './WorldLog.module.css';

type ProvFilter = 'all' | WorldProvenance;
const PROVS: { value: ProvFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'external-agent', label: 'Real agents' },
  { value: 'simulation', label: 'Simulated' },
  { value: 'user', label: 'You' },
  { value: 'system', label: 'Runloop' },
  { value: 'inferred', label: 'Inferred' },
];

/** How far back the log reads on open (events); older ones load on demand. */
const WINDOW = 3000;
const SHOW = 200;

const actorRef = (e: WorldEvent): { kind: EntityKind; id: string } | null => {
  if (!e.actor) return null;
  if (e.actor.startsWith('res_')) return { kind: 'resident', id: e.actor };
  if (e.actor.startsWith('agt_')) return { kind: 'agent', id: e.actor };
  if (e.actor.startsWith('bld_')) return { kind: 'building', id: e.actor };
  return null;
};

/**
 * Intelligence (plan §5): the World Log, every recorded world event with its
 * provenance, filterable by provenance, type and actor. Agent events link to
 * the run events behind them in Traces. Movement and decisions (ambient) are
 * here, never in the ticker.
 */
export default function WorldLog() {
  const store = useWorldStore();
  const live = useWorld((s) => s.log);
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const focus = useWorld((s) => s.logFocus);
  const [prov, setProv] = useState<ProvFilter>('all');
  const [type, setType] = useState<string>('');
  const [actor, setActor] = useState<string | null>(focus?.actor ?? null);
  const [ambient, setAmbient] = useState<boolean>(focus?.actor?.startsWith('res_') ?? false);
  const [fetched, setFetched] = useState<WorldEvent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [limit, setLimit] = useState(SHOW);
  const highlight = focus?.seq ?? null;
  const listRef = useRef<HTMLOListElement>(null);
  const ready = snapshot !== null;

  useEffect(() => {
    if (focus?.actor !== undefined) {
      setActor(focus?.actor ?? null);
      if (focus?.actor?.startsWith('res_')) setAmbient(true);
    }
  }, [focus]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setState('loading');
    // The window ends at the seq when the filters change; the live log covers newer events.
    const seqNow = store.getState().snapshot?.seq ?? 0;
    const start = Math.max(0, highlight !== null ? Math.min(highlight - 50, seqNow - WINDOW) : seqNow - WINDOW);
    getWorldEventsSince(start, 6000, { ...(prov !== 'all' ? { prov } : {}), ...(type ? { type } : {}), ...(actor ? { actor } : {}) }).then(
      (r) => {
        if (!alive) return;
        setFetched(r.events);
        setFrom(start);
        setState('ready');
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      },
    );
    return () => {
      alive = false;
    };
  }, [store, ready, prov, type, actor, highlight]);

  const events = useMemo(() => {
    const match = (e: WorldEvent) =>
      (prov === 'all' || e.prov === prov) && (!type || e.type === type) && (!actor || e.actor === actor || (e.type === 'interaction.happened' && actor.startsWith('res_') && (e.p.a === Number(actor.slice(4)) - 1 || e.p.b === Number(actor.slice(4)) - 1)));
    const byseq = new Map<number, WorldEvent>();
    for (const e of fetched) if (match(e)) byseq.set(e.seq, e);
    for (const e of live) if (match(e)) byseq.set(e.seq, e);
    return [...byseq.values()].filter((e) => ambient || type !== '' || !isAmbientWorldEvent(e.type)).sort((a, b) => b.seq - a.seq);
  }, [fetched, live, prov, type, actor, ambient]);

  useEffect(() => {
    if (highlight === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seq="${highlight}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [highlight, events]);

  const name = (kind: EntityKind, id: string) => entityName({ kind, id }, snapshot, town);
  const residentName = (i: number) => snapshot?.residents[i]?.name ?? `resident ${i + 1}`;
  const shown = highlight !== null ? events : events.slice(0, limit);

  return (
    <div className={styles.log}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>World Log</h2>
          <p className={styles.lede}>Every recorded change to the town, newest first, with who caused it.</p>
        </div>
        <Link href={ROUTES.traces} className={styles.tracesLink}>
          <Icon name="traces" size={14} />
          Traces
        </Link>
      </div>

      <div className={styles.filters}>
        <div className={styles.provs} role="radiogroup" aria-label="Provenance">
          {PROVS.map((p) => (
            <button key={p.value} type="button" role="radio" aria-checked={prov === p.value} className={styles.provBtn} onClick={() => setProv(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className={styles.row}>
          <select className={styles.select} value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type">
            <option value="">All types</option>
            {WORLD_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className={styles.toggle}>
            <input type="checkbox" checked={ambient} onChange={(e) => setAmbient(e.target.checked)} />
            Movement and decisions
          </label>
        </div>
        {actor && (
          <div className={styles.row}>
            <span className={styles.actorChip}>
              Only {name(actor.startsWith('res_') ? 'resident' : actor.startsWith('agt_') ? 'agent' : 'building', actor)}
              <button type="button" aria-label="Show every actor" onClick={() => (setActor(null), store.setState({ logFocus: null }))}>
                <Icon name="x" size={12} />
              </button>
            </span>
          </div>
        )}
      </div>

      {state === 'error' && <p className={styles.note}>Could not read the log: {error}</p>}
      <ol ref={listRef} className={styles.list} aria-busy={state === 'loading' || undefined} aria-label="World events">
        {shown.map((e) => {
          const chip = provenanceChip(e.prov, e.obs);
          const c = clockParts(e.tick);
          const ref = actorRef(e);
          const run = eventRunLink(e);
          return (
            <li key={e.seq} data-seq={e.seq} className={styles.item} data-highlight={e.seq === highlight || undefined} data-ambient={isAmbientWorldEvent(e.type) || undefined}>
              <span className={styles.time}>
                D{c.day} {c.hh}:{c.mm}
              </span>
              <span className={styles.prov} data-real={chip.real || undefined} data-prov={e.prov} title={chip.detail}>
                <Icon name={chip.icon} size={11} />
                {chip.label}
              </span>
              <span className={styles.text}>
                {ref ? (
                  <button type="button" className={styles.textBtn} onClick={() => store.getState().focusEntity(ref)}>
                    {eventText(e, name, residentName)}
                  </button>
                ) : (
                  eventText(e, name, residentName)
                )}
              </span>
              <span className={styles.meta}>
                {run && (
                  <Link className={styles.traceLink} href={linkTo(ROUTES.traces, { runId: run.runId, seq: run.seq })} title={`Run events ${e.cause!.seqFrom}–${e.cause!.seqTo} in Traces`}>
                    Trace →
                  </Link>
                )}
                <span className={styles.seq}>#{e.seq}</span>
              </span>
            </li>
          );
        })}
        {state === 'ready' && events.length === 0 && <li className={styles.note}>No events match. {from !== null && from > 0 ? 'Older events may have been pruned (ambient events are kept for 3 sim days).' : ''}</li>}
      </ol>
      {highlight === null && events.length > limit && (
        <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + SHOW)}>
          Show {Math.min(SHOW, events.length - limit)} more
        </Button>
      )}
    </div>
  );
}
