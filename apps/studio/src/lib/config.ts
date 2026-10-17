import { DEFAULT_RUNTIME_PORT } from '@runloop-world/events';

/** Runtime port when nothing overrides it (4380, DL-005: moved off the OTLP port 4317). */
export { DEFAULT_RUNTIME_PORT };

/** Base URL of the local runtime API baked in at build time (no trailing slash). */
export const DEFAULT_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_RUNLOOP_API ?? `http://127.0.0.1:${DEFAULT_RUNTIME_PORT}`);

let override: string | null = null;

/** The runtime URL in use: the viewer's override from Settings, else the build default. */
export function apiBase(): string {
  return override ?? DEFAULT_API_BASE;
}

/** Set (or clear with null) the viewer's runtime URL override. */
export function setApiBaseOverride(url: string | null): void {
  override = url ? normalizeApiBase(url) : null;
}

export function normalizeApiBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** A valid http(s) URL with no path, query or credentials; returns an error message or null. */
export function validateApiBase(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'Enter a full URL, for example http://127.0.0.1:4380';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Use http:// or https://';
  if (u.username || u.password) return 'Credentials are not allowed in the URL';
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return 'Use the server address only, without a path';
  return null;
}

/** The runtime only listens on loopback; anything else is worth a warning. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** Port of a runtime URL (the scheme default when none is given). */
export function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** Mission started by the "Run demo mission" button. */
export const DEMO_MISSION_ID = 'coding-mission';

/**
 * Command that starts the runtime, run from the repo root. Runtime only: when
 * this hint is visible the Studio is already being served, so `pnpm dev`
 * would hit EADDRINUSE. A non-default port is passed explicitly.
 */
export function startRuntimeCommand(url: string = apiBase()): string {
  const port = portOf(url);
  return port === null || port === DEFAULT_RUNTIME_PORT ? 'pnpm serve' : `pnpm serve -- --port ${port}`;
}

/** Browser origins the runtime accepts by default (packages/runtime/src/config.ts). */
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
