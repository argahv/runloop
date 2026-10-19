'use client';
/**
 * The guide banner (contract §1.1 G), first-visit controls hint and the
 * "HUD hidden" hint. The banner says what the town is waiting for: pick a lot
 * (with every lot as a button, the keyboard route), inside a building, or
 * following someone; Esc always backs out.
 */
import { useEffect, useMemo, useState } from 'react';
import { safeStorage } from '../../../state/prefs';
import { useWorld, useWorldStore } from '../../../world/context';
import { entityName } from '../../../world/entityIndex';
import { Kbd } from '../../../ui/Kbd';
import styles from './hud.module.css';
import { lotPickModel } from './lots';
import { uiSound } from './sound';

/** The lots Add to World can pick from: free ones glow; taken ones show their agent's name. */
export function useLotPickModel() {
  const town = useWorld((s) => s.town);
  // The snapshot is folded in place: `rev` says when its agents changed (a lot just taken reads taken at once).
  const rev = useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents);
  const lotPick = useWorld((s) => s.lotPick);
  return useMemo(() => (lotPick && town ? lotPickModel(town, agents ?? [], lotPick.selected) : null), [lotPick, town, agents, rev]);
}

export function GuideBanner() {
  const store = useWorldStore();
  const lotPick = useLotPickModel();
  const reason = useWorld((s) => s.lotPick?.reason ?? null);
  const entered = useWorld((s) => s.entered);
  const follow = useWorld((s) => s.follow);
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const agents = useWorld((s) => s.agents);

  if (lotPick && !lotPick.selected) {
    const free = lotPick.lots.filter((l) => l.state === 'free');
    return (
      <div className={styles.guide} role="region" aria-label="Pick a lot">
        <p className={styles.guideText}>
          {reason ?? (free.length ? 'Pick a free lot for your agent' : 'Every agent lot is taken')}
          <span className={styles.guideMeta}>
            · <Kbd keys={['Esc']} /> to cancel
          </span>
        </p>
        <div className={styles.lotButtons} role="group" aria-label="Agent lots">
          {lotPick.lots.map((l) => (
            <button
              key={l.id}
              type="button"
              className={styles.lotBtn}
              data-state={l.state}
              disabled={l.state === 'taken'}
              onPointerEnter={() => uiSound('hover')}
              onClick={() => {
                uiSound('select');
                store.getState().pickLot(l.id);
              }}
            >
              {l.label}
            </button>
          ))}
          <button type="button" className={styles.lotBtn} data-state="cancel" onClick={() => store.getState().cancelLotPick()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (lotPick) return null;
  if (entered) {
    const name = entityName({ kind: 'building', id: entered }, snapshot, town, agents);
    return (
      <div className={styles.guide} role="status">
        <p className={styles.guideText}>
          Inside {name}
          <span className={styles.guideMeta}>
            · <Kbd keys={['Esc']} /> to leave
          </span>
        </p>
      </div>
    );
  }
  if (follow) {
    return (
      <div className={styles.guide} role="status">
        <p className={styles.guideText}>
          Following {entityName(follow, snapshot, town, agents)}
          <span className={styles.guideMeta}>
            · drag or <Kbd keys={['Esc']} /> to stop
          </span>
        </p>
      </div>
    );
  }
  return null;
}

const HINT_KEY = 'runloop.hud.hints.v1';

/** First visit only: how to get around (touch words on a phone), for 6 s after the town appears or until the first input. */
export function ControlsHint({ touch = false }: { touch?: boolean }) {
  const [show, setShow] = useState(false);
  // It starts (and counts as seen) only once the town is on screen: never over the loading veil.
  const ready = useWorld((s) => s.townReady);
  useEffect(() => {
    if (!ready || safeStorage.getItem(HINT_KEY)) return;
    setShow(true);
    safeStorage.setItem(HINT_KEY, '1');
    const hide = () => setShow(false);
    const t = setTimeout(hide, 6000);
    const opts = { once: true, capture: true } as const;
    window.addEventListener('pointerdown', hide, opts);
    window.addEventListener('wheel', hide, opts);
    window.addEventListener('keydown', hide, opts);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', hide, opts);
      window.removeEventListener('wheel', hide, opts);
      window.removeEventListener('keydown', hide, opts);
    };
  }, [ready]);
  if (!show) return null;
  return (
    <p className={styles.controlsHint} role="status">
      {touch ? (
        'Drag to move · Pinch to zoom · Twist to turn · Double-tap a building to go in'
      ) : (
        <>
          Drag to move · Scroll to zoom · Right-drag to turn · <Kbd keys={['Esc']} /> for menu
        </>
      )}
    </p>
  );
}

/** "HUD hidden · press H", for 2 s after hiding. */
export function HiddenHint({ hidden }: { hidden: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!hidden) return setShow(false);
    setShow(true);
    const t = setTimeout(() => setShow(false), 2000);
    return () => clearTimeout(t);
  }, [hidden]);
  if (!show) return null;
  return (
    <p className={styles.hiddenHint} role="status">
      HUD hidden · press <Kbd keys={['H']} />
    </p>
  );
}
