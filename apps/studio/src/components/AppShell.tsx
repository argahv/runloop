'use client';
import Link from 'next/link';
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
import { Icon } from '../ui/Icon';
import { Kbd, modKey } from '../ui/Kbd';
import { ToastRegion } from '../ui/Toast';
import { MOBILE_QUERY, NARROW_QUERY, useMediaQuery } from '../ui/useMediaQuery';
import { connectWorld } from '../world/connect';
import { useWorld, useWorldStore, WorldProvider } from '../world/context';
import { worldHref } from '../world/link';
import { agentOfRun } from '../world/selectors';
import { createWorldStore, type WorldStore } from '../world/store';
import AddToWorldDialog from './agents/AddToWorldDialog';
import styles from './AppShell.module.css';
import ArtifactViewer from './ArtifactViewer';
import StudioSidebar from './StudioSidebar';
import { useStudioCommands } from './useStudioCommands';
import ModeRail from './world/ModeRail';
import { ShellActionsContext } from './shellActions';
import { useWorldCommands } from './world/useWorldCommands';

/**
 * Root client component: one studio store (sessions and replay; a live run
 * keeps streaming across pages), one world store (the town, connected for
 * the whole app), the runtime connections, and the chrome.
 *
 * Three layouts: the town at `/` (the world edge to edge with its game HUD:
 * no sidebar, no top bar), run pages (/world, /traces: the run sidebar,
 * unchanged), and other pages (ModeRail + the page under a top bar).
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStudioStore());
  const [world] = useState(() => createWorldStore());
  return (
    <StudioProvider store={store}>
      <WorldProvider store={world}>
        <Shell store={store} world={world}>
          {children}
        </Shell>
      </WorldProvider>
    </StudioProvider>
  );
}

type Layout = 'town' | 'run' | 'page';

function Shell({ store, world, children }: { store: StudioStore; world: WorldStore; children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const path = pathname.replace(/\/+$/, '') || '/';
  const layout: Layout = path === '/' ? 'town' : isRunPage(pathname) ? 'run' : 'page';
  const runId = useStudio((s) => s.runId);
  const connectNonce = useStudio((s) => s.connectNonce);
  const apiKey = useStudio((s) => s.apiBaseOverride) ?? '';
  const reducedMotion = useStudio((s) => s.reducedMotion);
  const retry = useReconnectNonce(store);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const traceSheet = useWorld((s) => s.overlay === 'trace');

  // Order matters: preferences (runtime URL) before the deep link and polling.
  usePrefs(store);
  useDeepLinkOnce(store);
  useRuntimePolling(store, apiKey);
  usePlaybackDriver(store);
  // The town has its own keys; the trace sheet over it uses the run shortcuts (play, step, live).
  useKeyboardShortcuts(store, layout !== 'town' || traceSheet);
  useUrlSync(store, pathname);
  useOnboardingTracker(store, pathname);
  useEffect(() => (runId ? connectRun(store, runId) : undefined), [store, runId, retry, connectNonce]);
  // The town stays connected on every page (the ticker, ⌘K and Back to town are instant).
  useEffect(() => connectWorld(world), [world, apiKey]);
  useEffect(() => world.getState().setReducedMotion(reducedMotion), [world, reducedMotion]);
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

  const commands = [...useWorldCommands(pathname), ...useStudioCommands(pathname)];
  const [actions] = useState(() => ({ openPalette: () => setPaletteOpen(true), openMenu: () => setDrawerOpen(true) }));

  return (
    <div className={styles.shell} data-layout={layout} data-rail={(narrow && !mobile && layout === 'run') || undefined} data-mobile={mobile || undefined}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      {!mobile && layout !== 'town' && (
        <aside className={styles.sidebar} aria-label="Sidebar">
          {layout === 'run' ? <StudioSidebar pathname={pathname} rail={narrow} /> : <ModeRail pathname={pathname} />}
        </aside>
      )}
      <div className={styles.main}>
        {layout === 'town' ? (
          <main id="main" className={styles.townMain} tabIndex={-1}>
            <ShellActionsContext.Provider value={actions}>{children}</ShellActionsContext.Provider>
          </main>
        ) : (
          <>
            <TopBar pathname={pathname} mobile={mobile} onOpenPalette={actions.openPalette} onOpenMenu={actions.openMenu} />
            <main id="main" className={styles.content} tabIndex={-1}>
              {children}
            </main>
          </>
        )}
      </div>
      {mobile && layout !== 'town' && (
        <Dialog open={drawerOpen} onClose={() => setDrawerOpen(false)} labelledBy="drawer-title" placement="left" className={styles.drawer}>
          <h2 id="drawer-title" className="sr-only">
            Navigation
          </h2>
          {layout === 'run' ? (
            <StudioSidebar pathname={pathname} rail={false} onNavigate={() => setDrawerOpen(false)} />
          ) : (
            <ModeRail pathname={pathname} expanded onNavigate={() => setDrawerOpen(false)} />
          )}
        </Dialog>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <WorldDialogs />
      <ArtifactViewer />
      <ToastRegion />
    </div>
  );
}

/**
 * Add to World as a dialog (with its lot list): from another page, or on the
 * town without the 3D view (no WebGL, the 2D map). In 3D it is lot picking.
 */
function WorldDialogs() {
  const world = useWorldStore();
  const add = useWorld((s) => s.addToWorld);
  return <AddToWorldDialog open={add !== null} fromSessionId={add?.fromSessionId ?? null} onClose={() => world.getState().closeAddToWorld()} />;
}

function TopBar({ pathname, mobile, onOpenPalette, onOpenMenu }: { pathname: string; mobile: boolean; onOpenPalette: () => void; onOpenMenu: () => void }) {
  const area = areaOf(pathname);
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const run = useStudio((s) => s.run);
  const conn = connectionView(useStudio((s) => connectionState(s)));
  const agents = useWorld((s) => s.agents);
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);

  const runPage = isRunPage(pathname);
  const owner = runPage ? agentOfRun(agents, runId) : null;
  const crumbs: Crumb[] = [];
  if (owner && !mobile) {
    // A run of a real agent: it happened in that agent's building (plan §5).
    crumbs.push(
      { label: 'Agent District', href: worldHref({ mode: 'agents' }) },
      { label: owner.agent.displayName, href: worldHref({ mode: 'agents', focus: { kind: 'agent', id: owner.agent.agentId } }) },
      { label: `Session #${owner.session}${run ? ` · ${run.title}` : ''}` },
    );
  } else {
    crumbs.push({ label: AREA_LABEL[area] ?? 'Studio', href: area });
    // Phones show the area only; the run title is in the page header.
    if (!mobile && runPage && runId) {
      const n = runNumber(runs, runId);
      crumbs.push({ label: `${n !== null ? `Run #${n}` : 'Run'}${run ? ` · ${run.title}` : ''}` });
    }
  }

  return (
    <header className={styles.topbar}>
      {mobile && <Button variant="ghost" iconOnly icon="menu" aria-label="Open navigation" onClick={onOpenMenu} />}
      <Breadcrumbs items={crumbs} />
      <div className={styles.topActions}>
        {runPage && (
          <Link href={owner ? worldHref({ mode: 'agents', focus: { kind: 'agent', id: owner.agent.agentId } }) : '/'} className={styles.backToTown}>
            <Icon name="map" size={14} />
            {!mobile && 'Back to town'}
            {mobile && <span className="sr-only">Back to town</span>}
          </Link>
        )}
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
