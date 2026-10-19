'use client';
import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { tickNow } from './interpolate';
import type { WorldStore, WorldUiState } from './store';

const WorldContext = createContext<WorldStore | null>(null);

export function WorldProvider({ store, children }: { store: WorldStore; children: ReactNode }) {
  return <WorldContext.Provider value={store}>{children}</WorldContext.Provider>;
}

export function useWorldStore(): WorldStore {
  const store = useContext(WorldContext);
  if (!store) throw new Error('useWorldStore must be used inside <WorldProvider>');
  return store;
}

/** Subscribe to one slice of the world state. Read `rev` too when you need the folded snapshot's contents. */
export function useWorld<T>(selector: (s: WorldUiState) => T): T {
  return useStore(useWorldStore(), selector);
}

/** The interpolated sim tick, re-rendered `hz` times a second while the world runs. */
export function useWorldTick(hz = 4): number {
  const clock = useWorld((s) => s.clock);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const running = (clock?.speed ?? 0) > 0;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(bump, 1000 / hz);
    return () => clearInterval(id);
  }, [running, hz]);
  return tickNow(clock, Date.now());
}
