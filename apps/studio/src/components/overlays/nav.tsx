'use client';
/**
 * Where run links go (immersive contract §4.1, §5.4). On `/` they open inside
 * the world (the trace sheet, the compare sheet, an agent's building), so the
 * town stays visible and live; on every other page they navigate exactly as
 * they always did. Components call `useStudioNav()` and never decide this
 * themselves.
 */
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { compareHref } from '../../state/baselines';
import { useStudioStore } from '../../state/context';
import { linkTo, ROUTES } from '../../state/deeplink';
import { selectRun } from '../../state/hooks';
import { ButtonLink, type ButtonLinkProps } from '../../ui/Button';
import { useWorldStore } from '../../world/context';
import { compareRequests, focusRun, worldNav, type StudioNav } from './worldNav';

export { compareRequests, ownerBuilding, traceSheetView, worldNav, type StudioNav } from './worldNav';

const NavContext = createContext<StudioNav | null>(null);

export function StudioNavProvider({ nav, children }: { nav: StudioNav; children: ReactNode }) {
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

const isTown = (pathname: string) => (pathname.replace(/\/+$/, '') || '/') === '/';

/** Today's behaviour: every link navigates to its page. */
export function useRouterNav(): StudioNav {
  const router = useRouter();
  const studio = useStudioStore();
  return useMemo<StudioNav>(
    () => ({
      inWorld: false,
      openTrace: (runId, at) => {
        focusRun(studio, runId, at);
        router.push(linkTo(ROUTES.traces, { runId, seq: at?.seq ?? null, agentId: at?.agentId ?? null }));
      },
      openCompare: (pair) => {
        compareRequests.setState({ pair });
        router.push(compareHref(pair));
      },
      openRunWorld: (runId) => {
        selectRun(studio, runId);
        router.push(linkTo(ROUTES.world, { runId }));
      },
      openPage: (href) => router.push(href),
    }),
    [router, studio],
  );
}

/** On `/`: sheets, building interiors and the camera; the world never goes away. */
export function useWorldNav(): StudioNav {
  const router = useRouter();
  const studio = useStudioStore();
  const world = useWorldStore();
  return useMemo(() => worldNav(world, studio, (href) => router.push(href)), [world, studio, router]);
}

/** The navigation for here: a provider's (an overlay host), else in-world on `/`, else the pages. */
export function useStudioNav(): StudioNav {
  const provided = useContext(NavContext);
  const pages = useRouterNav();
  const world = useWorldNav();
  const pathname = usePathname() ?? '/';
  return provided ?? (isTown(pathname) ? world : pages);
}

/** True when this renders inside the world: under an overlay host, or on `/` (a page shown in one of the town's sheets). */
export function useInWorld(): boolean {
  const provided = useContext(NavContext);
  const pathname = usePathname() ?? '/';
  return provided ? provided.inWorld === true : isTown(pathname);
}

/** A plain left click (modified clicks keep the link's default: a new tab or window). */
export const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

/**
 * A link styled as a button to a Studio page. In the world it opens that
 * page's sheet (or the Esc menu) instead of leaving; elsewhere it is the
 * same link as before.
 */
export function NavButtonLink({ href, onClick, ...rest }: ButtonLinkProps) {
  const nav = useStudioNav();
  return (
    <ButtonLink
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !nav.inWorld || !plainClick(e)) return;
        e.preventDefault();
        nav.openPage(href);
      }}
    />
  );
}
