import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './Breadcrumbs.module.css';
import { Icon } from './Icon';

export interface Crumb {
  label: ReactNode;
  href?: string;
}

/** Where you are: Area › Run. The last crumb is the current page. */
export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.nav}>
      <ol className={styles.list}>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className={styles.item}>
              {i > 0 && <Icon name="chevronRight" size={12} className={styles.sep} />}
              {c.href && !last ? (
                <Link href={c.href} className={styles.link}>
                  {c.label}
                </Link>
              ) : (
                <span className={styles.current} aria-current={last ? 'page' : undefined}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
