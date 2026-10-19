'use client';
/**
 * What the HUD shares: the renderer's TownApi (anchored cards, the minimap;
 * null without the 3D town) and the viewport layout (contract §1.2).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { TownApi } from '../../../town/types';
import { hudLayout, type HudLayout } from './layout';

const TownApiContext = createContext<TownApi | null>(null);

export function TownApiProvider({ api, children }: { api: TownApi | null; children: ReactNode }) {
  return <TownApiContext.Provider value={api}>{children}</TownApiContext.Provider>;
}

/** The 3D town's API, or null (loading, the 2D map, no WebGL). */
export const useTownApi = () => useContext(TownApiContext);

/** The viewport size, updated on resize (1440×900 before mount). */
export function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState({ w: 1440, h: 900 });
  useEffect(() => {
    const read = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return vp;
}

export function useHudLayout(): HudLayout & { vw: number; vh: number } {
  const { w, h } = useViewport();
  return { ...hudLayout(w), vw: w, vh: h };
}
