import { describe, expect, it } from 'vitest';
import { SIGN_SLOTS, noOverlaps, placeLabels, type FormSize, type LabelItem } from './labelLayout';

const badge = (id: string, x: number, y: number, priority = 400, extra: Partial<LabelItem> = {}): LabelItem => ({
  id,
  x,
  y,
  priority,
  movable: true,
  forms: [
    { form: 'compact', w: 110, h: 22 },
    { form: 'icon', w: 34, h: 22 },
  ],
  ...extra,
});

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('label placement', () => {
  it('leaves a lone label on its anchor in its best form', () => {
    const p = placeLabels([badge('a', 300, 200)], { width: 800, height: 400 }).get('a')!;
    expect(p).toMatchObject({ form: 'compact', x: 300, y: 200, displaced: false });
  });

  it('never overlaps labels, even for a crowd of characters at the hub', () => {
    // Nine robots within a few cells of each other (a traced run with 8 subagents at home).
    const items = Array.from({ length: 9 }, (_, i) => badge(`a${i}`, 380 + (i % 3) * 28, 200 + Math.floor(i / 3) * 14, 400 + i));
    const placed = placeLabels(items, { width: 800, height: 400 });
    expect(noOverlaps(items, placed)).toBe(true);
    expect([...placed.values()].filter((p) => p.form !== null).length).toBeGreaterThanOrEqual(6);
  });

  it('never overlaps across random scenes and canvas sizes', () => {
    const r = rng(7);
    for (let n = 0; n < 200; n++) {
      const w = 500 + r() * 1400;
      const h = 300 + r() * 500;
      const items: LabelItem[] = Array.from({ length: 2 + Math.floor(r() * 12) }, (_, i) => badge(`b${i}`, r() * w, 30 + r() * h, Math.floor(r() * 700)));
      items.push({ id: 'zone', x: r() * w, y: r() * h, priority: 100, movable: false, slots: SIGN_SLOTS, forms: [{ form: 'full', w: 120, h: 20 }] });
      const placed = placeLabels(items, { width: w, height: h, gap: 4, margin: 4 });
      expect(noOverlaps(items, placed)).toBe(true);
      for (const [, p] of placed) {
        if (!p.form) continue;
        expect(p.y).toBeLessThanOrEqual(h - 4 + 1e-6);
      }
    }
  });

  it('places higher priority first: the selected badge keeps the spot in full, others move or collapse', () => {
    const full: FormSize[] = [{ form: 'full', w: 160, h: 44 }];
    const items = [badge('other', 300, 200, 400), badge('sel', 305, 202, 1000, { forms: full, required: true })];
    const placed = placeLabels(items, { width: 800, height: 400 });
    expect(placed.get('sel')).toMatchObject({ form: 'full', displaced: false });
    const other = placed.get('other')!;
    expect(other.form === null || other.displaced || other.form === 'icon').toBe(true);
    expect(noOverlaps(items, placed)).toBe(true);
  });

  it('a second required label falls back to a smaller form instead of covering the first', () => {
    // A selected incident and the selected agent at the same station on a small canvas.
    const incident = badge('incident', 200, 60, 1000, { forms: [{ form: 'full', w: 270, h: 20 }], required: true });
    const agent = badge('agent', 205, 62, 990, {
      forms: [
        { form: 'full', w: 170, h: 46 },
        { form: 'compact', w: 80, h: 22 },
      ],
      required: true,
    });
    const items = [incident, agent];
    const placed = placeLabels(items, { width: 420, height: 90 });
    expect(placed.get('incident')).toMatchObject({ form: 'full', displaced: false });
    expect(placed.get('agent')?.form).toBe('compact');
    expect(noOverlaps(items, placed)).toBe(true);
  });

  it('keeps a required label on screen even when nothing is free', () => {
    const full: FormSize[] = [{ form: 'full', w: 160, h: 44 }];
    const placed = placeLabels([badge('sel', 2, 400, 1000, { forms: full, required: true })], {
      width: 300,
      height: 400,
      obstacles: [{ l: 0, t: 0, r: 300, b: 400 }],
    });
    const p = placed.get('sel')!;
    expect(p.form).toBe('full');
    expect(p.x).toBeGreaterThanOrEqual(80);
  });

  it('avoids obstacles (floating controls)', () => {
    const placed = placeLabels([badge('a', 400, 30)], { width: 800, height: 400, obstacles: [{ l: 0, t: 0, r: 800, b: 46 }] });
    const p = placed.get('a')!;
    // 22 px tall above y = 30 would reach under the toolbar band: it moves sideways/down is not allowed, so it hides.
    expect(p.form === null || p.y - 22 >= 46).toBe(true);
  });

  it('signs only shift sideways (never stacked) and hide when blocked', () => {
    const sign: LabelItem = { id: 'zone', x: 790, y: 100, priority: 100, movable: false, slots: SIGN_SLOTS, forms: [{ form: 'full', w: 120, h: 20 }] };
    const p = placeLabels([sign], { width: 800, height: 400 }).get('zone')!;
    expect(p.form).toBe('full');
    expect(p.y).toBe(100);
    expect(p.x + 60).toBeLessThanOrEqual(796);
    const blocked = placeLabels([sign, badge('a', 730, 100, 900, { forms: [{ form: 'compact', w: 400, h: 60 }] })], { width: 800, height: 400 });
    expect(blocked.get('zone')!.form).toBeNull();
  });

  it('expands a hovered label in place, moving smaller neighbours instead', () => {
    const full: FormSize[] = [
      { form: 'full', w: 120, h: 44 },
      { form: 'compact', w: 90, h: 22 },
    ];
    const items = [badge('hovered', 400, 200, 950, { forms: full, movable: false, eager: true }), badge('near', 420, 160, 400)];
    const placed = placeLabels(items, { width: 800, height: 400 });
    expect(placed.get('hovered')).toMatchObject({ form: 'full', x: 400, y: 200 });
    expect(noOverlaps(items, placed)).toBe(true);
  });

  it('is stable: last frame’s placement is kept while it stays free', () => {
    const items = [badge('a', 300, 200, 500), badge('b', 320, 200, 400)];
    const first = placeLabels(items, { width: 800, height: 400 });
    // Move b a little: it should keep the same slot rather than jump to another candidate.
    const moved = [items[0]!, { ...items[1]!, x: 322 }];
    const second = placeLabels(moved, { width: 800, height: 400, previous: first });
    expect(second.get('b')!.slot).toBe(first.get('b')!.slot);
    expect(second.get('b')!.form).toBe(first.get('b')!.form);
  });
});
