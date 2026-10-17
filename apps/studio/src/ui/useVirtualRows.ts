'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { scrollWithin } from './scroll';

/** Lists shorter than this render every row; longer ones only the rows near the viewport. */
export const VIRTUAL_MIN_ROWS = 150;
/** Rows rendered above and below the viewport. */
const OVERSCAN = 12;

export interface VirtualRows {
  /** Rows [start, end) are rendered. */
  start: number;
  end: number;
  /** Height of the rows not rendered above and below (render as spacers). */
  padTop: number;
  padBottom: number;
  /** Ref for row `index`'s element, so its real height is used. */
  measure(index: number): (el: HTMLElement | null) => void;
  /** Bring row `index` into view (rendering it if needed). */
  scrollToIndex(index: number, align?: 'nearest' | 'center'): void;
  /** Bring row `index` into view and focus its first `selector` element. */
  focusIndex(index: number, selector: string): void;
}

/**
 * Windowing for a long list of variable-height rows in `containerRef` (the
 * scrolling element; when it does not scroll, the page does). Heights are
 * measured as rows render and kept by row key, so filtering keeps them.
 */
export function useVirtualRows(containerRef: RefObject<HTMLElement | null>, keys: readonly string[], estimate: number): VirtualRows {
  const count = keys.length;
  const enabled = count >= VIRTUAL_MIN_ROWS;
  const heights = useRef(new Map<string, number>());
  const elements = useRef(new Map<number, HTMLElement>());
  const [version, setVersion] = useState(0);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 60) });

  // offsets[i] = top of row i, relative to the first row.
  const offsets = useMemo(() => {
    const out = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) out[i + 1] = out[i]! + (heights.current.get(keys[i]!) ?? estimate);
    return out;
    // `version` changes when a measured height changed.
  }, [keys, count, estimate, version]);

  const indexAt = useCallback(
    (y: number) => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid + 1]! <= y) lo = mid + 1;
        else hi = mid;
      }
      return Math.min(lo, Math.max(0, count - 1));
    },
    [offsets, count],
  );

  const update = useCallback(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;
    const rect = el.getBoundingClientRect();
    const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
    // The visible part of the list, in its own content coordinates.
    const top = Math.max(rect.top, 0) - rect.top + el.scrollTop - padTop;
    const bottom = Math.min(rect.bottom, window.innerHeight) - rect.top + el.scrollTop - padTop;
    const start = Math.max(0, indexAt(Math.max(0, top)) - OVERSCAN);
    const end = Math.min(count, indexAt(Math.max(0, bottom)) + 1 + OVERSCAN);
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [containerRef, enabled, indexAt, count]);

  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    update();
    el?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el?.removeEventListener('scroll', update);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled, containerRef, update]);

  // Measure what rendered; a changed height re-lays the list out.
  useLayoutEffect(() => {
    if (!enabled) return;
    let changed = false;
    for (const [i, el] of elements.current) {
      const key = keys[i];
      if (key === undefined || !el.isConnected) continue;
      const h = el.offsetHeight;
      if (h > 0 && heights.current.get(key) !== h) {
        heights.current.set(key, h);
        changed = true;
      }
    }
    if (changed) setVersion((v) => v + 1);
  });

  const measure = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (el) elements.current.set(index, el);
      else elements.current.delete(index);
    },
    [],
  );

  const scrollToIndex = useCallback(
    (index: number, align: 'nearest' | 'center' = 'nearest') => {
      const container = containerRef.current;
      if (!container || index < 0 || index >= count) return;
      const el = elements.current.get(index);
      if (el?.isConnected) {
        scrollWithin(container, el, align);
        return;
      }
      if (!enabled) return;
      const padTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
      const rowTop = padTop + offsets[index]!;
      const rowH = offsets[index + 1]! - offsets[index]!;
      const scrolls = container.scrollHeight > container.clientHeight + 1;
      const viewH = scrolls ? container.clientHeight : window.innerHeight;
      const target = align === 'center' ? rowTop - (viewH - rowH) / 2 : rowTop;
      if (scrolls) container.scrollTop = Math.max(0, target);
      else window.scrollTo({ top: window.scrollY + container.getBoundingClientRect().top + Math.max(0, target) });
      update();
    },
    [containerRef, count, enabled, offsets, update],
  );

  const focusIndex = useCallback(
    (index: number, selector: string) => {
      const find = () => elements.current.get(index)?.querySelector<HTMLElement>(selector) ?? null;
      const now = find();
      if (now) {
        now.focus();
        scrollToIndex(index);
        return;
      }
      scrollToIndex(index);
      requestAnimationFrame(() => find()?.focus());
    },
    [scrollToIndex],
  );

  if (!enabled) return { start: 0, end: count, padTop: 0, padBottom: 0, measure, scrollToIndex, focusIndex };
  const start = Math.min(range.start, count);
  const end = Math.min(Math.max(range.end, start), count);
  return {
    start,
    end,
    padTop: offsets[start]!,
    padBottom: offsets[count]! - offsets[end]!,
    measure,
    scrollToIndex,
    focusIndex,
  };
}

/**
 * Arrow keys, Home and End move between rows. The list is one Tab stop (a
 * roving tabindex): Tab moves on to the next part of the page.
 */
export function useRovingRow(fallback: number): { tabStop: number; onFocusRow: (index: number) => void; onBlurList: (e: React.FocusEvent<HTMLElement>) => void } {
  const [focused, setFocused] = useState<number | null>(null);
  return {
    tabStop: focused ?? fallback,
    onFocusRow: setFocused,
    // Leaving the list: the tab stop goes back to the selection (or the playhead).
    onBlurList: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
    },
  };
}

export function listKeyHandler(count: number, v: Pick<VirtualRows, 'focusIndex'>) {
  return (e: KeyboardEvent<HTMLOListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const item = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-index]');
    if (!item || !e.currentTarget.contains(item)) return;
    e.preventDefault();
    const i = Number(item.dataset.index);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
    v.focusIndex(Math.max(0, Math.min(count - 1, next)), 'button[data-row]');
  };
}
