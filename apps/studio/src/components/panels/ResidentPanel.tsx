'use client';
import type { WorldEvent } from '@runloop-world/events';
import { useEffect, useMemo, useState } from 'react';
import { getWorldEvents } from '../../world/api';
import { useWorld, useWorldStore, useWorldTick } from '../../world/context';
import { clockParts } from '../../world/interpolate';
import { eventText, residentView } from '../../world/selectors';
import { entityName } from '../../world/entityIndex';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Icon, type IconName } from '../../ui/Icon';
import ExplanationBlock from './ExplanationBlock';
import styles from './panels.module.css';

const NEED_ICON: Record<string, IconName> = { hunger: 'coins', energy: 'moon', social: 'message' };
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** A simulated resident (plan §5): ◇ Simulated, Now, Why, needs, schedule, relationships, Follow. */
export default function ResidentPanel({ id }: { id: string }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const seed = useWorld((s) => s.info?.seed ?? 0);
  const snapshot = useWorld((s) => s.snapshot);
  useWorld((s) => s.rev);
  const follow = useWorld((s) => s.follow);
  const log = useWorld((s) => s.log);
  const tick = useWorldTick(1);
  const r = snapshot?.residents.find((x) => x.id === id) ?? null;

  if (!r || !snapshot || !town) return <p className={styles.panel}>This resident is not in the current world.</p>;
  const v = residentView(snapshot, town, seed, r, tick);
  const following = follow?.kind === 'resident' && follow.id === id;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={styles.avatar} style={{ background: r.outfit.top }} aria-hidden="true">
            {initials(r.name)}
          </span>
          <div>
            <h2 className={styles.title}>{v.name}</h2>
            <p className={styles.subtitle}>{v.role}</p>
          </div>
        </div>
        <div className={styles.chips}>
          <Chip icon={v.chip.icon} title={v.chip.detail}>
            {v.chip.label}
          </Chip>
          <Chip mono>{r.id}</Chip>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant={following ? 'secondary' : 'ghost'} icon="target" aria-pressed={following} aria-keyshortcuts="F" onClick={() => store.getState().setFollow(following ? null : { kind: 'resident', id })}>
            {following ? 'Following' : 'Follow'}
          </Button>
          <Button size="sm" variant="ghost" icon="traces" onClick={() => store.getState().showInLog({ actor: id })}>
            Events
          </Button>
        </div>
      </div>

      <section className={styles.section} aria-labelledby="now-title">
        <h3 id="now-title" className={styles.h3}>
          Now
        </h3>
        <div className={styles.card}>
          <span className={styles.nowLine}>{v.now}</span>
          <span className={styles.note}>
            {v.since} · home {v.home}
            {v.work ? ` · works at ${v.work}` : ''}
          </span>
        </div>
      </section>

      <ExplanationBlock residentId={id} atSeq={v.lastDecisionSeq} />

      <section className={styles.section} aria-labelledby="needs-title">
        <div className={styles.sectionHead}>
          <h3 id="needs-title" className={styles.h3}>
            Needs
          </h3>
          <span className={styles.note}>0 satisfied · 100 urgent · mark = decides</span>
        </div>
        <ul className={styles.needs}>
          {v.needs.map((n) => (
            <li key={n.id} className={styles.need}>
              <span className={styles.needLabel}>
                <Icon name={NEED_ICON[n.id] ?? 'dot'} size={13} />
                {n.label}
              </span>
              <span className={styles.bar} data-over={n.points >= n.threshold || undefined} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={n.points} aria-label={`${n.label} ${n.points} of 100`}>
                <span className={styles.barFill} style={{ width: `${n.points}%` }} />
                <span className={styles.barMark} style={{ left: `${n.threshold}%` }} title={`Decides at ${n.threshold}`} />
              </span>
              <span className={styles.needValue}>{n.points}/100</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="sched-title">
        <div className={styles.sectionHead}>
          <h3 id="sched-title" className={styles.h3}>
            Schedule
          </h3>
          <span className={styles.note}>{v.schedule.label} · times shift up to 20 min per resident</span>
        </div>
        <ol className={styles.blocks}>
          {v.schedule.blocks.map((b) => (
            <li key={b.id} className={styles.block} data-current={b.current || undefined} aria-current={b.current ? 'time' : undefined}>
              <span className={styles.mono}>
                {b.from}–{b.to}
              </span>
              <span>{b.label}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="rel-title">
        <h3 id="rel-title" className={styles.h3}>
          Relationships
        </h3>
        {v.relationships.length === 0 ? (
          <p className={styles.note}>No conversations recorded with anyone yet.</p>
        ) : (
          <ul className={styles.list}>
            {v.relationships.map((x) => (
              <li key={x.id}>
                <button type="button" className={styles.row} onClick={() => store.getState().focusEntity({ kind: 'resident', id: x.id })}>
                  <span className={styles.dot} style={{ background: snapshot.residents[x.idx]?.outfit.top }} aria-hidden="true" />
                  <span className={styles.rowMain}>{x.name}</span>
                  <span className={styles.rowMeta}>affinity {x.affinity}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RecentEvents id={id} log={log} />
    </div>
  );
}

/** The resident's latest recorded events: this session's stream plus a page from the log. */
function RecentEvents({ id, log }: { id: string; log: readonly WorldEvent[] }) {
  const store = useWorldStore();
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const [fetched, setFetched] = useState<WorldEvent[]>([]);
  const seq = snapshot?.seq ?? 0;
  useEffect(() => {
    let live = true;
    getWorldEvents({ actor: id, after: Math.max(0, seq - 6000), limit: 1000 }).then(
      (p) => live && setFetched(p.events.slice(-8)),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // Only when the panel opens for this resident.
  }, [id]);
  const events = useMemo(() => {
    const byseq = new Map<number, WorldEvent>();
    for (const e of fetched) byseq.set(e.seq, e);
    for (const e of log) if (e.actor === id) byseq.set(e.seq, e);
    return [...byseq.values()].sort((a, b) => b.seq - a.seq).slice(0, 6);
  }, [fetched, log, id]);
  const name = (kind: Parameters<typeof entityName>[0]['kind'], eid: string) => entityName({ kind, id: eid }, snapshot, town);
  const residentName = (i: number) => snapshot?.residents[i]?.name ?? `resident ${i + 1}`;
  return (
    <section className={styles.section} aria-labelledby="recent-title">
      <h3 id="recent-title" className={styles.h3}>
        Recent events
      </h3>
      {events.length === 0 ? (
        <p className={styles.note}>None recorded in the retained log.</p>
      ) : (
        <ul className={styles.list}>
          {events.map((e) => {
            const c = clockParts(e.tick);
            return (
              <li key={e.seq}>
                <button type="button" className={styles.row} onClick={() => store.getState().showInLog({ seq: e.seq, actor: id })}>
                  <span className={styles.rowMeta}>
                    {c.hh}:{c.mm}
                  </span>
                  <span className={styles.rowMain}>{eventText(e, name, residentName)}</span>
                  <span className={styles.rowMeta}>#{e.seq}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
