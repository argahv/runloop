'use client';
import { useFrame, useThree } from '@react-three/fiber';
import type { PresentationState } from '@runloop-world/world-engine';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { Vector3 } from 'three';
import { STATE_BADGE, TONE_COLOR, type IconName } from './badges';
import { useScene } from './context';
import { Icon } from './Icon';
import { SIGN_SLOTS, placeLabels, type FormSize, type LabelForm, type LabelItem, type Placement, type Rect } from './labelLayout';
import styles from './scene.module.css';

/**
 * DOM labels over the canvas (agent badges, environment signs, station names,
 * incident chips). They live in the page's React tree (accessible buttons,
 * real text in the app's font); the scene registers what to show and where,
 * and a projector places them every frame through refs, with no React
 * updates per frame. Placement is collision-free (labelLayout.ts): badges
 * collapse to one line or an icon, or step aside with a leader line.
 */
export type LabelContent =
  | { kind: 'zone'; text: string; color: string }
  | { kind: 'station'; text: string; color: string }
  | {
      kind: 'agent';
      agentId: string;
      name: string;
      /** CSS colour (identity token). */
      color: string;
      icon: IconName;
      state: PresentationState;
      detail: string;
      /** Running tool for the one-line badge ('' = none). */
      short: string;
      /** Reported usage, or null (not reported: nothing is shown). */
      usage: string | null;
      selected: boolean;
      /** Finished subagent: shown quieter. */
      dim: boolean;
    }
  | { kind: 'incident'; open: boolean; text: string; short: string; title: string; seq: number; selected: boolean };

/** World-space anchor: a fixed point, or a function evaluated every frame. */
export type Anchor = Vector3 | ((out: Vector3) => Vector3 | null);

type Sizes = Partial<Record<LabelForm, { w: number; h: number }>>;

export class LabelStore {
  private specs = new Map<string, LabelContent>();
  private snap: readonly [string, LabelContent][] = [];
  private listeners = new Set<() => void>();
  readonly anchors = new Map<string, Anchor>();
  readonly elements = new Map<string, HTMLElement>();
  readonly leaders = new Map<string, HTMLElement>();
  /** Measured size of each form (from hidden twins, kept current by a ResizeObserver). */
  readonly sizes = new Map<string, Sizes>();
  /** Label under the pointer or holding keyboard focus: shown in full. */
  hovered: string | null = null;
  focused: string | null = null;
  /** Screen areas covered by floating controls, for the current canvas size. */
  obstacles: (w: number, h: number) => Rect[] = () => [];
  previous = new Map<string, Placement>();

  get(id: string): LabelContent | undefined {
    return this.specs.get(id);
  }

  set(id: string, content: LabelContent, anchor: Anchor) {
    this.specs.set(id, content);
    this.anchors.set(id, anchor);
    this.emit();
  }

