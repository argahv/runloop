'use client';
import type { EntityRef } from '@runloop-world/events';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { announces, arrivalItems, attentionTitle, compareItems, nextTickerItem, type AttentionItem, type Severity } from '../../world/attention';
import { useWorld, useWorldStore } from '../../world/context';
import { entityName } from '../../world/entityIndex';
import { clockParts } from '../../world/interpolate';
import { provenanceChip } from '../../world/selectors';
import { Icon, type IconName } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import styles from './WorldHome.module.css';

/** "14:20" today, "Day 2 · 14:20" on another day. */
function whenText(tick: number, today: number): string {
  const c = clockParts(tick);
  return c.day === today ? `${c.hh}:${c.mm}` : `Day ${c.day} · ${c.hh}:${c.mm}`;
}

const SEV_ICON: Record<Severity, IconName> = { critical: 'alert', attention: 'bell', notable: 'dot', ambient: 'dot' };
const SEV_LABEL: Record<Severity, string> = { critical: 'Needs you', attention: 'Attention', notable: 'Notable', ambient: 'Ambient' };

/** A name resolver over the current snapshot, town and agents. */
export function useEntityNames(): (ref: EntityRef) => string {
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const agents = useWorld((s) => s.agents);
  return (ref) => entityName(ref, snapshot, town, agents);
}

/**
 * The bottom ticker (UX §5): at most one item every 4 s (critical items skip
 * the wait), paused while hovered, grouped and ordered by severity with real
 * agents first. Ambient movement never shows here. The feed lists every
 * group with the events behind it. Map (M) and List (L) sit beside it.
 */
export default function AttentionTicker({ onOpen }: { onOpen: (item: AttentionItem) => void }) {
  const store = useWorldStore();
  const attention = useWorld((s) => s.attention);
  const arrivals = useWorld((s) => s.arrivals);
  const overlay = useWorld((s) => s.overlay);
  const today = useWorld((s) => (s.clock ? clockParts(s.clock.tick).day : 0));
  const name = useEntityNames();
  const items = useMemo(() => [...attention, ...arrivalItems(arrivals)].sort(compareItems), [attention, arrivals]);
  const [current, setCurrent] = useState<AttentionItem | null>(null);
  const [announce, setAnnounce] = useState('');
  const hovered = useRef(false);
  const lastShown = useRef(Number.NEGATIVE_INFINITY);
  const shown = useRef(new Map<string, number>());
  const [feedOpen, setFeedOpen] = useState(false);
  const feedId = useId();
  const root = useRef<HTMLDivElement>(null);
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    const step = () => {
      if (hovered.current) return;
      const now = Date.now();
      const next = nextTickerItem(items, now, lastShown.current, shown.current);
      if (!next) return;
      lastShown.current = now;
      shown.current.set(next.key, next.events?.count ?? 1);
      setCurrent(next);
      if (announces(next)) setAnnounce(attentionTitle(next, nameRef.current));
    };
    step();
    const id = setInterval(step, 500);
    return () => clearInterval(id);
  }, [items]);

  useEffect(() => {
    if (!feedOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setFeedOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setFeedOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [feedOpen]);

  const open = items.filter((i) => !i.resolved);
  const needsYou = open.filter((i) => i.severity === 'critical' || i.severity === 'attention').length;
  const current2 = current && items.find((i) => i.key === current.key);
  const cur = current2 ?? current;

  return (
    <div className={styles.ticker} ref={root}>
      <div className={styles.tickerToggles} role="group" aria-label="Views">
        <button type="button" className={styles.toggleBtn} aria-pressed={overlay === 'map'} aria-keyshortcuts="M" onClick={() => store.getState().setOverlay(overlay === 'map' ? 'none' : 'map')}>
          <Icon name="map" size={14} />
          Map <Kbd keys={['M']} />
        </button>
        <button type="button" className={styles.toggleBtn} aria-pressed={overlay === 'list'} aria-keyshortcuts="L" onClick={() => store.getState().setOverlay(overlay === 'list' ? 'none' : 'list')}>
          <Icon name="table" size={14} />
          List <Kbd keys={['L']} />
        </button>
      </div>
      <div
        className={styles.tickerItem}
        onPointerEnter={() => (hovered.current = true)}
        onPointerLeave={() => (hovered.current = false)}
        onFocus={() => (hovered.current = true)}
        onBlur={() => (hovered.current = false)}
      >
        {cur ? (
          <button type="button" className={styles.tickerBtn} data-severity={cur.severity} data-resolved={cur.resolved || undefined} onClick={() => onOpen(cur)}>
            <Icon name={SEV_ICON[cur.severity]} size={14} />
            <span className={styles.tickerText}>{attentionTitle(cur, name)}</span>
            {cur.resolved && <span className={styles.tickerMeta}>resolved</span>}
            <span className={styles.tickerMeta}>
              {provenanceChip(cur.prov).label}
              {cur.events ? ` · ${whenText(cur.lastTick, today)}` : ''}
            </span>
          </button>
        ) : (
          <span className={styles.tickerQuiet}>Nothing needs you. The town goes about its day.</span>
        )}
      </div>
      <button
        type="button"
        className={styles.feedBtn}
        data-urgent={needsYou > 0 || undefined}
        aria-expanded={feedOpen}
        aria-controls={feedId}
        aria-label={`Attention feed: ${needsYou} need you, ${open.length} in all`}
        onClick={() => setFeedOpen((o) => !o)}
      >
        <Icon name="bell" size={14} />
        {needsYou > 0 ? `${needsYou} need you` : `Feed · ${open.length}`}
      </button>
      {feedOpen && (
        <div id={feedId} className={styles.feed} role="dialog" aria-label="Attention feed">
          {open.length === 0 ? (
            <p className={styles.popEmpty}>Nothing yet. Sessions, closures, conversations and anything that needs you will gather here.</p>
          ) : (
            (['critical', 'attention', 'notable'] as const).map((sev) => {
              const group = open.filter((i) => i.severity === sev);
              if (group.length === 0) return null;
              return (
                <section key={sev} className={styles.feedGroup}>
                  <h3 className={styles.feedHead}>{SEV_LABEL[sev]}</h3>
                  <ul>
                    {group.map((i) => (
                      <li key={i.key}>
                        <button
                          type="button"
                          className={styles.feedRow}
                          data-severity={i.severity}
                          onClick={() => {
                            setFeedOpen(false);
                            onOpen(i);
                          }}
                        >
                          <Icon name={SEV_ICON[i.severity]} size={13} />
                          <span className={styles.feedText}>{attentionTitle(i, name)}</span>
                          <span className={styles.tickerMeta}>
                            {i.events ? (i.events.count > 1 ? `seq ${i.events.first}–${i.events.last}` : `seq ${i.events.first}`) : 'from Arrivals'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
