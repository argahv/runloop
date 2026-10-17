#!/usr/bin/env node
// Visual regression screenshots of every Studio page and key state (design-system.md, Verification).
//
// Needs a running runtime with at least one recorded run, and the Studio, for example:
//   pnpm dev                       # runtime on :4380, Studio on :3000
//   pnpm screenshots               # = node scripts/screenshots.mjs
// The static export works too: pnpm build && python3 -m http.server 3000 -d apps/studio/out
//
// Options (all optional):
//   --studio <url>     Studio origin             (default http://127.0.0.1:3000)
//   --api <url>        runtime the Studio reads  (default http://127.0.0.1:4380)
//   --out <dir>        output directory          (default .runloop/screenshots/<timestamp>)
//   --widths <list>    viewport widths           (default 1280,1440,1920,390)
//   --themes <list>    dark,light                (default both)
//   --only <list>      state names to capture    (default all; see STATES below)
//   --traced <runId>   traced run to show        (default: the traced run with a failure and the most events)
//   --executed <runId> executed run to show      (default: the newest executed run)
//   --reduced-motion   emulate prefers-reduced-motion
//
// Output: <out>/<theme>-<width>/<state>.png plus manifest.json (each shot's URL and page errors).
// Exits 1 if a page threw an uncaught error. Chromium comes from Playwright (PLAYWRIGHT_BROWSERS_PATH).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const studio = (args.studio ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const api = (args.api ?? 'http://127.0.0.1:4380').replace(/\/+$/, '');
const out = path.resolve(args.out ?? path.join('.runloop', 'screenshots', new Date().toISOString().replace(/[:.]/g, '-')));
const widths = list(args.widths, ['1280', '1440', '1920', '390']).map(Number);
const themes = list(args.themes, ['dark', 'light']);
const only = args.only ? new Set(list(args.only, [])) : null;
const HEIGHT = { 1280: 800, 1440: 900, 1920: 1080, 390: 844 };
const MOBILE_MAX = 760;
const DEAD_RUNTIME = 'http://127.0.0.1:9';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pick the runs to show ─────────────────────────────────────────────

const getJson = async (p) => {
  const res = await fetch(`${api}${p}`);
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return res.json();
};

/** First failing tool result (or failed task) in a run, as an event sequence. */
async function firstFailureSeq(runId) {
  const { events } = await getJson(`/api/runs/${runId}/events?limit=1000`);
  const bad = events.find(
    (e) => (e.type === 'tool.call_completed' && e.payload.status === 'error') || e.type === 'tool.call_failed' || e.type === 'task.failed',
  );
  return bad ? bad.sequence : null;
}

let runs;
try {
  ({ runs } = await getJson('/api/runs'));
} catch (err) {
  console.error(`The runtime at ${api} is not reachable (${err.message}). Start it with: pnpm serve`);
  process.exit(2);
}
const subjects = [];
for (const [kind, wanted] of [['traced', args.traced], ['executed', args.executed]]) {
  const ofKind = runs.filter((r) => (r.mode ?? 'executed') === kind && r.status !== 'running');
  let pick = wanted ? runs.find((r) => r.runId === wanted) : null;
  if (!pick && kind === 'traced') {
    const withFailure = [];
    for (const r of ofKind) if ((await firstFailureSeq(r.runId)) !== null) withFailure.push(r);
    pick = [...withFailure].sort((a, b) => b.lastSequence - a.lastSequence)[0] ?? ofKind[0];
  }
  pick ??= ofKind[0];
  if (pick) subjects.push({ kind, runId: pick.runId, failSeq: await firstFailureSeq(pick.runId) });
}

// ── states ────────────────────────────────────────────────────────────

