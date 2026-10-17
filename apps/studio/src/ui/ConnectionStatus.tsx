import type { ConnectionView } from '../state/connection';
import styles from './ConnectionStatus.module.css';
import { GlyphIcon } from './Icon';

/** Connecting · Live · Paused · Disconnected · Replaying · Recorded · Synthetic: always visible, always in words. */
export function ConnectionStatus({ view, extra }: { view: ConnectionView; extra?: string }) {
  return (
    <span className={styles.status} data-state={view.state} data-tone={view.tone} title={view.detail} role="status">
      <span className={styles.icon} aria-hidden="true">
        {view.state === 'live' ? <span className={styles.pulse} /> : <GlyphIcon glyph={view.icon} size={12} />}
      </span>
      <span className={styles.text}>{view.text}</span>
      {extra && <span className={styles.extra}>{extra}</span>}
      <span className="sr-only">. {view.detail}</span>
    </span>
  );
}
