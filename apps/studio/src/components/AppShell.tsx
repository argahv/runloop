'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { connectRun } from '../state/connect';
import { connectionState, connectionView } from '../state/connection';
import { StudioProvider, useStudio } from '../state/context';
import { AREA_LABEL, areaOf, isRunPage, runNumber } from '../state/format';
import { useDeepLinkOnce, useKeyboardShortcuts, useOnboardingTracker, usePlaybackDriver, usePrefs, useRuntimePolling, useUrlSync } from '../state/hooks';
import { createStudioStore, type StudioStore } from '../state/store';
import { Breadcrumbs, type Crumb } from '../ui/Breadcrumbs';
import { Button } from '../ui/Button';
import { CommandPalette } from '../ui/CommandPalette';
import { ConnectionStatus } from '../ui/ConnectionStatus';
import { Dialog } from '../ui/Dialog';
import { Kbd, modKey } from '../ui/Kbd';
import { ToastRegion } from '../ui/Toast';
import { MOBILE_QUERY, NARROW_QUERY, useMediaQuery } from '../ui/useMediaQuery';
import styles from './AppShell.module.css';
import ArtifactViewer from './ArtifactViewer';
import StudioSidebar from './StudioSidebar';
import { useStudioCommands } from './useStudioCommands';

/**
 * Root client component: one studio store for the whole app (so a live run
 * keeps streaming across pages), the runtime connection, and the chrome.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStudioStore());
  return (
    <StudioProvider store={store}>
      <Shell store={store}>{children}</Shell>
    </StudioProvider>
  );
}

function Shell({ store, children }: { store: StudioStore; children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const runId = useStudio((s) => s.runId);
  const connectNonce = useStudio((s) => s.connectNonce);
  const apiKey = useStudio((s) => s.apiBaseOverride) ?? '';
  const retry = useReconnectNonce(store);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Order matters: preferences (runtime URL) before the deep link and polling.
  usePrefs(store);
  useDeepLinkOnce(store);
  useRuntimePolling(store, apiKey);
  usePlaybackDriver(store);
  useKeyboardShortcuts(store);
  useUrlSync(store, pathname);
  useOnboardingTracker(store, pathname);
  useEffect(() => (runId ? connectRun(store, runId) : undefined), [store, runId, retry, connectNonce]);
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) {
        const search = document.getElementById('trace-search');
        if (search) {
          e.preventDefault();
          search.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useStudioCommands(pathname);

  return (
    <div className={styles.shell} data-rail={(narrow && !mobile) || undefined} data-mobile={mobile || undefined}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      {!mobile && (
        <aside className={styles.sidebar} aria-label="Sidebar">
          <StudioSidebar pathname={pathname} rail={narrow} />
        </aside>
      )}
      <div className={styles.main}>
        <TopBar pathname={pathname} mobile={mobile} onOpenPalette={() => setPaletteOpen(true)} onOpenMenu={() => setDrawerOpen(true)} />
        <main id="main" className={styles.content} tabIndex={-1}>
          {children}
        </main>
      </div>
      {mobile && (
        <Dialog open={drawerOpen} onClose={() => setDrawerOpen(false)} labelledBy="drawer-title" placement="left" className={styles.drawer}>
          <h2 id="drawer-title" className="sr-only">
            Navigation
          </h2>
          <StudioSidebar pathname={pathname} rail={false} onNavigate={() => setDrawerOpen(false)} />
        </Dialog>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ArtifactViewer />
      <ToastRegion />
    </div>
  );
}

function TopBar({ pathname, mobile, onOpenPalette, onOpenMenu }: { pathname: string; mobile: boolean; onOpenPalette: () => void; onOpenMenu: () => void }) {
  const area = areaOf(pathname);
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const run = useStudio((s) => s.run);
  const conn = connectionView(useStudio((s) => connectionState(s)));
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);

  const crumbs: Crumb[] = [{ label: AREA_LABEL[area] ?? 'Studio', href: area }];
  // Phones show the area only; the run title is in the page header.
  if (!mobile && isRunPage(pathname) && runId) {
    const n = runNumber(runs, runId);
    crumbs.push({ label: `${n !== null ? `Run #${n}` : 'Run'}${run ? ` · ${run.title}` : ''}` });
  }

  return (
    <header className={styles.topbar}>
      {mobile && <Button variant="ghost" iconOnly icon="menu" aria-label="Open navigation" onClick={onOpenMenu} />}
      <Breadcrumbs items={crumbs} />
      <div className={styles.topActions}>
        <ConnectionStatus view={conn} />
        <button type="button" className={styles.search} onClick={onOpenPalette} aria-label="Search and commands" aria-keyshortcuts="Control+K Meta+K">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M20 20l-4.2-4.2" />
          </svg>
          {!mobile && <span className={styles.searchText}>Jump to…</span>}
          {!mobile && <Kbd keys={[mod, 'K']} />}
        </button>
      </div>
    </header>
  );
}

/** Bumps when the runtime comes back online after the open run failed to load or stream. */
function useReconnectNonce(store: StudioStore): number {
  const [nonce, setNonce] = useState(0);
  const prev = useRef(store.getState().runtime.status);
  useEffect(
    () =>
      store.subscribe((s) => {
        const was = prev.current;
        prev.current = s.runtime.status;
        if (was === 'offline' && s.runtime.status === 'online' && s.runId && (s.loadError || s.conn === 'error')) {
          setNonce((n) => n + 1);
        }
      }),
    [store],
  );
  return nonce;
}

