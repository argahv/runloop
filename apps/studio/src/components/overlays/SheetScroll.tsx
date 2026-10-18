'use client';
import type { ReactNode } from 'react';
import styles from './overlays.module.css';

/**
 * A scrolling sheet body for page content (compare, sessions, connections):
 * the page's cards with sheet padding, and the `rl-sheet` container the
 * pages' CSS sizes its grids by (viewport media queries do not know the
 * sheet is narrower than the screen).
 */
export default function SheetScroll({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className={styles.scroll} aria-label={label}>
      <div className={styles.scrollInner}>{children}</div>
    </div>
  );
}