  remove(id: string) {
    if (!this.specs.delete(id)) return;
    this.anchors.delete(id);
    this.sizes.delete(id);
    this.previous.delete(id);
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

const AGENT_PRIORITY: Record<PresentationState, number> = {
  failed: 620,
  awaiting_approval: 610,
  working: 520,
  waiting: 480,
  moving: 430,
  succeeded: 420,
  idle: 400,
  paused: 400,
};

/** How a label competes for space: priority, forms to try, and whether it may move. */
export function labelRules(id: string, c: LabelContent, hovered: string | null, focused: string | null): Omit<LabelItem, 'x' | 'y' | 'forms'> & { forms: LabelForm[] } {
  const hot = id === hovered || id === focused;
  switch (c.kind) {
    case 'agent':
      // Selected: always shown, in full when it fits. A selected incident (the event being inspected) is placed first.
      if (c.selected) return { id, priority: 990, forms: ['full', 'compact'], movable: true, required: true };
      // Hovered or focused: expand in place when there is room (see LabelProjector), so it never slides out from under the pointer.
      if (hot) return { id, priority: 950, forms: ['full', 'compact', 'icon'], movable: false, eager: true };
      return { id, priority: c.dim ? 300 : AGENT_PRIORITY[c.state], forms: ['compact', 'icon'], movable: true };
    case 'incident':
      if (c.selected) return { id, priority: 1000, forms: ['full'], movable: true, required: true };
      if (hot) return { id, priority: 940, forms: ['full', 'compact'], movable: false, eager: true };
      return c.open ? { id, priority: 560, forms: ['full', 'compact'], movable: true } : { id, priority: 60, forms: ['compact'], movable: true };
    case 'station':
      return { id, priority: 980, forms: ['full'], movable: true, eager: true };
    case 'zone':
      return { id, priority: 100, forms: ['full'], movable: false, slots: SIGN_SLOTS };
  }
}

const v = new Vector3();

/**
 * Inside the Canvas: projects every label anchor to screen space each frame
 * and places the labels without overlaps (labelLayout.ts). Mount it last.
 */
export function LabelProjector() {
  const { labels } = useScene();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const hide = (id: string) => {
    const el = labels.elements.get(id);
    const leader = labels.leaders.get(id);
    if (el) el.style.visibility = 'hidden';
    if (leader) leader.style.visibility = 'hidden';
  };
  useFrame(() => {
    camera.updateMatrixWorld();
    const items: LabelItem[] = [];
    const anchorsPx = new Map<string, { x: number; y: number }>();
    for (const id of labels.elements.keys()) {
      const c = labels.get(id);
      const a = labels.anchors.get(id);
      const p = typeof a === 'function' ? a(v) : a ? v.copy(a) : null;
      const sizes = labels.sizes.get(id);
      if (!c || !p || !sizes) {
        hide(id);
        continue;
      }
      p.project(camera);
      const x = ((p.x + 1) / 2) * size.width;
      const y = ((1 - p.y) / 2) * size.height;
      if (p.z > 1 || x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40) {
        hide(id);
        continue;
      }
      const rules = labelRules(id, c, labels.hovered, labels.focused);
      // A hovered/focused label grows from where it already is: full if it fits there, else as it was.
      const prev = id === labels.hovered || id === labels.focused ? labels.previous.get(id) : undefined;
      if (prev?.form) rules.forms = rules.forms.filter((f, i) => i === 0 || f === prev.form);
      const forms: FormSize[] = [];
      for (const f of rules.forms) {
        const s = sizes[f];
        if (s && s.w > 0) forms.push({ form: f, w: s.w, h: s.h });
      }
      anchorsPx.set(id, { x, y });
      items.push({ ...rules, forms, x: prev?.form ? prev.x : x, y: prev?.form ? prev.y : y });
    }

    const placed = placeLabels(items, {
      width: size.width,
      height: size.height,
      gap: 4,
      margin: 4,
      obstacles: labels.obstacles(size.width, size.height),
      previous: labels.previous,
    });
    labels.previous = placed;

    for (const it of items) {
      const el = labels.elements.get(it.id)!;
      const p = placed.get(it.id);
      const leader = labels.leaders.get(it.id);
      if (!p || !p.form) {
        hide(it.id);
        continue;
      }
      if (el.dataset.form !== p.form) el.dataset.form = p.form;
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.zIndex = String(it.priority);
      if (leader) {
        const a = anchorsPx.get(it.id)!;
        const dx = p.x - a.x;
        const dy = p.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len > 6 && labels.get(it.id)?.kind !== 'zone') {
          leader.style.visibility = 'visible';
          leader.style.width = `${(len - 2).toFixed(1)}px`;
          leader.style.transform = `translate3d(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px, 0) rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`;
        } else {
          leader.style.visibility = 'hidden';
        }
      }
    }
  });
  return null;
}

/** Outside the Canvas: renders the labels as DOM, plus hidden twins that measure every form. */
export function LabelLayer({
  store,
  onSelectAgent,
  onSelectEvent,
}: {
  store: LabelStore;
  onSelectAgent: (id: string | null) => void;
  onSelectEvent?: (seq: number) => void;
}) {
  const list = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return (
    <div className={styles.labels}>
      {list.map(([id]) => (
        <div key={`leader:${id}`} className={styles.leader} aria-hidden ref={(el) => void (el ? store.leaders.set(id, el) : store.leaders.delete(id))} />
      ))}
      {list.map(([id, c]) => (
        <div
          key={id}
          className={styles.label}
          data-kind={c.kind}
          data-form="compact"
          ref={(el) => {
            if (el) store.elements.set(id, el);
            else store.elements.delete(id);
          }}
        >
          <LabelBody id={id} content={c} store={store} onSelectAgent={onSelectAgent} onSelectEvent={onSelectEvent} />
        </div>
      ))}
      <Measure list={list} store={store} />
    </div>
  );
}

/** Hidden copies of every label with all forms laid out, so their sizes are known before placement. */
function Measure({ list, store }: { list: readonly [string, LabelContent][]; store: LabelStore }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      for (const item of el.querySelectorAll<HTMLElement>('[data-measure-id]')) {
        const id = item.dataset.measureId!;
        const sizes: Sizes = {};
        for (const part of item.querySelectorAll<HTMLElement>('[data-part]')) {
          sizes[part.dataset.part as LabelForm] = { w: part.offsetWidth, h: part.offsetHeight };
        }
        store.sizes.set(id, sizes);
      }
    };
    read();
    const ro = new ResizeObserver(read);
    for (const part of el.querySelectorAll<HTMLElement>('[data-part]')) ro.observe(part);
    return () => ro.disconnect();
  }, [list, store]);
  return (
    <div ref={root} className={styles.measure} aria-hidden>
      {list.map(([id, c]) => (
        <div key={id} data-measure-id={id} className={styles.measureItem}>
          <LabelBody id={id} content={c} store={store} measure />
        </div>
      ))}
    </div>
  );
}

