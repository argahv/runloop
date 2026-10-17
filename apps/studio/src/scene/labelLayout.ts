/**
 * Collision-free placement for the DOM labels over the world (pure; screen px).
 *
 * Two passes, in priority order. First every label takes its smallest form
 * (an icon for badges) at the nearest free slot around its anchor (on it,
 * beside it, then stacked above), so as many as possible show. Then each
 * grows into a more informative form if one fits beside its anchor. A label
 * that fits nowhere is hidden (the roster and the Network view still list
 * every agent); the selected label always shows, in full. Last frame's slot
 * is tried first so labels do not jitter while characters walk.
 */

export type LabelForm = 'full' | 'compact' | 'icon';

export interface FormSize {
  form: LabelForm;
  w: number;
  h: number;
}

export interface LabelItem {
  id: string;
  /** Anchor (screen px): the label's bottom centre sits here when not displaced. */
  x: number;
  y: number;
  /** Forms to try, most informative first. */
  forms: readonly FormSize[];
  /** Higher is placed first. */
  priority: number;
  /** Badges may move off their anchor (with a leader line); signs only show or hide. */
  movable: boolean;
  /** Restrict the slots tried (indices into SLOTS); default: all when movable, else only the anchor. */
  slots?: readonly number[];
  /** Always shown (the selection), even when it has to overlap. */
  required?: boolean;
  /** Claims its most informative form that fits before smaller labels are placed (hover, focus). */
  eager?: boolean;
}

export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Placement {
  /** null = hidden. */
  form: LabelForm | null;
  /** Bottom centre of the placed label. */
  x: number;
  y: number;
  /** Index into the slot list (0 = on the anchor). */
  slot: number;
  /** Moved away from its anchor: draw a leader line. */
  displaced: boolean;
}

export interface PlaceOptions {
  width: number;
  height: number;
  /** Gap kept between labels (px). */
  gap?: number;
  /** Keep labels this far inside the canvas edges. */
  margin?: number;
  /** Screen areas labels must not cover (floating controls). */
  obstacles?: readonly Rect[];
  /** Last frame's placements, for stability. */
  previous?: ReadonlyMap<string, Placement>;
}

/** Slot offsets in units of (label half-width + gap, label height + gap): on, beside, above. */
const SLOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, -1],
  [1, -1],
  [-1, -1],
  [0, -2],
  [1, -2],
  [-1, -2],
  [0.5, 0],
  [-0.5, 0],
];

