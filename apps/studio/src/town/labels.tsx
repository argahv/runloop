'use client';
import { useFrame, useThree } from '@react-three/fiber';
import { formatEntityRef, type EntityRef, type ResidentState } from '@runloop-world/events';
import { isOpenAt, minuteOfDay } from '@runloop-world/town';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Vector3 } from 'three';
import { placeLabels, type LabelItem, type Placement } from '../scene/labelLayout';
import { ROBOT_LABEL_Y } from './AgentHq';
import { agentStatus, type LabelTone } from './status';
import { sceneX, sceneZ } from './coords';
import { useTown, type TownCtx } from './context';
import { buildingShape } from './geometry/buildings';
import type { ScreenRect } from './types';
import styles from './town.module.css';

/** At most this many labels at once (plan §5). */
export const LABEL_BUDGET = 24;


export interface TownLabel {
  key: string;
  ref: EntityRef;
  kind: 'district' | 'building' | 'resident' | 'agent' | 'lot';
  title: string;
  detail: string | null;
  /** Provenance chip: "Agent · Claude Code" (real) or "Simulated" (residents). */
  chip: string | null;
  tone: LabelTone;
  anchor: Vector3;
  priority: number;
  required: boolean;
  /** Shown only in full form at the anchor (hover). */
  eager: boolean;
}

