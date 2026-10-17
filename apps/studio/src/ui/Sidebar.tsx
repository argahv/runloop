'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './Sidebar.module.css';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
}

/** Primary navigation: brand, areas (only those that work), extra sections, footer. */
export function Sidebar({
  items,
  children,
  footer,
  rail,
  onNavigate,
}: {
  items: readonly NavItem[];
  children?: ReactNode;
  footer?: ReactNode;
  /** Icons only (labels stay as tooltips and accessible names). */
  rail?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className={styles.sidebar} data-rail={rail || undefined}>
      <Link href="/overview" className={styles.brand} aria-label="Runloop Studio, overview" onClick={onNavigate}>
        <span className={styles.mark} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M12 3a9 9 0 1 1-8.5 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="5.2" cy="5.6" r="2.1" fill="currentColor" />
          </svg>
        </span>
        <span className={styles.wordmark}>
          Runloop <span className={styles.product}>Studio</span>
        </span>
      </Link>
      <nav aria-label="Studio" className={styles.nav}>
        <ul className={styles.items}>
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={styles.item}
                aria-current={item.active ? 'page' : undefined}
                title={item.label}
                onClick={onNavigate}
              >
                <Icon name={item.icon} size={18} />
                <span className={styles.label}>{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children && <div className={styles.extra}>{children}</div>}
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
