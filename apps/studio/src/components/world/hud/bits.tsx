'use client';
/** Small pieces several HUD parts share: the clock text, the world status chip, entity names, glyphs. */
import type { EntityRef } from '@runloop-world/events';
import { useWorld, useWorldTick } from '../../../world/context';
import { entityName } from '../../../world/entityIndex';
import { clockParts } from '../../../world/interpolate';
import { Icon } from '../../../ui/Icon';
import styles from './hud.module.css';

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

/** connecting · live · paused · reconnecting · offline · world off (icon + text, never colour alone). */
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

/** A name resolver over the current snapshot, town and agents. */
export function useEntityNames(): (ref: EntityRef) => string {
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const agents = useWorld((s) => s.agents);
  return (ref) => entityName(ref, snapshot, town, agents);
}

/** "14:20" today, "Day 2 · 14:20" on another day. */
export function whenText(tick: number, today: number): string {
  const c = clockParts(tick);
  return c.day === today ? `${c.hh}:${c.mm}` : `Day ${c.day} · ${c.hh}:${c.mm}`;
}

/** The Runloop ring. */
export function BrandRing({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 3a9 9 0 1 1-8.5 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="5.2" cy="5.6" r="2.1" fill="currentColor" />
    </svg>
  );
}

/** Glyphs the shared icon set does not have (inline, so ui/ stays untouched). */
const GLYPHS = {
  explore: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M15.5 8.5l-2 5-5 2 2-5z',
} as const;
export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 16, className }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d={GLYPHS[name]} />
    </svg>
  );
}
