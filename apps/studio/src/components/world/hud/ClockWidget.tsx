'use client';
/**
 * The clock and speed widget (contract §1.1 D): Day · time, ⏸ 1× 4× 16×,
 * the pending chip while a speed command travels, the sound toggle, and the
 * speed caption (row 2; at 1280 a tooltip, shown for 3 s after a change).
 * The control shows the engine's speed, never the requested one.
 */
import type { AgentPresence, WorldSpeed } from '@runloop-world/events';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWorld, useWorldStore } from '../../../world/context';
import { sendWorldCommand, speedCaption } from '../../../world/send';
import { Icon } from '../../../ui/Icon';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { WorldClockText, WorldStatusChip } from './bits';
import styles from './hud.module.css';
import { uiSound } from './sound';

const NO_AGENTS: AgentPresence[] = [];

const SPEEDS = [
  { value: '0', label: 'Pause', icon: 'pause' as const, iconOnly: true, title: 'Pause the world (Space)' },
  { value: '1', label: '1×', title: 'Simulated time at 1× (1 sim minute per second)' },
  { value: '4', label: '4×', title: 'Simulated time at 4×' },
  { value: '16', label: '16×', title: 'Simulated time at 16×' },
];
const CYCLE: WorldSpeed[] = [1, 4, 16];

export function useWorldSpeed() {
  const store = useWorldStore();
  const status = useWorld((s) => s.status);
  const speed = useWorld((s) => (s.snapshot?.speed ?? 0) as WorldSpeed);
  const prevSpeed = useWorld((s) => (s.snapshot?.prevSpeed ?? 1) as WorldSpeed);
  const pending = useWorld((s) => Object.values(s.pending).find((p) => p.command.type === 'clock.set') ?? null);
  const ready = status === 'live' || status === 'reconnecting';
  const setSpeed = (v: WorldSpeed) => {
    if (!ready || v === speed) return;
    uiSound('toggle');
    const label = v === 0 ? 'Pausing…' : speed === 0 ? `Resuming at ${v}×…` : `Setting ${v}×…`;
    void sendWorldCommand(store, { type: 'clock.set', speed: v }, label);
  };
  return { speed, prevSpeed, pending, ready, setSpeed };
}

export default function ClockWidget({ size, sound, onFind }: { size: 'phone' | 's' | 'm' | 'l'; sound?: ReactNode; onFind?: () => void }) {
  const { speed, prevSpeed, pending, ready, setSpeed } = useWorldSpeed();
  const clock = useWorld((s) => s.clock);
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents ?? NO_AGENTS);
  const live = agents.filter((a) => a.health === 'live').map((a) => a.displayName);
  const caption = ready ? speedCaption(speed, live) : 'The world clock is shown once the runtime answers.';
  // At 1280 the caption is a tooltip, and shows for 3 s after a speed change.
  const [flash, setFlash] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 3000);
    return () => clearTimeout(t);
  }, [speed]);

  const pendingChip = pending && (
    <span className={styles.pendingChip} data-state={pending.state} role="status">
      {pending.state === 'sending' ? pending.label : `Not changed: ${String(pending.reason ?? 'rejected').replace(/_/g, ' ')}`}
    </span>
  );

  if (size === 'phone') {
    const next = CYCLE[(CYCLE.indexOf(speed === 0 ? prevSpeed : speed) + 1) % CYCLE.length]!;
    return (
      <div className={styles.phoneBar} role="group" aria-label="World controls" data-hud-fade>
        <WorldStatusChip />
        <WorldClockText />
        <button type="button" className={styles.iconBtn} disabled={!ready} aria-label={speed === 0 ? `Resume at ${prevSpeed}×` : 'Pause the world'} onClick={() => setSpeed(speed === 0 ? prevSpeed : 0)}>
          <Icon name={speed === 0 ? 'play' : 'pause'} size={16} />
        </button>
        <button type="button" className={styles.speedCycle} disabled={!ready} aria-label={`World speed ${speed === 0 ? 'paused' : `${speed}×`}; switch to ${next}×`} onClick={() => setSpeed(next)}>
          {speed === 0 ? `${prevSpeed}×` : `${speed}×`}
        </button>
        {sound}
        {onFind && (
          <button type="button" className={styles.iconBtn} aria-label="Find people, places and commands" onClick={onFind}>
            <Icon name="search" size={16} />
          </button>
        )}
        {pendingChip}
      </div>
    );
  }

  const showCaption = size !== 's' || flash;
  return (
    <div className={styles.clock} role="group" aria-label="World clock" data-hud-fade title={size === 's' ? caption : undefined}>
      <div className={styles.clockRow}>
        <Icon name="clock" size={15} className={styles.clockIcon} />
        <WorldClockText />
        <SegmentedControl label="World speed" size="sm" glass options={SPEEDS} value={String(speed)} onChange={(v) => setSpeed(Number(v) as WorldSpeed)} />
        {sound && <span className={styles.clockSep} aria-hidden="true" />}
        {sound}
      </div>
      {showCaption && (
        <p className={styles.caption} data-flash={size === 's' || undefined}>
          {caption}
          {speed === 0 && ready && (
            <button type="button" className={styles.linkButton} onClick={() => setSpeed(prevSpeed)}>
              Resume at {prevSpeed}×
            </button>
          )}
          {clock?.lagging && <span className={styles.lagging}> · Running behind: the runtime skipped ticks it could not run in time.</span>}
        </p>
      )}
      {pendingChip}
    </div>
  );
}
