'use client';
import { useId } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './SegmentedControl.module.css';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Visually hide the label (it stays the accessible name). */
  iconOnly?: boolean;
  title?: string;
}

/** A single choice from a few options: native radios (arrow keys move the choice). */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
  glass,
}: {
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /** Floating over the 3D world. */
  glass?: boolean;
}) {
  const name = useId();
  return (
    <div className={styles.group} role="radiogroup" aria-label={label} data-size={size} data-glass={glass || undefined}>
      {options.map((o) => (
        <label key={o.value} className={styles.option} title={o.title ?? (o.iconOnly ? o.label : undefined)}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} className={styles.input} />
          <span className={styles.face}>
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : 16} />}
            <span className={o.iconOnly ? 'sr-only' : undefined}>{o.label}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
