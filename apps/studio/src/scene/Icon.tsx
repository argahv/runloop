import type { IconName } from './badges';
import styles from './scene.module.css';

/** Tiny inline stroke icons (no icon font or emoji, so they render everywhere). */
const PATHS: Record<IconName, string> = {
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L20 20',
  hammer: 'M13 6l5 5M4 20l9-9M11 4l3-1l7 7l-1 3l-3 0l-6-6z',
  flask: 'M9 3h6M10 3v6l-5.2 9.2A1.5 1.5 0 0 0 6.1 21h11.8a1.5 1.5 0 0 0 1.3-2.8L14 9V3M7.5 15h9',
  rocket: 'M12 2.5c3 2.5 4.2 6.5 3.2 11.5H8.8C7.8 9 9 5 12 2.5zM8.8 14L6 17.5l3.2.5M15.2 14l2.8 3.5l-3.2.5M10.5 18.5L12 21.5l1.5-3M12 8v1.5',
  bot: 'M6 8h12v10H6zM12 4v4M9.5 13h0M14.5 13h0M4 12v3M20 12v3',
  dot: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  walk: 'M5 12h12M13 7l5 5l-5 5',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  hourglass: 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9',
  question: 'M9 9a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.2-1.5 2.4M12 18v.5',
  check: 'M5 12.5l4.5 4.5L19 7',
  cross: 'M6 6l12 12M18 6L6 18',
  pause: 'M9 5v14M15 5v14',
  alert: 'M12 3L2.5 20h19zM12 9.5v5M12 17.5v.5',
  frame: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  target: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
};

export function Icon({ name, color, className }: { name: IconName; color?: string; className?: string }) {
  return (
    <svg className={className ?? styles.icon} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}
