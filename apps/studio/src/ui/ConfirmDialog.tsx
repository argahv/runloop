'use client';
import { useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import styles from './ConfirmDialog.module.css';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

/**
 * Confirmation for a destructive action. `impact` must say what happens and
 * what is kept. Focus starts on Cancel, so Enter never confirms by accident.
 */
export function ConfirmDialog({
  open,
  title,
  impact,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  open: boolean;
  title: string;
  impact: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onClose={onCancel} labelledBy={`${id}-title`} describedBy={`${id}-body`} initialFocus={cancel}>
      <div className={styles.body}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name="alert" size={18} />
        </span>
        <div>
          <h2 id={`${id}-title`} className={styles.title}>
            {title}
          </h2>
          <div id={`${id}-body`} className={styles.impact}>
            {impact}
          </div>
        </div>
      </div>
      <div className={styles.actions}>
        <Button ref={cancel} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} busy={busy}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
