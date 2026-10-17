'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StudioState, StudioStore } from './store';

const StoreContext = createContext<StudioStore | null>(null);

export function StudioProvider({ store, children }: { store: StudioStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStudioStore(): StudioStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStudioStore must be used inside <StudioProvider>');
  return store;
}

/** Subscribe to one slice of the studio state (re-renders only when it changes). */
export function useStudio<T>(selector: (s: StudioState) => T): T {
  return useStore(useStudioStore(), selector);
}
