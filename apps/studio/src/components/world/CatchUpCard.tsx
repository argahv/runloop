'use client';
import { useEffect, useState } from 'react';
import { safeStorage } from '../../state/prefs';
import { getWorldEventsSince } from '../../world/api';
import { attentionTitle, type AttentionItem } from '../../world/attention';
import { catchUpFooter, summarizeSince, type CatchUp } from '../../world/catchUp';
import { useWorld, useWorldStore } from '../../world/context';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { useEntityNames } from './hud/bits';
import styles from './hud/hud.module.css';

export const LAST_SEEN_KEY = 'runloop.world.lastSeen.v1';
/** At most this many events are read for the summary. */
const CATCH_UP_CAP = 20_000;

interface LastSeen {
  worldId: string;
  seq: number;
}

function readLastSeen(): LastSeen | null {
  try {
    const v = JSON.parse(safeStorage.getItem(LAST_SEEN_KEY) ?? 'null') as Partial<LastSeen> | null;
    return v && typeof v.worldId === 'string' && Number.isInteger(v.seq) ? { worldId: v.worldId, seq: v.seq! } : null;
  } catch {
    return null;
  }
}

/** Remember what this viewer has seen (every 15 s and when the tab is hidden). */
export function useLastSeenTracker(): void {
  const store = useWorldStore();
  useEffect(() => {
    const save = () => {
      const s = store.getState().snapshot;
      if (s && document.visibilityState === 'visible') safeStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ worldId: s.worldId, seq: s.seq }));
    };
    const onHide = () => {
      const s = store.getState().snapshot;
      if (s) safeStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ worldId: s.worldId, seq: s.seq }));
    };
    const id = setInterval(save, 15_000);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [store]);
}

/** The catch-up since this viewer last looked (null when there is nothing to tell). */
export function useCatchUp(): (CatchUp & { capped: boolean }) | null {
  const store = useWorldStore();
  const worldId = useWorld((s) => s.snapshot?.worldId ?? null);
  const [summary, setSummary] = useState<(CatchUp & { capped: boolean }) | null>(null);

  useEffect(() => {
    if (!worldId) return;
    const seen = readLastSeen();
    const now = store.getState().snapshot!;
    store.getState().setLastSeenSeq(seen?.worldId === worldId ? seen.seq : null);
    if (!seen || seen.worldId !== worldId || seen.seq >= now.seq) return;
    let alive = true;
    getWorldEventsSince(seen.seq, CATCH_UP_CAP).then(
      ({ events, capped }) => {
        if (!alive) return;
        const c = summarizeSince(events, seen.seq);
        if (c) setSummary({ ...c, capped });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [store, worldId]);
  return summary;
}

/**
 * "While you were away" (UX §5), the first notification (contract §4.1): on
 * arrival, if the world moved on by an hour of sim time or five notable
 * things since this viewer last looked, it lists the viewer's agents first,
 * then the top town groups. Every line is a template over recorded events and
 * links to them. Collapsed to one line until opened.
 */
export default function CatchUpCard({ summary, onOpen, onDismiss }: { summary: CatchUp & { capped: boolean }; onOpen: (item: AttentionItem) => void; onDismiss: () => void }) {
  const name = useEntityNames();
  const [open, setOpen] = useState(false);
  const count = summary.agents.length + summary.town.length;
  const hours = Math.floor(summary.simMinutes / 60);
  const span = hours >= 1 ? `${hours} h ${summary.simMinutes % 60} min` : `${summary.simMinutes} min`;
  const line = (it: AttentionItem) => (
    <li key={it.key}>
      <button type="button" className={styles.catchRow} data-severity={it.severity} onClick={() => onOpen(it)}>
        <span className={styles.catchText}>{attentionTitle(it, name)}</span>
        <span className={styles.feedMeta}>
          {it.resolved ? 'resolved · ' : ''}
          {it.events ? (it.events.count > 1 ? `${it.events.count} events` : `seq ${it.events.first}`) : ''}
        </span>
      </button>
    </li>
  );
  return (
    <section className={`${styles.note} ${styles.catchUp}`} aria-labelledby="catchup-title">
      <div className={styles.noteHead}>
        <button type="button" className={styles.noteMain} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="clock" size={15} />
          <span className={styles.noteBody}>
            <span id="catchup-title" className={styles.noteTitle}>
              While you were away · {count}
            </span>
            <span className={styles.noteMeta}>{span} of town time · {open ? 'hide' : 'show what happened'}</span>
          </span>
        </button>
        <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss the summary" onClick={onDismiss} />
      </div>
      {open && summary.agents.length > 0 && (
        <>
          <h3 className={styles.feedHead}>Your agents</h3>
          <ul className={styles.catchList}>{summary.agents.slice(0, 4).map(line)}</ul>
        </>
      )}
      {open && summary.town.length > 0 && (
        <>
          <h3 className={styles.feedHead}>In town</h3>
          <ul className={styles.catchList}>{summary.town.map(line)}</ul>
        </>
      )}
      {open && (
        <p className={styles.catchFoot}>
          {catchUpFooter(summary)}
          {summary.capped ? ' · only the first 20,000 were read' : ''}
        </p>
      )}
    </section>
  );
}