/** Slot rows, nearest first: on/beside the anchor, one row up, two rows up. */
const TIERS: readonly (readonly number[])[] = [
  [0, 9, 10, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
];
const ALL_SLOTS = TIERS.flat();
const ANCHOR_ONLY = [0];
/** Signs: on the anchor, or shifted sideways (never stacked, no leader). */
export const SIGN_SLOTS: readonly number[] = [0, 10, 9, 2, 1];

const overlaps = (a: Rect, b: Rect, gap: number) => a.l < b.r + gap && a.r > b.l - gap && a.t < b.b + gap && a.b > b.t - gap;

function rectAt(it: LabelItem, f: FormSize, slot: number, gap: number): { rect: Rect; x: number; y: number } {
  const [sx, sy] = SLOTS[slot]!;
  const x = it.x + sx * (f.w / 2 + gap);
  const y = it.y + sy * (f.h + gap);
  return { rect: { l: x - f.w / 2, r: x + f.w / 2, t: y - f.h, b: y }, x, y };
}

export function placeLabels(items: readonly LabelItem[], opts: PlaceOptions): Map<string, Placement> {
  const gap = opts.gap ?? 4;
  const margin = opts.margin ?? 4;
  const obstacles = opts.obstacles ?? [];
  const placed = new Map<string, { rect: Rect; p: Placement }>();
  /** Placed rectangles, kept flat for the overlap test (it runs for every candidate). */
  const rects: { id: string; rect: Rect }[] = [];
  const put = (id: string, hit: { rect: Rect; p: Placement }) => {
    placed.set(id, hit);
    const i = rects.findIndex((r) => r.id === id);
    if (i >= 0) rects[i]!.rect = hit.rect;
    else rects.push({ id, rect: hit.rect });
  };
  const inside = (r: Rect) => r.l >= margin && r.t >= margin && r.r <= opts.width - margin && r.b <= opts.height - margin;
  const free = (r: Rect, self?: string) => {
    if (!inside(r)) return false;
    for (const o of obstacles) if (overlaps(r, o, gap)) return false;
    for (const x of rects) if (x.id !== self && overlaps(r, x.rect, gap)) return false;
    return true;
  };

  /** First free spot for one form: last frame's slot, then nearest slots first. */
  const find = (it: LabelItem, fi: number, slots: readonly number[], self?: string) => {
    const f = it.forms[fi]!;
    const prev = opts.previous?.get(it.id);
    const order = [...(prev && prev.form === f.form && slots.includes(prev.slot) ? [prev.slot] : []), ...slots];
    for (const s of order) {
      const c = rectAt(it, f, s, gap);
      if (free(c.rect, self)) return { rect: c.rect, p: { form: f.form, x: c.x, y: c.y, slot: s, displaced: s !== 0 } };
    }
    return null;
  };

  const order = [...items].filter((it) => it.forms.length > 0).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const slotsOf = (it: LabelItem) => it.slots ?? (it.movable ? ALL_SLOTS : ANCHOR_ONLY);

  // Phase 1: as many labels as possible, each in its smallest form. A required label takes its most
  // informative form that fits anywhere, and overlaps (clamped on screen) only when none does.
  for (const it of order) {
    let hit = null as ReturnType<typeof find>;
    if (it.required) {
      for (let f = 0; f < it.forms.length && !hit; f++) hit = find(it, f, slotsOf(it));
    } else {
      const fi = it.forms.length - 1;
      if (it.eager) for (let e = 0; e < fi && !hit; e++) hit = find(it, e, slotsOf(it));
      hit ??= find(it, fi, slotsOf(it));
    }
    if (!hit && it.required) {
      const f = it.forms[0]!;
      // Keep it on screen: clamp into the canvas.
      const x = Math.min(opts.width - margin - f.w / 2, Math.max(margin + f.w / 2, it.x));
      const y = Math.min(opts.height - margin, Math.max(margin + f.h, it.y));
      hit = { rect: { l: x - f.w / 2, r: x + f.w / 2, t: y - f.h, b: y }, p: { form: f.form, x, y, slot: 0, displaced: Math.abs(x - it.x) > 1 || Math.abs(y - it.y) > 1 } };
    }
    if (hit) put(it.id, hit);
  }

  // Phase 2: in priority order, grow each label into a more informative form near its anchor.
  for (const it of order) {
    const cur = placed.get(it.id);
    if (!cur || it.required) continue;
    const curIndex = it.forms.findIndex((f) => f.form === cur.p.form);
    const near = slotsOf(it).filter((s) => TIERS[0]!.includes(s));
    for (let fi = 0; fi < curIndex; fi++) {
      const hit = find(it, fi, near, it.id);
      if (hit) {
        put(it.id, hit);
        break;
      }
    }
  }

  const out = new Map<string, Placement>();
  for (const it of items) out.set(it.id, placed.get(it.id)?.p ?? { form: null, x: it.x, y: it.y, slot: 0, displaced: false });
  return out;
}

/** True when no two shown labels overlap (used by tests and debug checks). */
export function noOverlaps(items: readonly LabelItem[], placements: ReadonlyMap<string, Placement>): boolean {
  const rects: Rect[] = [];
  for (const it of items) {
    const p = placements.get(it.id);
    if (!p?.form) continue;
    const f = it.forms.find((x) => x.form === p.form)!;
    const r = { l: p.x - f.w / 2, r: p.x + f.w / 2, t: p.y - f.h, b: p.y };
    if (rects.some((o) => overlaps(r, o, 0))) return false;
    rects.push(r);
  }
  return true;
}
