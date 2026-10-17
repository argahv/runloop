'use client';
import { useFrame, useThree } from '@react-three/fiber';
import type { PresentationState } from '@runloop-world/world-engine';
import { useEffect, useSyncExternalStore } from 'react';
import { Vector3 } from 'three';
import { STATE_BADGE, TONE_COLOR, type IconName } from './badges';
import { useScene } from './context';
import { Icon } from './Icon';
import styles from './scene.module.css';

/**
 * DOM labels over the canvas (badges, signs, incident chips). They live in
 * the page's own React tree (accessible buttons, real text, no font fetch);
 * the scene only registers what to show and where, and a projector moves
 * them every frame through refs — no React updates per frame.
 */
export type LabelContent =
  | { kind: 'zone'; text: string; color: string }
  | { kind: 'station'; text: string; color: string }
  | {
      kind: 'agent';
      agentId: string;
      name: string;
      color: string;
      icon: IconName;
      state: PresentationState;
      detail: string;
      selected: boolean;
    }
  | { kind: 'incident'; open: boolean; text: string; title: string };

/** World-space anchor: a fixed point, or a function evaluated every frame. */
export type Anchor = Vector3 | ((out: Vector3) => Vector3 | null);

export class LabelStore {
  private specs = new Map<string, LabelContent>();
  private snap: readonly [string, LabelContent][] = [];
  private listeners = new Set<() => void>();
  readonly anchors = new Map<string, Anchor>();
  readonly elements = new Map<string, HTMLElement>();
  /** Stacking boost: station label (hover/selection) > selected badge > badges > signs and incident chips. */
  readonly boost = new Map<string, number>();

  set(id: string, content: LabelContent, anchor: Anchor) {
    this.specs.set(id, content);
    this.anchors.set(id, anchor);
    this.boost.set(id, content.kind === 'station' ? 3000 : content.kind === 'agent' ? (content.selected ? 2000 : 1000) : 0);
    this.emit();
  }

  remove(id: string) {
    if (!this.specs.delete(id)) return;
    this.anchors.delete(id);
    this.boost.delete(id);
    this.emit();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  snapshot = () => this.snap;

  private emit() {
    this.snap = [...this.specs];
    for (const fn of this.listeners) fn();
  }
}

/** Show a label while the calling component is mounted (content compared by value). */
export function useLabel(id: string, content: LabelContent | null, anchor: Anchor) {
  const { labels } = useScene();
  const key = content ? JSON.stringify(content) : '';
  useEffect(() => {
    if (!content) {
      labels.remove(id);
      return;
    }
    labels.set(id, content, anchor);
    // `key` captures content by value; anchor objects are stable per caller.
  }, [labels, id, key]);
  useEffect(() => () => labels.remove(id), [labels, id]);
}

const v = new Vector3();

/** Inside the Canvas: projects every label anchor to screen space each frame. Mount it last. */
export function LabelProjector() {
  const { labels } = useScene();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame(() => {
    camera.updateMatrixWorld();
    for (const [id, el] of labels.elements) {
      const a = labels.anchors.get(id);
      const p = typeof a === 'function' ? a(v) : a ? v.copy(a) : null;
      if (!p) {
        el.style.visibility = 'hidden';
        continue;
      }
      p.project(camera);
      const x = ((p.x + 1) / 2) * size.width;
      const y = ((1 - p.y) / 2) * size.height;
      const off = p.z > 1 || x < -200 || y < -100 || x > size.width + 200 || y > size.height + 100;
      el.style.visibility = off ? 'hidden' : 'visible';
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.zIndex = String(Math.round((1 - p.z) * 500) + (labels.boost.get(id) ?? 0));
    }
  });
  return null;
}

/** Outside the Canvas: renders the labels as DOM. */
export function LabelLayer({ store, onSelectAgent }: { store: LabelStore; onSelectAgent: (id: string | null) => void }) {
  const list = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return (
    <div className={styles.labels}>
      {list.map(([id, c]) => (
        <div
          key={id}
          className={styles.label}
          ref={(el) => {
            if (el) store.elements.set(id, el);
            else store.elements.delete(id);
          }}
        >
          <LabelBody content={c} onSelectAgent={onSelectAgent} />
        </div>
      ))}
    </div>
  );
}

function LabelBody({ content: c, onSelectAgent }: { content: LabelContent; onSelectAgent: (id: string | null) => void }) {
  switch (c.kind) {
    case 'zone':
      return (
        <div className={styles.zoneLabel} style={{ ['--zone' as string]: c.color }}>
          <span className={styles.zoneDot} aria-hidden />
          {c.text}
        </div>
      );
    case 'station':
      return (
        <div className={styles.stationLabel} style={{ ['--zone' as string]: c.color }}>
          {c.text}
        </div>
      );
    case 'incident':
      return (
        <div className={`${styles.incident} ${c.open ? '' : styles.incidentResolved}`} title={c.title}>
          <Icon name={c.open ? 'alert' : 'check'} />
          {c.text}
        </div>
      );
    case 'agent': {
      const badge = STATE_BADGE[c.state];
      return (
        <button
          type="button"
          className={`${styles.badge} ${c.selected ? styles.badgeSelected : ''}`}
          style={{ ['--agent' as string]: c.color, ['--tone' as string]: TONE_COLOR[badge.tone] }}
          onClick={(e) => {
            e.stopPropagation();
            onSelectAgent(c.agentId);
          }}
          aria-pressed={c.selected}
          aria-label={`${c.name}: ${c.detail}`}
        >
          <span className={styles.badgeName}>
            <Icon name={c.icon} color={c.color} />
            {c.name}
          </span>
          <span className={styles.badgeState}>
            <Icon name={badge.icon} />
            {c.detail}
          </span>
        </button>
      );
    }
  }
}
