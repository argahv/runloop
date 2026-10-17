import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button';
import { CommandSnippet } from './CommandSnippet';
import { Icon, type IconName } from './Icon';
import styles from './States.module.css';

/** A placeholder block while data loads (announced once by its container's aria-busy). */
export function Skeleton({ width = '100%', height = 14, radius, className }: { width?: number | string; height?: number | string; radius?: number; className?: string }) {
  return (
    <span
      className={[styles.skeleton, className ?? ''].filter(Boolean).join(' ')}
      style={{ width, height, ...(radius !== undefined ? { borderRadius: radius } : {}) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** Rows of skeleton lines in the shape of a list. */
export function SkeletonRows({ rows = 6, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className={styles.rows} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton width={42} height={12} />
          <Skeleton width={16} height={16} radius={8} />
          <div className={styles.rowText}>
            <Skeleton width={`${60 - ((i * 13) % 30)}%`} height={12} />
            <Skeleton width={`${85 - ((i * 17) % 40)}%`} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Nothing here yet: say why, and teach the next useful step. */
export function EmptyState({
  icon = 'sparkle',
  title,
  children,
  actions,
  compact,
  inline,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  /** Left-aligned row, for empty sections inside a card. */
  inline?: boolean;
}) {
  return (
    <div className={styles.state} data-compact={compact || inline || undefined} data-inline={inline || undefined}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name={icon} size={compact || inline ? 18 : 22} />
      </span>
      <div className={styles.text}>
        <h2 className={styles.title}>{title}</h2>
        {children && <div className={styles.body}>{children}</div>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

/** Something failed: what failed, whether data was saved, and how to retry. */
export function ErrorState({
  title,
  children,
  saved,
  command,
  onRetry,
  retryLabel = 'Retry',
  compact,
}: {
  title: string;
  children?: ReactNode;
  /** Whether recorded data is safe (shown as its own line). */
  saved?: ReactNode;
  /** Exact command that fixes it, with a copy button. */
  command?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  return (
    <div className={styles.state} data-tone="err" data-compact={compact || undefined} role="alert">
      <span className={styles.icon} aria-hidden="true">
        <Icon name="alert" size={compact ? 18 : 22} />
      </span>
      <h2 className={styles.title}>{title}</h2>
      {children && <div className={styles.body}>{children}</div>}
      {command && <CommandSnippet command={command} />}
      {saved && (
        <p className={styles.saved}>
          <Icon name="database" size={14} />
          <span>{saved}</span>
        </p>
      )}
      {onRetry && (
        <div className={styles.actions}>
          <Button icon="refresh" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