/** @typedef {{ name: string, url: string, world?: boolean, desktopOnly?: boolean, apiBase?: string, expectConsoleErrors?: boolean, prepare?: (page: import('playwright').Page) => Promise<void> }} State */
/** @type {State[]} */
const STATES = [
  { name: 'overview', url: '/overview/' },
  { name: 'integrations', url: '/integrations/' },
  { name: 'settings', url: '/settings/' },
  // /404/ is the exported 404 page; static servers differ in what they serve for unknown paths.
  { name: 'not-found', url: '/404/' },
  { name: 'palette', url: '/overview/', prepare: async (p) => (await p.keyboard.press('Control+K'), sleep(600)) },
  { name: 'offline', url: '/overview/', apiBase: DEAD_RUNTIME, expectConsoleErrors: true },
  { name: 'offline-world', url: '/world/', apiBase: DEAD_RUNTIME, expectConsoleErrors: true },
];
for (const s of subjects) {
  const run = `run=${s.runId}`;
  const fail = s.failSeq ? `&event=${s.failSeq}` : '';
  STATES.push(
    { name: `world-${s.kind}`, url: `/world/?${run}`, world: true },
    { name: `world-${s.kind}-failure`, url: `/world/?${run}${fail}`, world: true },
    { name: `graph-${s.kind}`, url: `/world/?${run}&view=graph`, desktopOnly: true },
    { name: `traces-${s.kind}-failure`, url: `/traces/?${run}${fail}` },
    { name: `traces-${s.kind}-logs`, url: `/traces/?${run}`, prepare: (p) => clickTab(p, 'logs') },
    { name: `traces-${s.kind}-metrics`, url: `/traces/?${run}`, prepare: (p) => clickTab(p, 'metrics') },
  );
}

async function clickTab(page, id) {
  await page.locator(`#trace-tab-${id}`).click({ timeout: 5000 }).catch(() => {});
  await sleep(700);
}

// ── capture ───────────────────────────────────────────────────────────

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const manifest = { studio, api, subjects, createdAt: new Date().toISOString(), shots: [] };
let pageErrors = 0;

for (const theme of themes) {
  for (const width of widths) {
    const dir = path.join(out, `${theme}-${width}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const state of STATES) {
      if (only && !only.has(state.name)) continue;
      if (state.desktopOnly && width <= MOBILE_MAX) continue;
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT[width] ?? Math.round(width * 0.625) },
        deviceScaleFactor: 1,
        colorScheme: theme === 'light' ? 'light' : 'dark',
        reducedMotion: args['reduced-motion'] ? 'reduce' : 'no-preference',
      });
      // Theme and runtime URL come from the viewer's saved preferences.
      const prefs = { theme, motion: 'system', quality: 'high', apiBase: state.apiBase ?? (api === 'http://127.0.0.1:4380' ? null : api) };
      await context.addInitScript((p) => {
        try {
          window.localStorage.setItem('runloop.prefs.v1', JSON.stringify(p));
        } catch {}
      }, prefs);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
      const file = path.join(dir, `${state.name}.png`);
      try {
        await page.goto(`${studio}${state.url}`, { waitUntil: 'load', timeout: 30000 });
        if (state.world && width > MOBILE_MAX) {
          await page.waitForSelector('[data-world-ready="true"]', { timeout: 30000 }).catch(() => errors.push('world did not report ready'));
          await sleep(2500);
        } else {
          await sleep(state.apiBase ? 3500 : 1500);
        }
        if (state.prepare) await state.prepare(page);
        await page.screenshot({ path: file });
      } catch (err) {
        errors.push(`capture failed: ${err.message}`);
      }
      // Offline and 404 states expect failed requests (console errors); uncaught errors always count.
      const counted = state.expectConsoleErrors ? errors.filter((e) => !e.startsWith('console:')) : errors;
      pageErrors += errors.filter((e) => !e.startsWith('console:')).length;
      manifest.shots.push({ theme, width, state: state.name, url: state.url, file: path.relative(out, file), errors: counted });
      console.log(`${theme} ${String(width).padStart(4)} ${state.name}${counted.length ? `  ! ${counted.join(' | ')}` : ''}`);
      await context.close();
    }
  }
}

await browser.close();
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.shots.length} screenshots in ${out}`);
if (pageErrors > 0) {
  console.error(`${pageErrors} uncaught page error(s); see manifest.json`);
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else o[key] = argv[++i];
  }
  return o;
}

function list(v, fallback) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}
