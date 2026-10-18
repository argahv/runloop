/**
 * World deep links (plan §5): `/?mode=explore|agents|intelligence|lab&focus=kind:id&cam=x,z,zoom`.
 * Static export, so everything is a query parameter on `/`. Legacy links
 * (`/?run=…&view=…`) still land where they did before (legacyRedirect).
 */
import { formatEntityRef, parseEntityRef, type EntityRef } from '@runloop-world/events';
import { parseDeepLink, routeForDeepLink, ROUTES, SELECTION_PARAMS } from '../state/deeplink';

/** World modes that work today. Build and Society arrive with W3/W4 and stay hidden until then. */
export const MODES = ['explore', 'agents', 'intelligence', 'lab'] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABEL: Record<Mode, string> = {
  explore: 'Explore',
  agents: 'Agents',
  intelligence: 'Intelligence',
  lab: 'Lab',
};

export interface WorldCam {
  x: number;
  z: number;
  zoom: number;
}

export interface WorldLink {
  mode: Mode;
  focus: EntityRef | null;
  cam: WorldCam | null;
}

/** Query parameters the world link owns (writeWorldLink replaces exactly these). */
export const WORLD_PARAMS = ['mode', 'focus', 'cam'] as const;

const isMode = (v: string | null): v is Mode => v !== null && (MODES as readonly string[]).includes(v);

function parseCam(v: string | null): WorldCam | null {
  if (!v) return null;
  const parts = v.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, z, zoom] = parts as [number, number, number];
  return zoom > 0 ? { x, z, zoom } : null;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function parseWorldLink(p: URLSearchParams): WorldLink {
  const mode = p.get('mode');
  const focus = p.get('focus');
  return {
    mode: isMode(mode) ? mode : 'explore',
    focus: focus ? parseEntityRef(focus) : null,
    cam: parseCam(p.get('cam')),
  };
}

/** Write the link into `p`, keeping unrelated parameters. Explore (the default) is not written. */
export function writeWorldLink(p: URLSearchParams, link: WorldLink): void {
  for (const k of WORLD_PARAMS) p.delete(k);
  if (link.mode !== 'explore') p.set('mode', link.mode);
  if (link.focus) p.set('focus', formatEntityRef(link.focus));
  if (link.cam) p.set('cam', `${round(link.cam.x)},${round(link.cam.z)},${round(link.cam.zoom)}`);
}

/** A `/` URL for a world link. */
export function worldHref(link: Partial<WorldLink>): string {
  const p = new URLSearchParams();
  writeWorldLink(p, { mode: link.mode ?? 'explore', focus: link.focus ?? null, cam: link.cam ?? null });
  const q = p.toString();
  return q ? `/?${q}` : '/';
}

/** The mode a route belongs to (replaces `areaOf` for the world chrome). Null = no mode (Settings). */
export function modeOfRoute(pathname: string, p?: URLSearchParams): Mode | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return parseWorldLink(p ?? new URLSearchParams()).mode;
  if (path === ROUTES.experiments || path.startsWith(`${ROUTES.experiments}/`)) return 'lab';
  if (path === ROUTES.traces || path.startsWith(`${ROUTES.traces}/`)) return 'intelligence';
  if (path === ROUTES.world || path === ROUTES.overview || path === ROUTES.integrations) return 'agents';
  return null;
}

/**
 * Where an old link to `/` must go instead of the town. Before the world,
 * `/` redirected run deep links (`?run=&view=&event=&agent=&at=`) to their
 * page; they still do, with every parameter kept. Null = stay on the town.
 */
export function legacyRedirect(pathname: string, p: URLSearchParams): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path !== '/') return null;
  if (!SELECTION_PARAMS.some((k) => p.has(k))) return null;
  const q = p.toString();
  return `${routeForDeepLink(parseDeepLink(p))}${q ? `?${q}` : ''}`;
}

/** The mode a key press selects (1–4), or null. */
export function modeForKey(key: string): Mode | null {
  const i = Number(key) - 1;
  return Number.isInteger(i) && i >= 0 && i < MODES.length ? MODES[i]! : null;
}
