'use client';
/**
 * The HUD's top-left (contract §1.1 A B C): the world chip (brand ring, town
 * name, status, live agents with a popover), Find (⌘K) and the bell (icon
 * only when calm, "⚠ n need you" otherwise; it opens every notification,
 * simulated notables included).
 */
import type { AgentPresence } from '@runloop-world/events';
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { arrivalItems, attentionTitle, compareItems, type AttentionItem, type Severity } from '../../../world/attention';
import { useWorld, useWorldStore } from '../../../world/context';
import { clockParts } from '../../../world/interpolate';
import { healthView, provenanceChip } from '../../../world/selectors';
import { Icon, type IconName } from '../../../ui/Icon';
import { Kbd, modKey } from '../../../ui/Kbd';
import { BrandRing, useEntityNames, whenText, WorldStatusChip } from './bits';
import styles from './hud.module.css';
import { needsYou } from './notify';
import { uiSound } from './sound';

const NO_AGENTS: AgentPresence[] = [];

/** Close a popover on an outside press or Esc (Esc stops there: it does not reach the town's cascade). */
export function usePopover(open: boolean, setOpen: (v: boolean) => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen, root]);
}

export function WorldChip({ compact }: { compact?: boolean }) {
  const townName = useWorld((s) => s.town?.def.name ?? 'Runloop');
  return (
    <div className={styles.chip} data-hud-fade>
      <span className={styles.brand} aria-hidden="true">
        <BrandRing size={18} />
      </span>
      {!compact && <span className={styles.townName}>{townName}</span>}
      <WorldStatusChip />
      <span className={styles.chipSep} aria-hidden="true" />
      <AgentsLive compact={compact} />
    </div>
  );
}

/** "● 1 agent live", with a popover listing every agent and its connection (icon + text). */
function AgentsLive({ compact }: { compact?: boolean }) {
  const store = useWorldStore();
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents ?? NO_AGENTS);
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  usePopover(open, setOpen, root);
  const live = agents.filter((a) => a.health === 'live').length;
  const text = agents.length === 0 ? 'No agents yet' : live > 0 ? `${live} ${live === 1 ? 'agent' : 'agents'} live` : `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} · none live`;
  return (
    <div className={styles.popRoot} ref={root}>
      <button
        type="button"
        className={styles.agentsButton}
        data-live={live > 0 || undefined}
        aria-expanded={open}
        aria-controls={id}
        aria-label={compact ? text : undefined}
        onPointerEnter={() => uiSound('hover')}
        onClick={() => {
          uiSound(open ? 'close' : 'open');
          setOpen(!open);
        }}
      >
        <span className={styles.liveDot} aria-hidden="true" />
        {compact ? (agents.length ? `${live} live` : 'No agents') : text}
      </button>
      {open && (
        <div id={id} className={`${styles.pop} ${styles.popLeft}`} role="dialog" aria-label="Agents in the town">
          {agents.length === 0 ? (
            <p className={styles.popEmpty}>No real agent lives in the town yet. Add to World (N) gives your Claude Code agent a building.</p>
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
                        uiSound('select');
                        store.getState().focusEntity({ kind: 'agent', id: a.agentId });
                      }}
                    >
                      <span className={styles.hueDot} style={{ background: a.hue }} aria-hidden="true" />
                      <span className={styles.popName}>{a.displayName}</span>
                      <span className={styles.popMeta} data-tone={h.tone}>
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

export function FindButton({ onOpen, compact }: { onOpen: () => void; compact?: boolean }) {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);
  return (
    <button
      type="button"
      className={styles.find}
      data-hud-fade
      data-compact={compact || undefined}
      onClick={() => {
        uiSound('open');
        onOpen();
      }}
      onPointerEnter={() => uiSound('hover')}
      aria-label="Find people, places and commands"
      aria-keyshortcuts="Control+K Meta+K /"
    >
      <Icon name="search" size={16} />
      {!compact && <span className={styles.findText}>Find…</span>}
      {!compact && <Kbd keys={[mod, 'K']} />}
    </button>
  );
}

const SEV_ICON: Record<Severity, IconName> = { critical: 'alert', attention: 'bell', notable: 'dot', ambient: 'dot' };
const SEV_LABEL: Record<Severity, string> = { critical: 'Needs you', attention: 'Attention', notable: 'Notable', ambient: 'Ambient' };

/** Every notification: attention items and Arrivals, grouped by severity, each citing its events. */
export function useNotificationItems(): AttentionItem[] {
  const attention = useWorld((s) => s.attention);
  const arrivals = useWorld((s) => s.arrivals);
  return useMemo(() => [...attention, ...arrivalItems(arrivals)].sort(compareItems), [attention, arrivals]);
}

export function Bell({ onOpen, compact, open, setOpen }: { onOpen: (item: AttentionItem) => void; compact?: boolean; open: boolean; setOpen: (v: boolean) => void }) {
  const items = useNotificationItems();
  const today = useWorld((s) => (s.clock ? clockParts(s.clock.tick).day : 0));
  const name = useEntityNames();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  usePopover(open, setOpen, root);
  const unresolved = items.filter((i) => !i.resolved);
  const urgent = needsYou(items);
  return (
    <div className={styles.popRoot} ref={root} data-hud-fade>
      <button
        type="button"
        className={styles.bell}
        data-urgent={urgent > 0 || undefined}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Notifications: ${urgent} need you, ${unresolved.length} in all`}
        onPointerEnter={() => uiSound('hover')}
        onClick={() => {
          uiSound(open ? 'close' : 'open');
          setOpen(!open);
        }}
      >
        <Icon name={urgent > 0 ? 'alert' : 'bell'} size={16} />
        {urgent > 0 && !compact && <span>{urgent} need you</span>}
        {urgent > 0 && compact && <span className={styles.bellCount}>{urgent}</span>}
      </button>
      {open && (
        <div id={id} className={`${styles.pop} ${styles.popLeft} ${styles.feed}`} role="dialog" aria-label="Notifications">
          <p className={styles.feedLede}>Everything that happened and needs a look. Simulated town news stays here; only real agents and things that need you pop up.</p>
          {unresolved.length === 0 ? (
            <p className={styles.popEmpty}>Nothing yet. Sessions, closures, conversations and anything that needs you gather here.</p>
          ) : (
            (['critical', 'attention', 'notable'] as const).map((sev) => {
              const group = unresolved.filter((i) => i.severity === sev);
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
                            setOpen(false);
                            uiSound('select');
                            onOpen(i);
                          }}
                        >
                          <Icon name={SEV_ICON[i.severity]} size={13} />
                          <span className={styles.feedText}>{attentionTitle(i, name)}</span>
                          <span className={styles.feedMeta}>
                            {provenanceChip(i.prov).label}
                            {i.events ? ` · ${whenText(i.lastTick, today)}` : ' · from Arrivals'}
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
    </div>
  );
}

export { SEV_ICON };
