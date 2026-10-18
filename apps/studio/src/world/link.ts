/**
 * World deep links (plan §5): `/?mode=explore|agents|intelligence|lab&focus=kind:id&cam=x,z,zoom[,az[,tilt]]`
 * and `overlay=` for the sheet open over the town (immersive contract §4.2).
 * Static export, so everything is a query parameter on `/`. Legacy links
 * (`/?run=…&view=…`) still land where they did before (legacyRedirect),
 * unless they name an `overlay`: then the town opens with that sheet.
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

/** The camera: target (cells), px per cell, and optionally the azimuth and tilt in degrees. */
export interface WorldCam {
  x: number;
  z: number;
  zoom: number;
  az?: number;
  tilt?: number;
}

/** The default view: from the south-east, 37° down (the town's isometric look). */
export const DEFAULT_AZ = 45;
export const DEFAULT_TILT = 37;

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
  if (parts.length < 3 || parts.length > 5 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, z, zoom, az, tilt] = parts as [number, number, number, number?, number?];
  if (zoom <= 0) return null;
  const cam: WorldCam = { x, z, zoom };
  if (az !== undefined) cam.az = az;
  if (tilt !== undefined) cam.tilt = tilt;
  return cam;
}

const round = (n: number) => Math.round(n * 100) / 100;
const differs = (v: number | undefined, def: number) => v !== undefined && Math.abs(v - def) > 0.5;

/** `x,z,zoom`, plus `,az,tilt` only when the view is turned or tilted away from the default. */
export function formatCam(cam: WorldCam): string {
  const base = `${round(cam.x)},${round(cam.z)},${round(cam.zoom)}`;
  if (!differs(cam.az, DEFAULT_AZ) && !differs(cam.tilt, DEFAULT_TILT)) return base;
  return `${base},${round(cam.az ?? DEFAULT_AZ)},${round(cam.tilt ?? DEFAULT_TILT)}`;
}

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
  if (link.cam) p.set('cam', formatCam(link.cam));
}

/** Sheets and views that open over the town (`overlay=`). `add` is Add to World's lot picking. */
export const OVERLAYS = ['map', 'list', 'log', 'trace', 'compare', 'sessions', 'connect', 'add'] as const;
export type OverlayParam = (typeof OVERLAYS)[number];

export function parseOverlay(p: URLSearchParams): OverlayParam | null {
  const v = p.get('overlay');
  return v !== null && (OVERLAYS as readonly string[]).includes(v) ? (v as OverlayParam) : null;
}

/** Write (or remove) `overlay=`, keeping every other parameter. */
export function writeOverlay(p: URLSearchParams, overlay: OverlayParam | 'none' | null): void {
  if (overlay && overlay !== 'none') p.set('overlay', overlay);
  else p.delete('overlay');
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
  // A sheet over the town (`/?overlay=trace&run=…`) stays on the town.
  if (p.has('overlay')) return null;
  if (!SELECTION_PARAMS.some((k) => p.has(k))) return null;
  const q = p.toString();
  return `${routeForDeepLink(parseDeepLink(p))}${q ? `?${q}` : ''}`;
}

/** The mode a key press selects (1–4), or null. */
export function modeForKey(key: string): Mode | null {
  const i = Number(key) - 1;
  return Number.isInteger(i) && i >= 0 && i < MODES.length ? MODES[i]! : null;
}
