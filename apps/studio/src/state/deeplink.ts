/** Studio areas (static-export routes). Only areas that work appear here. */
export const ROUTES = {
  overview: '/overview',
  world: '/world',
  traces: '/traces',
  experiments: '/experiments',
  integrations: '/integrations',
  settings: '/settings',
} as const;
export type Route = (typeof ROUTES)[keyof typeof ROUTES];

export type DeepLinkView = 'world' | 'graph' | 'trace';

/**
 * `?run=<id>&view=world|graph|trace&event=<seq>&agent=<id>&at=<seq>`
 * (design-system.md, Navigation rules). `event` is the event the inspector
 * shows, `agent` the agent card it shows (when no event is named), and `at`
 * a paused playhead. Without `at` a live run stays live.
 */
export interface DeepLink {
  runId: string | null;
  view: DeepLinkView | null;
  seq: number | null;
  agentId: string | null;
  at: number | null;
}

/** Query parameters the selection owns (the URL sync replaces exactly these). */
export const SELECTION_PARAMS = ['run', 'view', 'event', 'agent', 'at'] as const;

const seqParam = (params: URLSearchParams, key: string, min: number): number | null => {
  const n = Number(params.get(key));
  return params.has(key) && Number.isInteger(n) && n >= min ? n : null;
};

export function parseDeepLink(params: URLSearchParams): DeepLink {
  const view = params.get('view');
  return {
    runId: params.get('run') || null,
    view: view === 'world' || view === 'graph' || view === 'trace' ? view : null,
    seq: seqParam(params, 'event', 1),
    agentId: params.get('agent') || null,
    at: seqParam(params, 'at', 0),
  };
}

/** Where a link to the root lands: traces for view=trace, the world when a run is named, else the overview. */
export function routeForDeepLink(link: DeepLink): Route {
  if (link.view === 'trace') return ROUTES.traces;
  if (link.view === 'world' || link.view === 'graph' || link.runId) return ROUTES.world;
  return ROUTES.overview;
}

/** Write the selection into `params`; `view` is only written when it is not the page's default. */
export function writeDeepLink(params: URLSearchParams, link: DeepLink): void {
  for (const key of SELECTION_PARAMS) params.delete(key);
  if (link.runId) params.set('run', link.runId);
  if (link.view) params.set('view', link.view);
  if (link.seq !== null) params.set('event', String(link.seq));
  if (link.agentId) params.set('agent', link.agentId);
  if (link.at !== null && link.at !== undefined) params.set('at', String(link.at));
}

/**
 * What a link to the current view names: the event when the inspector shows
 * an event, the agent when it shows an agent card (never a derived event), and
 * the playhead when it is paused in a replay.
 */
export function linkFromView(s: {
  inspectorTab: 'event' | 'agent' | 'run';
  selectedSeq: number | null;
  selectedAgentId: string | null;
  cursor: { mode: 'live' } | { mode: 'replay'; playing: boolean };
  playheadSeq: number;
}): Pick<DeepLink, 'seq' | 'agentId' | 'at'> {
  const seq = s.inspectorTab === 'event' ? s.selectedSeq : null;
  const agentId = s.inspectorTab === 'agent' ? s.selectedAgentId : null;
  const paused = s.cursor.mode === 'replay' && !s.cursor.playing;
  // A paused playhead on the named event needs no `at`.
  const at = paused && s.playheadSeq !== seq ? s.playheadSeq : null;
  return { seq, agentId, at };
}

/** A shareable URL for one event (or agent) of a run on a given page. */
export function linkTo(route: Route, link: Partial<DeepLink> & { runId: string }): string {
  const params = new URLSearchParams();
  writeDeepLink(params, { view: null, seq: null, agentId: null, at: null, ...link });
  return `${route}?${params.toString()}`;
}
