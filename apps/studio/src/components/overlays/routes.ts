/**
 * Legacy pages and their places in the world (immersive contract §4.1–4.2).
 *
 * Every full page keeps working at its route. These pure helpers say where
 * the same thing opens on `/` (the "Open in the world" path from a page, and
 * where an in-world link goes instead of navigating), and back again (a
 * sheet's "Full page" link). Nothing here touches the DOM.
 */
import { compareHref, parseComparePair, type ComparePair } from '../../state/baselines';
import { linkTo, parseDeepLink, ROUTES, writeDeepLink, type DeepLink } from '../../state/deeplink';
import { FILTER_PARAMS } from '../../state/filters';
import type { Tab } from '../../state/store';
import type { SheetId } from './sheets';

/** The trace sheet's tabs: the run's world, then the Traces tabs. */
export type TraceSheetTab = 'world' | Tab;
const TRACE_SHEET_TABS: readonly TraceSheetTab[] = ['world', 'timeline', 'logs', 'metrics', 'state', 'metadata'];

/** `tab=` on `/` while the trace sheet is open (only `world` is written: the other tabs live in the Studio store). */
export const SHEET_TAB_PARAM = 'tab';

export function parseSheetTab(params: URLSearchParams): TraceSheetTab | null {
  const v = params.get(SHEET_TAB_PARAM);
  return v !== null && (TRACE_SHEET_TABS as readonly string[]).includes(v) ? (v as TraceSheetTab) : null;
}

/** What a Studio URL is in the world: a sheet (with its parameters), the Esc menu, the town itself, or nothing (not a Studio page). */
export type InWorldTarget =
  | { kind: 'trace'; link: DeepLink; tab: TraceSheetTab | null; filter: URLSearchParams }
  | { kind: 'compare'; pair: ComparePair }
  | { kind: 'sheet'; sheet: Extract<SheetId, 'sessions' | 'connect'> }
  | { kind: 'menu' }
  | { kind: 'town'; search: string };

const norm = (path: string) => path.replace(/\/+$/, '') || '/';

/** Parse a same-origin Studio href (`/traces?run=…`, `/overview/`, …). Null for other origins and unknown paths. */
export function inWorldTarget(href: string): InWorldTarget | null {
  let url: URL;
  try {
    url = new URL(href, 'http://studio.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://studio.invalid') return null;
  const path = norm(url.pathname);
  const p = url.searchParams;
  const filter = new URLSearchParams();
  for (const k of FILTER_PARAMS) for (const v of p.getAll(k)) filter.append(k, v);
  switch (path) {
    case ROUTES.traces:
      return { kind: 'trace', link: parseDeepLink(p), tab: null, filter };
    case ROUTES.world: {
      const link = parseDeepLink(p);
      // The Live World is the trace sheet's World tab (its 3D world or, with view=graph, the Network view).
      return { kind: 'trace', link, tab: 'world', filter };
    }
    case ROUTES.experiments:
      return { kind: 'compare', pair: parseComparePair(p) };
    case ROUTES.overview:
      return { kind: 'sheet', sheet: 'sessions' };
    case ROUTES.integrations:
      return { kind: 'sheet', sheet: 'connect' };
    case ROUTES.settings:
      return { kind: 'menu' };
    case '/':
      return { kind: 'town', search: url.search };
    default:
      return null;
  }
}

/** The `/` URL that shows a target (Settings live in the Esc menu, which has no URL: the town). */
export function hrefForTarget(t: InWorldTarget | null): string {
  if (!t || t.kind === 'menu') return '/';
  if (t.kind === 'town') return `/${t.search}`;
  const p = new URLSearchParams();
  if (t.kind === 'sheet') p.set('overlay', t.sheet);
  else if (t.kind === 'compare') {
    p.set('overlay', 'compare');
    if (t.pair.a) p.set('a', t.pair.a);
    if (t.pair.b) p.set('b', t.pair.b);
  } else {
    p.set('overlay', 'trace');
    if (t.tab === 'world') p.set(SHEET_TAB_PARAM, 'world');
    // `view` only matters for the Network view; the sheet decides everything else.
    writeDeepLink(p, { ...t.link, view: t.link.view === 'graph' ? 'graph' : null });
    for (const [k, v] of t.filter) p.append(k, v);
  }
  return `/?${p.toString()}`;
}

/** Where a legacy page's current URL opens in the world ("Open in the world"). */
export const inWorldHref = (href: string): string => hrefForTarget(inWorldTarget(href));

/** True when a page has its own sheet in the world (Settings and unknown pages go to the town). */
export const hasInWorldSheet = (href: string): boolean => {
  const k = inWorldTarget(href)?.kind;
  return k === 'trace' || k === 'compare' || k === 'sheet';
};

/** A sheet's "Full page" link: the legacy page showing the same thing. Null: the sheet has no page (the World Log lives on `/`). */
export function fullPageHref(
  sheet: SheetId,
  s: { runId?: string | null; seq?: number | null; agentId?: string | null; at?: number | null; worldTab?: boolean; pair?: ComparePair | null },
): string | null {
  switch (sheet) {
    case 'trace': {
      const route = s.worldTab ? ROUTES.world : ROUTES.traces;
      if (!s.runId) return route;
      return linkTo(route, { runId: s.runId, seq: s.seq ?? null, agentId: s.agentId ?? null, at: s.at ?? null });
    }
    case 'compare':
      return compareHref(s.pair ?? { a: null, b: null });
    case 'sessions':
      return ROUTES.overview;
    case 'connect':
      return ROUTES.integrations;
    case 'log':
      return null;
  }
}
