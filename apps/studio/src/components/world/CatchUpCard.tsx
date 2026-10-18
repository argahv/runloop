'use client';
import { useEffect, useState } from 'react';
import { safeStorage } from '../../state/prefs';
import { getWorldEventsSince } from '../../world/api';
import { attentionTitle, type AttentionItem } from '../../world/attention';
import { catchUpFooter, summarizeSince, type CatchUp } from '../../world/catchUp';
import { useWorld, useWorldStore } from '../../world/context';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { useEntityNames } from './AttentionTicker';
import styles from './WorldHome.module.css';

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

/**
 * "While you were away" (UX §5): on arrival, if the world moved on by an hour
 * of sim time or five notable things since this viewer last looked, a card
 * lists the viewer's agents first, then the top town groups. Every line is a
 * template over recorded events and links to them.
 */
export default function CatchUpCard({ onOpen }: { onOpen: (item: AttentionItem) => void }) {
  const store = useWorldStore();
  const worldId = useWorld((s) => s.snapshot?.worldId ?? null);
  const name = useEntityNames();
  const [summary, setSummary] = useState<(CatchUp & { capped: boolean }) | null>(null);
  const [dismissed, setDismissed] = useState(false);

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

  if (!summary || dismissed) return null;
  const hours = Math.floor(summary.simMinutes / 60);
  const span = hours >= 1 ? `${hours} h ${summary.simMinutes % 60} min` : `${summary.simMinutes} min`;
  const line = (it: AttentionItem) => (
    <li key={it.key}>
      <button type="button" className={styles.catchRow} data-severity={it.severity} onClick={() => onOpen(it)}>
        <span className={styles.catchText}>{attentionTitle(it, name)}</span>
        <span className={styles.tickerMeta}>
          {it.resolved ? 'resolved · ' : ''}
          {it.events ? (it.events.count > 1 ? `${it.events.count} events` : `seq ${it.events.first}`) : ''}
        </span>
      </button>
    </li>
  );
  return (
    <section className={styles.catchUp} aria-labelledby="catchup-title">
      <div className={styles.catchHead}>
        <h2 id="catchup-title" className={styles.catchTitle}>
          <Icon name="clock" size={15} />
          While you were away · {span} of town time
        </h2>
        <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss the summary" onClick={() => setDismissed(true)} />
      </div>
      {summary.agents.length > 0 && (
        <>
          <h3 className={styles.feedHead}>Your agents</h3>
          <ul className={styles.catchList}>{summary.agents.slice(0, 4).map(line)}</ul>
        </>
      )}
      {summary.town.length > 0 && (
        <>
          <h3 className={styles.feedHead}>In town</h3>
          <ul className={styles.catchList}>{summary.town.map(line)}</ul>
        </>
      )}
      <p className={styles.catchFoot}>
        {catchUpFooter(summary)}
        {summary.capped ? ' · only the first 20,000 were read' : ''}
      </p>
    </section>
  );
}
