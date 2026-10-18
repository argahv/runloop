'use client';
import type { AgentPresence, WorldSpeed } from '@runloop-world/events';
import { useEffect, useId, useRef, useState } from 'react';
import { useWorld, useWorldStore, useWorldTick } from '../../world/context';
import { clockParts } from '../../world/interpolate';
import { healthView } from '../../world/selectors';
import { sendWorldCommand, speedCaption } from '../../world/send';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd, modKey } from '../../ui/Kbd';
import { SegmentedControl } from '../../ui/SegmentedControl';
import styles from './WorldHome.module.css';

/** A stable empty list (zustand selectors must not return a new array each time). */
const NO_AGENTS: AgentPresence[] = [];

const SPEEDS = [
  { value: '0', label: 'Pause', icon: 'pause' as const, iconOnly: true, title: 'Pause the world (Space)' },
  { value: '1', label: '1×', title: 'Simulated time at 1× (1 sim minute per second)' },
  { value: '4', label: '4×', title: 'Simulated time at 4×' },
  { value: '16', label: '16×', title: 'Simulated time at 16×' },
];

/** The world clock, "Day 3 · 14:20", interpolated between server frames. */
export function WorldClockText() {
  const tick = useWorldTick(4);
  const hasClock = useWorld((s) => s.clock !== null);
  if (!hasClock) return <span className={styles.clockText}>Day – · --:--</span>;
  const { day, hh, mm } = clockParts(tick);
  return (
    <span className={styles.clockText} aria-label={`Day ${day}, ${hh}:${mm}`}>
      Day {day} · {hh}:{mm}
    </span>
  );
}

/**
 * Top chrome over the town (plan §5): world name and status, the clock with
 * ⏸ 1× 4× 16× and its caption, the live agent count, Add to World and ⌘K.
 * Speed changes are commands: the control shows the engine's speed, never
 * the requested one, and a pending chip while the command is on its way.
 */
export default function WorldBar({
  onAddToWorld,
  onOpenPalette,
  onOpenMenu,
  compact,
}: {
  onAddToWorld: () => void;
  onOpenPalette: () => void;
  /** Phones: the navigation drawer. */
  onOpenMenu?: () => void;
  compact?: boolean;
}) {
  const store = useWorldStore();
  const status = useWorld((s) => s.status);
  const clock = useWorld((s) => s.clock);
  const townName = useWorld((s) => s.town?.def.name ?? 'Runloop');
  const speed = useWorld((s) => s.snapshot?.speed ?? 0);
  const prevSpeed = useWorld((s) => s.snapshot?.prevSpeed ?? 1);
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents ?? NO_AGENTS);
  const pending = useWorld((s) => Object.values(s.pending).find((p) => p.command.type === 'clock.set') ?? null);
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);

  const live = agents.filter((a) => a.health === 'live');
  const ready = status === 'live' || status === 'reconnecting';
  const setSpeed = (v: WorldSpeed) => {
    if (v === speed) return;
    const label = v === 0 ? 'Pausing…' : speed === 0 ? `Resuming at ${v}×…` : `Setting ${v}×…`;
    void sendWorldCommand(store, { type: 'clock.set', speed: v }, label);
  };

  return (
    <header className={styles.bar} aria-label="World controls">
      {onOpenMenu && <Button variant="ghost" size="sm" iconOnly icon="menu" aria-label="Open navigation" onClick={onOpenMenu} />}
      <div className={styles.barGroup}>
        <div className={styles.worldName}>
          <span className={styles.townName}>{townName}</span>
          <WorldStatusChip />
        </div>
      </div>
      <div className={styles.clockGroup}>
        <div className={styles.clockRow}>
          <Icon name="clock" size={15} />
          <WorldClockText />
          {compact && <WorldStatusChip />}
          <SegmentedControl
            label="World speed"
            size="sm"
            glass
            options={SPEEDS}
            value={String(speed)}
            onChange={(v) => ready && setSpeed(Number(v) as WorldSpeed)}
          />
          {pending && (
            <span className={styles.pendingChip} data-state={pending.state} role="status">
              {pending.state === 'sending' ? pending.label : `Not changed: ${String(pending.reason ?? 'rejected').replace(/_/g, ' ')}`}
            </span>
          )}
        </div>
        {!compact && (
          <p className={styles.caption}>
            {ready ? speedCaption(speed as WorldSpeed, live.map((a) => a.displayName)) : 'The world clock is shown once the runtime answers.'}
            {speed === 0 && ready && (
              <button type="button" className={styles.linkButton} onClick={() => setSpeed(prevSpeed)}>
                Resume at {prevSpeed}×
              </button>
            )}
            {clock?.lagging && <span className={styles.lagging}> · Running behind: the runtime skipped ticks it could not run in time.</span>}
          </p>
        )}
      </div>
      <div className={styles.barActions}>
        <AgentsLive />
        <Button variant="primary" size="sm" icon="plus" onClick={onAddToWorld} aria-label={compact ? 'Add to World' : undefined}>
          {compact ? 'Add' : 'Add to World'}
        </Button>
        <button type="button" className={styles.search} onClick={onOpenPalette} aria-label="Search the town and commands" aria-keyshortcuts="Control+K Meta+K">
          <Icon name="search" size={15} />
          {!compact && <span className={styles.searchText}>Find…</span>}
          {!compact && <Kbd keys={[mod, 'K']} />}
        </button>
      </div>
    </header>
  );
}

