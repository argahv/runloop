'use client';
/**
 * The hotbar (contract §1.1 I): Explore, Agents, Add to World, Intelligence,
 * Lab and the menu, with their keys (1, 2, N, 3, 4, Esc). Add to World is the
 * one lime fill; the active mode carries a lime bar and ice text.
 */
import type { Mode } from '../../../world/link';
import { Icon, type IconName } from '../../../ui/Icon';
import { Glyph } from './bits';
import styles from './hud.module.css';
import { uiSound } from './sound';

interface Slot {
  id: Mode | 'add' | 'menu';
  label: string;
  short: string;
  key: string;
  hint: string;
}

const SLOTS: Slot[] = [
  { id: 'explore', label: 'Explore', short: 'Explore', key: '1', hint: 'Explore the town' },
  { id: 'agents', label: 'Agents', short: 'Agents', key: '2', hint: 'Your agents, the Agent District and Arrivals' },
  { id: 'add', label: 'Add to World', short: 'Add', key: 'N', hint: 'Give a Claude Code agent a building' },
  { id: 'intelligence', label: 'Intelligence', short: 'Intel', key: '3', hint: 'The World Log at the Commons Library, and traces' },
  { id: 'lab', label: 'Lab', short: 'Lab', key: '4', hint: 'Compare sessions at the Lattice Lab' },
  { id: 'menu', label: 'Menu', short: 'Menu', key: 'Esc', hint: 'Settings, sound, controls, pages and help' },
];

const ICON: Partial<Record<Slot['id'], IconName>> = { agents: 'agent', add: 'plus', intelligence: 'pulse', lab: 'flask', menu: 'menu' };

export default function Hotbar({
  mode,
  adding,
  menuOpen,
  onMode,
  onAdd,
  onMenu,
  compact,
}: {
  mode: Mode;
  adding: boolean;
  menuOpen: boolean;
  onMode: (m: Mode) => void;
  onAdd: () => void;
  onMenu: () => void;
  compact: boolean;
}) {
  return (
    <nav className={styles.hotbar} aria-label="Modes and actions" data-hud-fade>
      {SLOTS.map((s) => {
        const active = s.id === 'add' ? adding : s.id === 'menu' ? menuOpen : !adding && mode === s.id;
        const icon = ICON[s.id];
        return (
          <button
            key={s.id}
            type="button"
            className={styles.slot}
            data-slot={s.id}
            data-active={active || undefined}
            aria-current={s.id !== 'add' && s.id !== 'menu' && active ? 'page' : undefined}
            aria-pressed={s.id === 'add' || s.id === 'menu' ? active : undefined}
            aria-keyshortcuts={s.key === 'Esc' ? 'Escape' : s.key}
            title={`${s.hint} (${s.key})`}
            onPointerEnter={() => uiSound('hover')}
            onClick={() => {
              uiSound(s.id === 'menu' ? 'menu' : 'select');
              if (s.id === 'add') onAdd();
              else if (s.id === 'menu') onMenu();
              else onMode(s.id);
            }}
          >
            {icon ? <Icon name={icon} size={20} /> : <Glyph name="explore" size={20} />}
            <span className={styles.slotLabel}>{compact ? s.short : s.label}</span>
            {!compact && <span className={styles.slotKey} aria-hidden="true">{s.key}</span>}
          </button>
        );
      })}
    </nav>
  );
}
