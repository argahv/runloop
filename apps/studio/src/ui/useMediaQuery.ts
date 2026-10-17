'use client';
import { useSyncExternalStore } from 'react';

/** Matches a media query on the client; `fallback` during prerender and hydration. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

/** Below this width the Studio shows traces, summaries and inspectors, never a desktop-sized 3D scene. */
export const MOBILE_QUERY = '(max-width: 760px)';
export const NARROW_QUERY = '(max-width: 1100px)';
