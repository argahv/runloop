import styles from './Kbd.module.css';

/** Keyboard shortcut hint: <Kbd keys={['⌘', 'K']} />. */
export function Kbd({ keys, label }: { keys: readonly string[]; label?: string }) {
  return (
    <span className={styles.kbd} aria-label={label ?? keys.join(' ')}>
      {keys.map((k, i) => (
        <kbd key={i} aria-hidden="true">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** ⌘ on Apple platforms, Ctrl elsewhere (client only; falls back to Ctrl). */
export function modKey(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}
