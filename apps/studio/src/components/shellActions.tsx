'use client';
import { createContext, useContext } from 'react';

/** What the shell offers pages that draw their own chrome (the town): the ⌘K palette and the phone menu. */
export interface ShellActions {
  openPalette: () => void;
  openMenu: () => void;
}

export const ShellActionsContext = createContext<ShellActions>({ openPalette: () => undefined, openMenu: () => undefined });

export const useShellActions = () => useContext(ShellActionsContext);
