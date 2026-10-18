'use client';
/**
 * "2D map view instead of 3D" (Esc menu → Display): per viewer, in this
 * browser only. The 2D map is also what draws the town without WebGL.
 */
import { useSyncExternalStore } from 'react';
import { safeStorage } from '../../../state/prefs';

export type TownView = '3d' | 'map';
export const VIEW_KEY = 'runloop.world.view.v1';

const listeners = new Set<() => void>();
let cached: TownView | null = null;

export function readTownView(): TownView {
  if (cached === null) cached = safeStorage.getItem(VIEW_KEY) === 'map' ? 'map' : '3d';
  return cached;
}

export function setTownView(v: TownView): void {
  cached = v;
  safeStorage.setItem(VIEW_KEY, v);
  for (const fn of listeners) fn();
}

export function useTownView(): TownView {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readTownView,
    () => '3d',
  );
}
