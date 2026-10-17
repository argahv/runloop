'use client';
import { useFrame, useThree } from '@react-three/fiber';
import type { PresentationState } from '@runloop-world/world-engine';
import { useLayoutEffect, useSyncExternalStore } from 'react';
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
  /** Zone signs stay put; every other label moves up out of the way of labels in front of it. */
  readonly fixed = new Set<string>();

  set(id: string, content: LabelContent, anchor: Anchor) {
    this.specs.set(id, content);
    this.anchors.set(id, anchor);
    if (content.kind === 'zone') this.fixed.add(id);
    else this.fixed.delete(id);
    this.boost.set(id, content.kind === 'station' ? 3000 : content.kind === 'agent' ? (content.selected ? 2000 : 1000) : 0);
    this.emit();
  }

  remove(id: string) {
    if (!this.specs.delete(id)) return;
    this.anchors.delete(id);
    this.boost.delete(id);
    this.fixed.delete(id);
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
  // Layout effects, so a synchronous badge update reaches the label layer in the same commit.
  useLayoutEffect(() => {
    if (!content) {
      labels.remove(id);
      return;
    }
    labels.set(id, content, anchor);
    // `key` captures content by value; anchor objects are stable per caller.
  }, [labels, id, key]);
  useLayoutEffect(() => () => labels.remove(id), [labels, id]);
}

const v = new Vector3();
/** Minimum spacing (px) between labels that would otherwise overlap. */
const LABEL_GAP = 3;

interface Placed {
  el: HTMLElement;
  id: string;
  x: number;
  /** Screen y of the label's bottom edge (the anchor point). */
  y: number;
  depth: number;
}

/**
 * Inside the Canvas: projects every label anchor to screen space each frame,
 * then nudges overlapping labels apart. Labels nearer the front (lower on
 * screen) keep their spot; ones further back move up just enough to clear
 * them, so badges at a crowded hub or next to a station stay readable.
 * Mount it last.
 */
export function LabelProjector() {
  const { labels } = useScene();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame(() => {
    camera.updateMatrixWorld();
    const items: Placed[] = [];
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
      if (!off) items.push({ el, id, x, y, depth: p.z });
    }

    items.sort((a, b) => b.y - a.y);
    const taken: { l: number; r: number; t: number; b: number }[] = [];
    for (const it of items) {
      if (!labels.fixed.has(it.id)) {
        const half = it.el.offsetWidth / 2;
        const h = it.el.offsetHeight;
        // Move up past every placed label this one overlaps (a few passes settle chains).
        for (let pass = 0; pass < 6; pass++) {
          let moved = false;
          for (const r of taken) {
            const overlaps =
              it.x + half > r.l - LABEL_GAP && it.x - half < r.r + LABEL_GAP && it.y > r.t - LABEL_GAP && it.y - h < r.b + LABEL_GAP;
            if (overlaps) {
              it.y = r.t - LABEL_GAP;
              moved = true;
            }
          }
          if (!moved) break;
        }
        taken.push({ l: it.x - half, r: it.x + half, t: it.y - h, b: it.y });
      }
      it.el.style.transform = `translate3d(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      it.el.style.zIndex = String(Math.round((1 - it.depth) * 500) + (labels.boost.get(it.id) ?? 0));
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