function LabelBody({
  id,
  content: c,
  store,
  measure,
  onSelectAgent,
  onSelectEvent,
}: {
  id: string;
  content: LabelContent;
  store: LabelStore;
  measure?: boolean;
  onSelectAgent?: (id: string | null) => void;
  onSelectEvent?: (seq: number) => void;
}) {
  // Hover and keyboard focus expand a label to its full form (the projector reads these every frame).
  const hot = measure
    ? {}
    : {
        onPointerEnter: () => void (store.hovered = id),
        onPointerLeave: () => void (store.hovered === id && (store.hovered = null)),
        onFocus: () => void (store.focused = id),
        onBlur: () => void (store.focused === id && (store.focused = null)),
      };
  const tab = measure ? -1 : undefined;
  switch (c.kind) {
    case 'zone':
      return (
        <span className={`${styles.pill} ${styles.zone}`} data-part="full" style={{ '--zone': c.color } as CSSProperties}>
          <span className={styles.zoneMark} aria-hidden />
          {c.text}
        </span>
      );
    case 'station':
      return (
        <span className={`${styles.pill} ${styles.station}`} data-part="full" style={{ '--zone': c.color } as CSSProperties}>
          {c.text}
        </span>
      );
    case 'incident':
      return (
        <button
          type="button"
          tabIndex={tab}
          className={styles.hit}
          data-open={c.open || undefined}
          data-selected={c.selected || undefined}
          title={c.title}
          aria-label={`${c.text}. Open the failing event`}
          onClick={(e) => {
            e.stopPropagation();
            onSelectEvent?.(c.seq);
          }}
          {...hot}
        >
          <span className={`${styles.pill} ${styles.incident}`} data-part="full">
            <Icon name={c.open ? 'alert' : 'check'} />
            {c.text}
          </span>
          <span className={`${styles.pill} ${styles.incident}`} data-part="compact">
            <Icon name={c.open ? 'alert' : 'check'} />
            {c.short}
          </span>
        </button>
      );
    case 'agent': {
      const badge = STATE_BADGE[c.state];
      const vars = { '--agent': c.color, '--tone': TONE_COLOR[badge.tone] } as CSSProperties;
      return (
        <button
          type="button"
          tabIndex={tab}
          className={styles.hit}
          style={vars}
          data-selected={c.selected || undefined}
          data-dim={c.dim || undefined}
          data-state={c.state}
          onClick={(e) => {
            e.stopPropagation();
            onSelectAgent?.(c.agentId);
          }}
          aria-pressed={measure ? undefined : c.selected}
          aria-label={`${c.name}: ${c.detail}${c.usage ? `, ${c.usage}` : ''}`}
          title={`${c.name} · ${c.detail}${c.usage ? ` · ${c.usage}` : ''}`}
          {...hot}
        >
          <span className={`${styles.pill} ${styles.badgeFull}`} data-part="full">
            <span className={styles.badgeName}>
              <span className={styles.idDot} aria-hidden />
              {c.name}
            </span>
            <span className={styles.badgeState}>
              <Icon name={badge.icon} />
              {c.detail}
            </span>
            {c.usage && <span className={styles.badgeUsage}>{c.usage}</span>}
          </span>
          <span className={`${styles.pill} ${styles.badgeCompact}`} data-part="compact">
            <span className={styles.idDot} aria-hidden />
            <span className={styles.badgeNameText}>{c.name}</span>
            <span className={styles.badgeTone}>
              <Icon name={badge.icon} />
              {c.short && <span>{c.short}</span>}
            </span>
          </span>
          <span className={`${styles.pill} ${styles.badgeIcon}`} data-part="icon">
            <span className={styles.idDot} aria-hidden />
            <span className={styles.badgeTone}>
              <Icon name={badge.icon} />
            </span>
          </span>
        </button>
      );
    }
  }
}
