import type { CSSProperties } from 'react';

/** 24×24 stroke icons (currentColor). `fill` paths are drawn solid. */
const PATHS = {
  overview: 'M4 4h6.5v6.5H4z M13.5 4H20v6.5h-6.5z M4 13.5h6.5V20H4z M13.5 13.5H20V20h-6.5z',
  world: 'M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z M12 12l8-4.6 M12 12v9.2 M12 12L4 7.4',
  traces: 'M4 6h2 M9 6h11 M4 12h2 M9 12h11 M4 18h2 M9 18h7',
  integrations: 'M9 3v5 M15 3v5 M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z M12 17v4',
  settings: 'M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M20 20l-4.2-4.2',
  filter: 'M4 5h16l-6 7.2V19l-4 1.5v-8.3z',
  play: 'M7.5 4.8v14.4L19 12z',
  pause: 'M8.5 5v14 M15.5 5v14',
  skipBack: 'M18 5.5v13L9 12z M6 5.5v13',
  skipForward: 'M6 5.5v13L15 12z M18 5.5v13',
  stop: 'M6.5 6.5h11v11h-11z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6.5 6.5l11 11 M17.5 6.5l-11 11',
  alert: 'M12 3.8l9 15.7H3z M12 10v4.2 M12 17.2v.3',
  xCircle: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9.2 9.2l5.6 5.6 M14.8 9.2l-5.6 5.6',
  checkCircle: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8 12.3l2.8 2.8L16 9.6',
  circle: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14z',
  dot: 'M12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z',
  ring: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  hourglass: 'M7 3.5h10 M7 20.5h10 M8 3.5c0 4.8 8 4.6 8 8.5s-8 3.7-8 8.5 M16 3.5c0 4.8-8 4.6-8 8.5s8 3.7 8 8.5',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M12 7.5V12l3 2',
  ellipsis: 'M6 12h.01 M12 12h.01 M18 12h.01',
  arrowRight: 'M5 12h14 M13 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9.5 6l6 6-6 6',
  lock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  key: 'M8.5 11a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z M11.7 12.3L20 4 M16.5 7.5l2.5 2.5',
  file: 'M6.5 3h7.5l4 4v14h-11.5z M14 3v4h4',
  message: 'M4 5h16v11H9.5L5 19.5V16H4z',
  slash: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M6 18L18 6',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5v4h-4',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4',
  moon: 'M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z',
  monitor: 'M3.5 5h17v11h-17z M8.5 20h7 M12 16v4',
  copy: 'M9 9h11v11H9z M5.5 15H4V4h11v1.5',
  external: 'M14 4h6v6 M20 4l-8.5 8.5 M18 14v6H4V6h6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  agent: 'M5.5 9h13v10h-13z M12 5v4 M12 5h.01 M9.5 13.5v1.5 M14.5 13.5v1.5 M3 13v2 M21 13v2',
  terminal: 'M4 5h16v14H4z M7.5 9.5l3 2.5-3 2.5 M12.5 15h4',
  target: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  sparkle: 'M12 3.5l2 5.5 5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2z',
  table: 'M4 5h16v14H4z M4 10h16 M4 14.5h16 M9.5 10v9',
  map: 'M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5z M9 4v13.5 M15 6.5V20',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z',
  eyeOff: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M4 4l16 16',
  inferred: 'M4.5 10c2.2-2.2 4.3-2.2 7.5 0s5.3 2.2 7.5 0 M4.5 15c2.2-2.2 4.3-2.2 7.5 0s5.3 2.2 7.5 0',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  database: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  graph: 'M6 4a2 2 0 1 1 0 4a2 2 0 1 1 0-4z M18 4a2 2 0 1 1 0 4a2 2 0 1 1 0-4z M12 16a2 2 0 1 1 0 4a2 2 0 1 1 0-4z M7 7.8l4 8.4 M17 7.8l-4 8.4 M8 6h8',
  plus: 'M12 5v14 M5 12h14',
  diamond: 'M12 3.5l8.5 8.5-8.5 8.5L3.5 12z',
  halfCircle: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M12 3.5v17',
  keyboard: 'M3.5 6h17v12h-17z M7 10h.01 M10.5 10h.01 M14 10h.01 M17 10h.01 M8 14.5h8',
  command: 'M9 6.5a2.5 2.5 0 1 0-2.5 2.5H9V6.5z M15 6.5A2.5 2.5 0 1 1 17.5 9H15V6.5z M9 17.5A2.5 2.5 0 1 1 6.5 15H9v2.5z M15 17.5a2.5 2.5 0 1 0 2.5-2.5H15v2.5z M9 9h6v6H9z',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M3.5 12h17 M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5 M12 3.5C9.6 5.9 8.6 8.7 8.6 12s1 6.1 3.4 8.5',
  pencil: 'M4.5 19.5l1-4.5L15.8 4.7a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L9 18.5z M13.5 7l3.5 3.5',
  flask: 'M9.5 3.5h5 M10.5 3.5v6L5 18.5a1.4 1.4 0 0 0 1.2 2h11.6a1.4 1.4 0 0 0 1.2-2l-5.5-9v-6 M7.4 14.5h9.2',
  upload: 'M12 15.5V4 M7 8.5L12 3.5l5 5 M4.5 15v4.5h15V15',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5z M10 20.5h4',
  layers: 'M12 4l8.5 4.5L12 13 3.5 8.5z M3.5 12.5L12 17l8.5-4.5 M3.5 16.5L12 21l8.5-4.5',
  flag: 'M5.5 21V4 M5.5 4.5h11l-2 4 2 4h-11',
  swap: 'M4 8h14 M14.5 4.5L18 8l-3.5 3.5 M20 16H6 M9.5 12.5L6 16l3.5 3.5',
  coins: 'M9 5c3 0 5.5 1 5.5 2.3S12 9.6 9 9.6 3.5 8.6 3.5 7.3 6 5 9 5z M3.5 7.3v4.4c0 1.3 2.5 2.3 5.5 2.3 M3.5 11.7v4.4c0 1.3 2.5 2.3 5.5 2.3 M15 10.4c3 0 5.5 1 5.5 2.3s-2.5 2.3-5.5 2.3-5.5-1-5.5-2.3 2.5-2.3 5.5-2.3z M9.5 12.7v4.4c0 1.3 2.5 2.3 5.5 2.3s5.5-1 5.5-2.3v-4.4',
} as const;