/** connecting · live · reconnecting · offline · world off (never colour alone). */
export function WorldStatusChip() {
  const status = useWorld((s) => s.status);
  const speed = useWorld((s) => s.snapshot?.speed ?? null);
  const view =
    status === 'live'
      ? speed === 0
        ? { text: 'Paused', icon: 'pause' as const, tone: 'warn' }
        : { text: 'Live', icon: 'dot' as const, tone: 'live' }
      : status === 'reconnecting'
        ? { text: 'Reconnecting…', icon: 'refresh' as const, tone: 'warn' }
        : status === 'offline'
          ? { text: 'Runtime offline', icon: 'slash' as const, tone: 'err' }
          : status === 'disabled'
            ? { text: 'World off', icon: 'slash' as const, tone: 'muted' }
            : { text: 'Connecting…', icon: 'refresh' as const, tone: 'muted' };
  return (
    <span className={styles.statusChip} data-tone={view.tone} role="status">
      <Icon name={view.icon} size={11} />
      {view.text}
    </span>
  );
}

/** "● 1 agent live", with a popover listing every agent and its connection. */
function AgentsLive() {
  const store = useWorldStore();
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents ?? NO_AGENTS);
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const live = agents.filter((a) => a.health === 'live').length;
  const text = agents.length === 0 ? 'No agents yet' : live > 0 ? `${live} ${live === 1 ? 'agent' : 'agents'} live` : `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} · none live`;
  return (
    <div className={styles.agentsLive} ref={root}>
      <button type="button" className={styles.agentsButton} data-live={live > 0 || undefined} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className={styles.liveDot} aria-hidden="true" />
        {text}
      </button>
      {open && (
        <div id={id} className={styles.agentsPop} role="dialog" aria-label="Agents in the town">
          {agents.length === 0 ? (
            <p className={styles.popEmpty}>No real agent lives in the town yet. Add to World gives your Claude Code agent a building.</p>
          ) : (
            <ul className={styles.popList}>
              {agents.map((a) => {
                const h = healthView(a.health);
                return (
                  <li key={a.agentId}>
                    <button
                      type="button"
                      className={styles.popRow}
                      onClick={() => {
                        setOpen(false);
                        store.getState().focusEntity({ kind: 'agent', id: a.agentId });
                      }}
                    >
                      <span className={styles.hueDot} style={{ background: a.hue }} aria-hidden="true" />
                      <span className={styles.popName}>{a.displayName}</span>
                      <span className={styles.popHealth} data-tone={h.tone}>
                        <Icon name={h.icon} size={12} />
                        {h.text}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