const ACTION_TEXT: Record<ResidentState['action'], string> = {
  sleep: 'Sleeping',
  rest: 'Resting',
  eat: 'Eating',
  work: 'Working',
  socialize: 'Chatting',
  stroll: 'Strolling',
};

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
function textWidth(text: string, weight: number): number {
  const k = `${weight}|${text}`;
  const hit = widthCache.get(k);
  if (hit !== undefined) return hit;
  if (!measureCtx && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
  let w = text.length * 7;
  if (measureCtx) {
    measureCtx.font = `${weight} 12px Geist, "Geist Sans", ui-sans-serif, system-ui, sans-serif`;
    w = measureCtx.measureText(text).width;
  }
  widthCache.set(k, w);
  return w;
}

/** The provenance chip an agent keeps in its compact form. */
const SHORT_CHIP = 'Agent';
/** Agents' labels stay beside their robot (never stacked far away). */
const NEAR_SLOTS = [0, 9, 10, 1, 2, 3, 4, 5];

/** Pill sizes for a label's two forms (compact = title only; agents keep a short chip). */
function sizes(l: TownLabel): { full: { w: number; h: number }; compact: { w: number; h: number } } {
  const pad = 20;
  const dot = l.tone !== 'none' || l.kind === 'agent' ? 14 : 0;
  const title = textWidth(l.title, 600);
  const chip = l.chip ? textWidth(l.chip, 500) + 18 : 0;
  const short = l.kind === 'agent' ? textWidth(SHORT_CHIP, 500) + 18 : 0;
  const detail = l.detail ? textWidth(l.detail, 400) + 14 : 0;
  return { full: { w: Math.ceil(pad + dot + chip + title + detail), h: 26 }, compact: { w: Math.ceil(pad + dot + short + title), h: 26 } };
}

/** Anchors that never move (buildings, districts), computed once per town. */
const staticAnchors = new WeakMap<object, Map<string, Vector3>>();
function anchorOf(ctx: TownCtx, key: string, make: () => Vector3): Vector3 {
  let m = staticAnchors.get(ctx.town);
  if (!m) staticAnchors.set(ctx.town, (m = new Map()));
  let v = m.get(key);
  if (!v) m.set(key, (v = make()));
  return v;
}

/** Collect the candidate labels for this frame, highest priority first. */
export function collectLabels(ctx: TownCtx): TownLabel[] {
  const { town, frame, live } = ctx;
  const f = { width: town.width, height: town.height };
  const snap = frame.snapshot;
  const out: TownLabel[] = [];
  const sel = live.selected ? formatEntityRef(live.selected) : null;
  const hov = live.hovered ? formatEntityRef(live.hovered) : null;
  const fol = live.follow ? formatEntityRef(live.follow) : null;
  const rank = (key: string, base: number) => (key === sel ? 990 : key === hov ? 950 : key === fol ? 900 : base);
  const minute = minuteOfDay(Math.floor(frame.tick));

  // Agents: always labelled (they are real), with the provenance chip; while a headquarters is open, the others' robots step back.
  const hqOpen = (snap?.agents ?? []).some((a) => a.buildingId === frame.entered);
  for (const a of snap?.agents ?? []) {
    const p = ctx.agentPos.get(a.agentId);
    if (!p || hqOpen) continue;
    const key = formatEntityRef({ kind: 'agent', id: a.agentId });
    const st = agentStatus(a);
    out.push({
      key,
      ref: { kind: 'agent', id: a.agentId },
      kind: 'agent',
      title: a.displayName,
      detail: st.text,
      chip: 'Agent · Claude Code',
      tone: st.tone,
      anchor: new Vector3(p.x, p.y + ROBOT_LABEL_Y, p.z),
      priority: rank(key, st.tone === 'fail' || st.tone === 'warn' ? 640 : 600),
      required: key === sel,
      eager: key === hov,
    });
  }

  // Districts at town and district zoom.
  if (frame.level === 'town' || frame.level === 'district') {
    for (const d of town.def.districts) {
      const [x, y, w, h] = d.rects.reduce((a, r) => (r[2] * r[3] > a[2] * a[3] ? r : a));
      const key = formatEntityRef({ kind: 'district', id: d.id });
      out.push({
        key,
        ref: { kind: 'district', id: d.id },
        kind: 'district',
        title: d.label,
        detail: null,
        chip: null,
        tone: 'none',
        anchor: anchorOf(ctx, key, () => new Vector3(sceneX(f, x + (w - 1) / 2), 1.5, sceneZ(f, y + (h - 1) / 2))),
        priority: rank(key, 120),
        required: key === sel,
        eager: false,
      });
    }
  }

  // Buildings: at street level the ones near the centre of the view (the projector ranks by screen distance); at any level the selected or hovered one.
  const near = frame.level === 'street' || frame.level === 'interior';
  for (const b of town.buildings) {
    const key = formatEntityRef({ kind: 'building', id: b.def.id });
    const special = key === sel || key === hov;
    if (!near && !special) continue;
    const [x, y, w, h] = b.def.footprint;
    const anchor = anchorOf(ctx, key, () => new Vector3(sceneX(f, x + (w - 1) / 2), buildingShape(b).top + 0.2, sceneZ(f, y + (h - 1) / 2)));
    if (!special && frame.entered && frame.entered !== b.def.id) continue;
    const st = snap?.buildings[b.idx]?.id === b.def.id ? snap.buildings[b.idx] : snap?.buildings.find((s) => s.id === b.def.id);
    const open = st ? st.open && isOpenAt(b.hours, minute) : true;
    const n = st?.occupancy ?? 0;
    const detail = !open ? 'Closed' : n > 0 ? `${n} inside` : b.isHome ? 'Home' : 'Open';
    out.push({
      key,
      ref: { kind: 'building', id: b.def.id },
      kind: 'building',
      title: b.def.name,
      detail,
      chip: null,
      tone: 'none',
      anchor,
      priority: rank(key, 200),
      required: key === sel,
      eager: key === hov,
    });
  }

  // Add to World: every offered lot is a label button ("Lot 3 · Free"; a taken one names its agent).
  const pick = live.lotPick;
  if (pick) {
    for (const l of pick.lots) {
      const lot = town.lotById.get(l.id);
      if (!lot) continue;
      const key = formatEntityRef({ kind: 'lot', id: l.id });
      const [x, y, w, h] = lot.rect;
      const selected = pick.selected === l.id;
      out.push({
        key,
        ref: { kind: 'lot', id: l.id },
        kind: 'lot',
        title: l.label,
        detail: null,
        chip: null,
        tone: 'none',
        anchor: anchorOf(ctx, key, () => new Vector3(sceneX(f, x + (w - 1) / 2), 0.7, sceneZ(f, y + (h - 1) / 2))),
        priority: selected ? 995 : l.state === 'free' ? 720 : 560,
        required: selected,
        eager: false,
      });
    }
  }

  // Residents: only the selected, hovered or followed one (others are found through the directory and ⌘K).
  for (const key of new Set([sel, hov, fol])) {
    if (!key?.startsWith('resident:')) continue;
    const id = key.slice('resident:'.length);
    const i = snap?.residents.findIndex((r) => r.id === id) ?? -1;
    if (i < 0 || !ctx.residentVisible[i]) continue;
    const r = snap!.residents[i]!;
    const walking = r.motion !== null;
    let detail = walking ? 'Walking' : ACTION_TEXT[r.action];
    if (walking && r.motion) {
      const end = r.motion.path[r.motion.path.length - 1]!;
      const dest = town.doorAt.get(end[1] * town.width + end[0]);
      const spot = town.spotSlotAt.get(end[1] * town.width + end[0]);
      const name = dest ? town.buildingById.get(dest)?.def.name : spot ? town.spotById.get(spot.spotId)?.def.label : undefined;
      if (name) detail = `Walking to ${name}`;
    }
    out.push({
      key,
      ref: { kind: 'resident', id },
      kind: 'resident',
      title: r.name,
      detail,
      chip: 'Simulated',
      tone: 'none',
      anchor: new Vector3(ctx.residentPos[i * 3]!, ctx.residentPos[i * 3 + 1]! + 1.15, ctx.residentPos[i * 3 + 2]!),
      priority: rank(key, 800),
      required: key === sel,
      eager: key === hov,
    });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/** DOM side: a fixed pool of LABEL_BUDGET buttons the projector fills each frame (no React updates per frame). */
export interface LabelPoolHandle {
  slots: HTMLButtonElement[];
}

export const TownLabelLayer = forwardRef<LabelPoolHandle, { onSelect: (ref: EntityRef) => void; onHover: (ref: EntityRef | null) => void }>(function TownLabelLayer({ onSelect, onHover }, ref) {
  const slots = useRef<HTMLButtonElement[]>([]);
  useImperativeHandle(ref, () => ({ slots: slots.current }), []);
  const parse = (el: HTMLElement): EntityRef | null => {
    const k = el.dataset.ref;
    if (!k) return null;
    const i = k.indexOf(':');
    return { kind: k.slice(0, i) as EntityRef['kind'], id: k.slice(i + 1) };
  };
  return (
    <div className={styles.labels} aria-hidden={false}>
      {Array.from({ length: LABEL_BUDGET }, (_, i) => (
        <button
          key={i}
          type="button"
          className={styles.label}
          data-town-label
          tabIndex={-1}
          style={{ visibility: 'hidden' }}
          ref={(el) => {
            if (el) slots.current[i] = el;
          }}
          onClick={(e) => {
            e.stopPropagation();
            const r = parse(e.currentTarget);
            if (r) onSelect(r);
          }}
          onPointerEnter={(e) => onHover(parse(e.currentTarget))}
          onPointerLeave={() => onHover(null)}
        >
          <span className={styles.dot} aria-hidden />
          <span className={styles.chip} />
          <span className={styles.title} />
          <span className={styles.detail} />
        </button>
      ))}
    </div>
  );
});

const v = new Vector3();

/** Inside the canvas: choose, project and place up to LABEL_BUDGET labels each frame. */
export function TownLabelProjector({ pool, obstacles }: { pool: React.RefObject<LabelPoolHandle | null>; obstacles?: (w: number, h: number) => ScreenRect[] }) {
  const ctx = useTown();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const previous = useRef(new Map<string, Placement>());
  const shown = useRef<(string | null)[]>([]);
  useFrame(() => {
    const slots = pool.current?.slots;
    if (!slots) return;
    camera.updateMatrixWorld();
    const cands = collectLabels(ctx);
    const items: LabelItem[] = [];
    const byKey = new Map<string, TownLabel>();
    const view = ctx.cam.ctl.view;
    const lowTilt = view.pose.tilt < (25 * Math.PI) / 180;
    for (const l of cands) {
      // Never behind the camera or out in the haze; near the horizon, building names only near the target.
      const dist = Math.hypot(l.anchor.x - view.eye[0], l.anchor.y - view.eye[1], l.anchor.z - view.eye[2]);
      if (!l.required && dist > ctx.cam.fogNear) continue;
      if (lowTilt && l.kind === 'building' && !l.required && !l.eager && dist > view.d * 1.6) continue;
      v.copy(l.anchor).project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      if (v.z > 1 || x < -30 || y < -30 || x > size.width + 30 || y > size.height + 30) continue;
      const s = sizes(l);
      const far = ctx.frame.level === 'town' || ctx.frame.level === 'district';
      const forms =
        l.kind === 'district' || l.kind === 'resident' || l.kind === 'lot' || l.required || l.eager
          ? [{ form: 'full' as const, ...s.full }]
          : far && l.kind === 'agent' && l.tone !== 'warn' && l.tone !== 'fail'
            ? [{ form: 'compact' as const, ...s.compact }]
            : [
                { form: 'full' as const, ...s.full },
                { form: 'compact' as const, ...s.compact },
              ];
      byKey.set(l.key, l);
      // Building names nearest the middle of the view win.
      const centre = l.kind === 'building' && l.priority < 900 ? Math.hypot(x - size.width / 2, y - size.height / 2) / 12 : 0;
      items.push({
        id: l.key,
        x,
        y,
        forms,
        priority: l.priority - centre,
        movable: l.kind !== 'district' && l.kind !== 'lot',
        ...(l.kind === 'agent' && !l.required ? { slots: NEAR_SLOTS } : {}),
        required: l.required,
        eager: l.eager,
      });
    }
    items.sort((a, b) => b.priority - a.priority);
    items.length = Math.min(items.length, ctx.live.labelBudget);
    // The HUD's occluded edges (an open sheet, the hotbar) are obstacles too.
    const ins = ctx.cam.ctl.goalInsets;
    const edges: ScreenRect[] = [];
    if (ins.right > 0) edges.push({ l: size.width - ins.right, t: 0, r: size.width, b: size.height });
    if (ins.left > 0) edges.push({ l: 0, t: 0, r: ins.left, b: size.height });
    if (ins.top > 0) edges.push({ l: 0, t: 0, r: size.width, b: ins.top });
    if (ins.bottom > 0) edges.push({ l: 0, t: size.height - ins.bottom, r: size.width, b: size.height });
    const placed = placeLabels(items, { width: size.width, height: size.height, gap: 4, margin: 6, obstacles: [...(obstacles?.(size.width, size.height) ?? []), ...edges], previous: previous.current });
    previous.current = placed;
    let n = 0;
    for (const it of items) {
      const p = placed.get(it.id);
      if (!p?.form || n >= slots.length) continue;
      const l = byKey.get(it.id)!;
      const el = slots[n]!;
      if (shown.current[n] !== `${l.key}|${l.title}|${l.detail}|${l.chip}|${l.tone}|${p.form}`) {
        shown.current[n] = `${l.key}|${l.title}|${l.detail}|${l.chip}|${l.tone}|${p.form}`;
        el.dataset.ref = l.key;
        el.dataset.kind = l.kind;
        el.dataset.tone = l.tone;
        el.dataset.form = p.form;
        el.dataset.selected = l.required ? 'true' : 'false';
        const [dot, chip, title, detail] = Array.from(el.children) as HTMLElement[];
        dot!.hidden = l.tone === 'none' && l.kind !== 'agent';
        const chipText = p.form === 'full' ? l.chip : l.kind === 'agent' ? SHORT_CHIP : null;
        chip!.textContent = chipText ?? '';
        chip!.hidden = !chipText;
        title!.textContent = l.title;
        detail!.textContent = p.form === 'full' && l.detail ? l.detail : '';
        detail!.hidden = !(p.form === 'full' && l.detail);
        el.setAttribute('aria-label', l.kind === 'lot' ? `${l.title}, agent lot` : [l.title, l.chip, l.detail].filter(Boolean).join(', '));
        el.tabIndex = 0;
      }
      el.style.visibility = 'visible';
      el.dataset.shown = 'true';
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.zIndex = String(it.priority);
      n++;
    }
    for (let i = n; i < slots.length; i++) {
      if (shown.current[i] !== null) {
        shown.current[i] = null;
        slots[i]!.style.visibility = 'hidden';
        slots[i]!.dataset.shown = 'false';
        slots[i]!.tabIndex = -1;
        delete slots[i]!.dataset.ref;
      }
    }
  });
  return null;
}
