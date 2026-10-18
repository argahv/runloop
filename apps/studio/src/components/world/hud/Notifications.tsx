'use client';
/**
 * Notifications (contract §1.1 E, §4.1): game-style popups under the clock.
 * Critical, attention and real-agent items pop (one every 4 s; critical skips
 * the wait and stays until acted on); simulated notables only reach the bell's
 * list. The catch-up is the first one. Each says what happened from recorded
 * facts, with an icon, its provenance and when; a click opens its subject.
 * Screen readers hear critical and attention items.
 */
import { useEffect, useRef, useState } from 'react';
import { announces, attentionTitle, type AttentionItem } from '../../../world/attention';
import { useWorld } from '../../../world/context';
import { clockParts } from '../../../world/interpolate';
import { provenanceChip } from '../../../world/selectors';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/Icon';
import CatchUpCard, { useCatchUp } from '../CatchUpCard';
import { useEntityNames, whenText } from './bits';
import styles from './hud.module.css';
import { nextPopup, pushPopup, trimPopups, type Popup } from './notify';
import { SEV_ICON, useNotificationItems } from './TopBar';

export default function Notifications({ onOpen, single }: { onOpen: (item: AttentionItem) => void; single?: boolean }) {
  const items = useNotificationItems();
  const today = useWorld((s) => (s.clock ? clockParts(s.clock.tick).day : 0));
  const name = useEntityNames();
  const catchUp = useCatchUp();
  const [catchUpGone, setCatchUpGone] = useState(false);
  const [popups, setPopups] = useState<Popup[]>([]);
  const [announce, setAnnounce] = useState('');
  const hover = useRef<string | null>(null);
  const lastShown = useRef(Number.NEGATIVE_INFINITY);
  const shown = useRef(new Map<string, number>());
  const nameRef = useRef(name);
  nameRef.current = name;

  const current = useRef<Popup[]>([]);
  useEffect(() => {
    const step = () => {
      const now = Date.now();
      const list = current.current;
      // Follow the items: a resolved condition leaves, an updated one shows its latest facts.
      let out = list.flatMap((p) => {
        const cur = items.find((i) => i.key === p.item.key);
        return cur && !cur.resolved ? [cur === p.item ? p : { ...p, item: cur }] : [];
      });
      const next = nextPopup(items, now, lastShown.current, shown.current);
      if (next) {
        lastShown.current = now;
        shown.current.set(next.key, next.events?.count ?? 1);
        out = pushPopup(out, next, now);
        if (announces(next)) setAnnounce(attentionTitle(next, nameRef.current));
      }
      const trimmed = trimPopups(out, now, hover.current);
      if (trimmed.length !== list.length || trimmed.some((p, i) => p !== list[i])) {
        current.current = trimmed;
        setPopups(trimmed);
      }
    };
    step();
    const id = setInterval(step, 500);
    return () => clearInterval(id);
  }, [items]);

  const dismiss = (key: string) => {
    current.current = current.current.filter((p) => p.item.key !== key);
    setPopups(current.current);
  };
  const visible = single ? popups.slice(0, 1) : popups;

  return (
    <div className={styles.notes} data-single={single || undefined}>
      {catchUp && !catchUpGone && !single && <CatchUpCard summary={catchUp} onOpen={onOpen} onDismiss={() => setCatchUpGone(true)} />}
      {visible.map(({ item }) => (
        <section
          key={item.key}
          className={styles.note}
          data-severity={item.severity}
          aria-label={item.severity === 'critical' ? 'Needs you' : 'Notification'}
          onPointerEnter={() => (hover.current = item.key)}
          onPointerLeave={() => (hover.current = null)}
          onFocus={() => (hover.current = item.key)}
          onBlur={() => (hover.current = null)}
        >
          <div className={styles.noteHead}>
            <button
              type="button"
              className={styles.noteMain}
              onClick={() => {
                dismiss(item.key);
                onOpen(item);
              }}
            >
              <Icon name={SEV_ICON[item.severity]} size={16} className={styles.noteIcon} />
              <span className={styles.noteBody}>
                <span className={styles.noteTitle}>{attentionTitle(item, name)}</span>
                <span className={styles.noteMeta}>
                  {item.severity === 'critical' ? 'Needs you · ' : ''}
                  {provenanceChip(item.prov).label}
                  {item.events ? ` · ${whenText(item.lastTick, today)}` : ' · from Arrivals'}
                </span>
              </span>
            </button>
            <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss" onClick={() => dismiss(item.key)} />
          </div>
        </section>
      ))}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