export type IconName = keyof typeof PATHS;

/** Icons drawn as solid shapes rather than strokes. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play', 'stop', 'dot', 'skipBack', 'skipForward']);
/** Icons that need a heavier stroke to read at small sizes. */
const HEAVY: ReadonlySet<IconName> = new Set<IconName>(['ellipsis', 'pause']);

export function Icon({ name, size = 16, className, style, label }: { name: IconName; size?: number; className?: string; style?: CSSProperties; label?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={HEAVY.has(name) ? 2.6 : filled ? 1 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * Status glyphs used by the label maps in state/view.ts → icons. Unknown
 * glyphs fall back to the glyph itself, so new map entries still render.
 */
const GLYPHS: Record<string, IconName> = {
  '✓': 'check',
  '✗': 'x',
  '⚠': 'alert',
  '●': 'dot',
  '○': 'circle',
  '◉': 'ring',
  '◌': 'circle',
  '⏳': 'hourglass',
  '■': 'stop',
  '⏸': 'pause',
  '⚙': 'pulse',
  '…': 'ellipsis',
  '⋯': 'ellipsis',
  '→': 'arrowRight',
  '➜': 'arrowRight',
  '🔒': 'lock',
  '🔑': 'key',
  '⊘': 'slash',
  '▶': 'play',
  '⏵': 'play',
  '↻': 'refresh',
  '◇': 'diamond',
  '◆': 'diamond',
  '◐': 'halfCircle',
  '＋': 'plus',
  '✉': 'message',
  '📄': 'file',
  '•': 'dot',
  '◫': 'layers',
  '🔔': 'bell',
  '⇄': 'swap',
  '⚑': 'flag',
  '¤': 'coins',
  '⤳': 'agent',
};

export function iconForGlyph(glyph: string): IconName | null {
  return GLYPHS[glyph] ?? null;
}

/** An icon for a status glyph, or the glyph as text when there is no icon for it. */
export function GlyphIcon({ glyph, size = 14, className }: { glyph: string; size?: number; className?: string }) {
  const name = iconForGlyph(glyph);
  if (name) return <Icon name={name} size={size} {...(className ? { className } : {})} />;
  return (
    <span className={className} aria-hidden="true">
      {glyph}
    </span>
  );
}
