import type { CSSProperties, ReactNode } from 'react';
import type { StatusView } from '../state/view';
import styles from './Chip.module.css';
import { GlyphIcon, Icon, type IconName } from './Icon';

export type Tone = StatusView['tone'] | 'accent';

/** A small neutral fact: a count, a duration, a tag. Tone adds colour; the text always carries the meaning. */
export function Chip({
  children,
  tone,
  icon,
  title,
  mono,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
  title?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span className={[styles.chip, mono ? styles.mono : '', className ?? ''].filter(Boolean).join(' ')} data-tone={tone} title={title}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/** Icon + text status (never colour alone). */
export function StatusBadge({ view, className, title }: { view: StatusView; className?: string; title?: string }) {
  return (
    <span className={[styles.badge, className ?? ''].filter(Boolean).join(' ')} data-tone={view.tone} title={title}>
      <GlyphIcon glyph={view.icon} size={12} className={styles.badgeIcon} />
      {view.text}
    </span>
  );
}

/** An agent's identity colour as a dot (identity never signals state). */
export function AgentDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className={styles.dot} style={{ '--dot': color, width: size, height: size } as CSSProperties} aria-hidden="true" />;
}
