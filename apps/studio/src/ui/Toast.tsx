'use client';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import styles from './Toast.module.css';

export type ToastTone = 'ok' | 'err' | 'warn' | 'info';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
  action?: { label: string; run: () => void };
}
interface ToastItem extends ToastInput {
  id: number;
}

const toasts = createStore<{ items: ToastItem[] }>()(() => ({ items: [] }));
let nextId = 1;

/** Show a short confirmation or error. Errors stay longer and are announced assertively. */
export function toast(t: ToastInput): void {
  const item = { ...t, id: nextId++ };
  toasts.setState((s) => ({ items: [...s.items.slice(-3), item] }));
}

function dismiss(id: number) {
  toasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

const ICON: Record<ToastTone, IconName> = { ok: 'checkCircle', err: 'xCircle', warn: 'alert', info: 'dot' };

export function ToastRegion() {
  const items = useStore(toasts, (s) => s.items);
  return (
    <div className={styles.region} aria-label="Notifications">
      {items.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), item.tone === 'err' ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [item.id, item.tone]);
  return (
    <div className={styles.toast} data-tone={item.tone} role={item.tone === 'err' ? 'alert' : 'status'}>
      <span className={styles.icon}>
        <Icon name={ICON[item.tone]} size={16} />
      </span>
      <div className={styles.text}>
        <p className={styles.title}>{item.title}</p>
        {item.description && <p className={styles.description}>{item.description}</p>}
      </div>
      {item.action && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            item.action!.run();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </Button>
      )}
      <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss notification" onClick={() => dismiss(item.id)} />
    </div>
  );
}
