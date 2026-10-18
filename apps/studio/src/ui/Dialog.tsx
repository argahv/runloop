'use client';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: rendered in a portal over a scrim, traps Tab focus, closes on
 * Escape or a scrim click, and gives focus back to the opener on close.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  children,
  initialFocus,
  placement = 'center',
  className,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  placement?: 'center' | 'top' | 'left' | 'bottom';
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  // Latest callbacks without re-running the focus effect (which would steal focus on every render).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const initialRef = useRef(initialFocus);
  initialRef.current = initialFocus;
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusFirst = () => {
      const target = initialRef.current?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current;
      target?.focus();
    };
    // Focus now (the panel is already in the DOM), so keys typed right after
    // opening reach the dialog rather than page shortcuts, even when a busy
    // 3D frame delays the next animation frame; retry once on that frame.
    focusFirst();
    const raf = requestAnimationFrame(() => {
      if (!panel.current?.contains(document.activeElement)) focusFirst();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [open]);

  if (!open || !mounted) return null;
  return createPortal(
    <div className={styles.scrim} data-placement={placement} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={[styles.panel, className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
