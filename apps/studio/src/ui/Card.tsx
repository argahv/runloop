import type { ReactNode } from 'react';
import styles from './Card.module.css';

/** A tonal surface with an optional header (title, subtitle, actions). */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  as: As = 'section',
  labelledBy,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
  labelledBy?: string;
}) {
  return (
    <As className={[styles.card, className ?? ''].filter(Boolean).join(' ')} aria-labelledby={labelledBy}>
      {(title || actions) && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title && (
              <h2 className={styles.title} id={labelledBy}>
                {title}
              </h2>
            )}
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {children}
    </As>
  );
}
