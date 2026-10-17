'use client';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Count shown after the label (tabular). */
  count?: number;
}

/**
 * WAI-ARIA tabs with a roving tabindex (←/→, Home, End). The caller renders
 * the panel with id `${idPrefix}-panel` and aria-labelledby `${idPrefix}-tab-${value}`.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  size = 'md',
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
  size?: 'sm' | 'md';
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs} data-size={size} role="tablist" aria-label={label} onKeyDown={onKey}>
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${idPrefix}-tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={t.id === value ? 0 : -1}
          className={styles.tab}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className={styles.count}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
