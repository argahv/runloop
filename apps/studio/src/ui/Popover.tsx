'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { buttonClass } from './Button';
import { Icon, type IconName } from './Icon';
import styles from './Popover.module.css';

/**
 * Disclosure button with a popover panel (used for filter menus). Escape or a
 * click outside closes it and focus returns to the button.
 */
export function Popover({ label, icon, active, children, align = 'start' }: { label: ReactNode; icon?: IconName; active?: boolean; children: ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`#${CSS.escape(id)} input, #${CSS.escape(id)} button`)?.focus());
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, id]);

  return (
    <div className={styles.root} ref={root}>
      <button
        ref={button}
        type="button"
        className={buttonClass('secondary', 'sm', false, styles.trigger)}
        aria-expanded={open}
        aria-controls={id}
        data-active={active || undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {icon && <Icon name={icon} size={14} />}
        {label}
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div id={id} className={styles.panel} data-align={align}>
          {children}
        </div>
      )}
    </div>
  );
}
