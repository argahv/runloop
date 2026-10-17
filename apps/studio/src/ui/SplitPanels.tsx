'use client';
import type { ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout, type LayoutStorage, type PanelProps } from 'react-resizable-panels';
import { safeStorage } from '../state/prefs';
import styles from './SplitPanels.module.css';

const storage: LayoutStorage = safeStorage;

/** Resizable split whose sizes persist per viewer (localStorage, key runloop.layout.<id>). */
export function SplitGroup({ id, orientation = 'horizontal', children, className }: { id: string; orientation?: 'horizontal' | 'vertical'; children: ReactNode; className?: string }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `runloop.layout.${id}`, storage, onlySaveAfterUserInteractions: true });
  return (
    <Group
      id={id}
      orientation={orientation}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={[styles.group, className ?? ''].filter(Boolean).join(' ')}
    >
      {children}
    </Group>
  );
}

export function SplitPanel({ className, ...props }: PanelProps) {
  return <Panel className={[styles.panel, className ?? ''].filter(Boolean).join(' ')} {...props} />;
}

/** Keyboard-operable divider (arrow keys resize; double-click resets). */
export function SplitHandle({ label, orientation = 'horizontal' }: { label: string; orientation?: 'horizontal' | 'vertical' }) {
  return (
    <Separator className={styles.handle} data-orientation={orientation} aria-label={label}>
      <span className={styles.grip} aria-hidden="true" />
    </Separator>
  );
}
