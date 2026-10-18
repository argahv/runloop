#!/usr/bin/env node
// Visual regression screenshots of every Studio page and key state (design-system.md, Verification):
// the town (`/`) and its panels, agents and dialogs, then the run pages (Live World, Traces, Experiments).
//
// Needs a running runtime (world on, ideally with one agent added and a traced session) and the Studio, for example:
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
//   --no-pin           never pin a baseline (see below)
//   --suffix <s>       appended to each file name (e.g. -night for a second pass at night)
//   --no-preview       skip the dispatch review state (it asks the runtime for a preview: a nonce and an audit row; nothing runs)
//
// Town states show the world as it is: the clock, the agent's health and its sessions are whatever the
// runtime holds (the agent state is named after its health, e.g. agent-offline). Nothing is submitted:
// Add to World and Assign task stop before their final button.
//
// Experiments: each shown run is compared with another run of the same task (a pinned one,
// else the newest earlier one). For the pinned-baseline states, when no run is pinned yet the
// script pins the first pair's baseline through the API and unpins it when it ends; --no-pin
// skips that (the Experiments states then use whatever pins exist).
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

const suffix = typeof args.suffix === 'string' ? args.suffix : '';
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
// The town: a resident to explain (one walking now, else the first) and the first agent.
let worldInfo = null;
let resident = null;
let agent = null;
try {
  worldInfo = await getJson('/api/world');
  const snap = await getJson('/api/world/snapshot');
  resident = snap.residents.find((r) => r.motion && r.place.kind === 'outdoor') ?? snap.residents[0] ?? null;
  agent = (await getJson('/api/agents')).agents[0] ?? null;
} catch (err) {
  console.warn(`World states skipped: ${err.message}`);
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

// Compare pairs (Experiments): each subject (B) against another run of the same task (A).
const sameTask = (x, y) => x.missionId === y.missionId && (x.source?.projectLabel ?? null) === (y.source?.projectLabel ?? null);
const pairs = [];
for (const s of subjects) {
  const run = runs.find((r) => r.runId === s.runId);
  const others = runs.filter((r) => r.runId !== s.runId && r.status !== 'running' && sameTask(r, run));
  const base = others.find((r) => r.pinnedAt) ?? others.find((r) => Date.parse(r.createdAt) < Date.parse(run.createdAt)) ?? others[0];
  if (base) pairs.push({ kind: s.kind, a: base.runId, b: s.runId });
}

/** Pin or unpin a run as a baseline (the same JSON write the Studio makes). */
async function setPinned(runId, pinned) {
  const res = await fetch(`${api}/api/runs/${encodeURIComponent(runId)}/baseline`, {
    method: pinned ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`${pinned ? 'POST' : 'DELETE'} baseline ${runId}: ${res.status}`);
}

// The pinned-baseline states need a pin; add one for this capture only (undone at the end).
let pinnedHere = null;
if (!args['no-pin'] && pairs.length > 0 && !runs.some((r) => r.pinnedAt)) {
  await setPinned(pairs[0].a, true);
  pinnedHere = pairs[0].a;
  console.log(`Pinned ${pinnedHere} as a baseline for this capture; it is unpinned at the end.`);
}
const pinned = pinnedHere ?? runs.find((r) => r.pinnedAt)?.runId ?? null;

// ── states ────────────────────────────────────────────────────────────

/** @typedef {{ name: string, url: string, world?: boolean, desktopOnly?: boolean, apiBase?: string, expectConsoleErrors?: boolean, waitFor?: string, prepare?: (page: import('playwright').Page) => Promise<void> }} State */
/** @type {State[]} */
const STATES = [];
if (worldInfo) {
  const SIMULATED = 'text=Simulated resident · rule-based decision';
  STATES.push(
    { name: 'town', url: '/', world: true },
    { name: 'town-district', url: '/?focus=district:dst_civic_atrium', world: true },
    { name: 'town-street', url: '/?focus=spot:spot_cafe_patio', world: true },
    { name: 'town-map', url: '/', world: true, desktopOnly: true, prepare: (p) => press(p, 'm', 1200) },
    { name: 'town-directory', url: '/', world: true, prepare: (p) => press(p, 'l', 1200) },
    { name: 'cafe-interior', url: '/?focus=building:bld_corner_cafe', world: true, prepare: (p) => click(p, 'button', 'Enter', 3000, true) },
    { name: 'world-log', url: '/?mode=intelligence', world: true },
    { name: 'agents-mode', url: '/?mode=agents', world: true },
    {
      name: 'add-to-world-1',
      url: '/',
      world: true,
      prepare: async (p) => {
        await click(p, 'button', 'Add to World', 800);
        await p.getByRole('dialog').getByLabel('Building name').fill('Engineering House').catch(() => {});
      },
    },
    { name: 'add-to-world-2', url: '/', world: true, prepare: (p) => addToWorldStep(p, 2) },
    { name: 'add-to-world-3', url: '/', world: true, prepare: (p) => addToWorldStep(p, 3) },
  );
  if (resident) STATES.push({ name: 'resident-why', url: `/?focus=resident:${resident.id}`, world: true, waitFor: SIMULATED });
  if (agent) {
    const focus = `/?mode=agents&focus=agent:${agent.agentId}`;
    STATES.push(
      { name: `agent-${agent.health.replace(/_/g, '-')}`, url: focus, world: true },
      { name: 'agent-interior', url: focus, world: true, prepare: (p) => click(p, 'button', 'Enter building', 3500) },
      { name: 'dispatch-compose', url: focus, world: true, prepare: (p) => assignTask(p, false) },
    );
    if (!args['no-preview']) STATES.push({ name: 'dispatch-review', url: focus, world: true, desktopOnly: true, prepare: (p) => assignTask(p, true) });
  }
}
STATES.push(
  { name: 'overview', url: '/overview/' },
  { name: 'integrations', url: '/integrations/' },
  { name: 'settings', url: '/settings/' },
  // /404/ is the exported 404 page; static servers differ in what they serve for unknown paths.
  { name: 'not-found', url: '/404/' },
  { name: 'palette', url: '/overview/', prepare: async (p) => (await p.keyboard.press('Control+K'), sleep(600)) },
  { name: 'offline', url: '/overview/', apiBase: DEAD_RUNTIME, expectConsoleErrors: true },
  { name: 'offline-world', url: '/world/', apiBase: DEAD_RUNTIME, expectConsoleErrors: true },
  { name: 'offline-town', url: '/', apiBase: DEAD_RUNTIME, expectConsoleErrors: true },
);
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

// Experiments: the default pair (newest pin vs the newest other run of its task), each pair,
// the lower half of each comparison, an unknown run in the link, and an offline runtime.
const COMPARED = 'text=First divergence';
STATES.push(
  { name: 'experiments', url: '/experiments/', waitFor: pairs.length ? COMPARED : undefined },
  { name: 'experiments-offline', url: '/experiments/', apiBase: DEAD_RUNTIME, expectConsoleErrors: true },
);
for (const p of pairs) {
  const url = `/experiments/?a=${p.a}&b=${p.b}`;
  STATES.push(
    { name: `experiments-${p.kind}`, url, waitFor: COMPARED },
    { name: `experiments-${p.kind}-details`, url, waitFor: COMPARED, prepare: (pg) => scrollTo(pg, 'cmp-tests') },
  );
}
if (pairs.length) STATES.push({ name: 'experiments-unknown-run', url: `/experiments/?a=00000000-0000-4000-8000-000000000000&b=${pairs[0].b}` });
// A pinned baseline's own header (the pressed "Baseline" toggle) and a candidate's "Compare" button.
if (pinned) STATES.push({ name: 'traces-baseline', url: `/traces/?run=${pinned}` });

/** Click a control by role and name; a miss is noted on the shot (not an uncaught error). */
async function click(page, role, name, settle = 800, exact = false) {
  await page.getByRole(role, { name, exact }).first().click({ timeout: 8000 });
  await sleep(settle);
}

async function press(page, key, settle = 800) {
  await page.keyboard.press(key);
  await sleep(settle);
}

/** Add to World up to step 2 (a lot) or 3 (the workspace), never submitting. */
async function addToWorldStep(page, step) {
  await click(page, 'button', 'Add to World', 800);
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Building name').fill('Engineering House');
  for (let i = 1; i < step; i++) {
    await dlg.getByRole('button', { name: 'Next' }).click({ timeout: 8000 });
    await sleep(500);
  }
  if (step === 3) await dlg.getByText('A folder on this machine').click({ timeout: 5000 }).catch(() => {});
  await sleep(1200);
}

/** Assign task: compose (and optionally the review with the exact command), never approving. */
async function assignTask(page, review) {
  await click(page, 'button', 'Assign task', 900);
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Task', { exact: true }).fill('Read src/ and test/, then list what the tests check. Do not change any files.');
  await dlg.locator('input[type="number"]').first().fill('0.05');
  // Let the dialog's fade-in finish (frames are slow while the town renders in software).
  await sleep(1200);
  if (review) {
    await dlg.getByRole('button', { name: 'Preview command' }).click({ timeout: 8000 });
    await sleep(1500);
  }
}

async function clickTab(page, id) {
  await page.locator(`#trace-tab-${id}`).click({ timeout: 5000 }).catch(() => {});
  await sleep(700);
}

/** Scroll the page's own scroll container so the element with this id is at the top. */
async function scrollTo(page, id) {
  await page.evaluate((target) => document.getElementById(target)?.scrollIntoView({ block: 'start' }), id);
  await sleep(500);
}

// ── capture ───────────────────────────────────────────────────────────

const manifest = {
  studio,
  api,
  world: worldInfo && { worldId: worldInfo.worldId, tick: worldInfo.tick, speed: worldInfo.speed, contentHash: worldInfo.contentHash },
  resident: resident?.id ?? null,
  agent: agent && { agentId: agent.agentId, health: agent.health },
  subjects,
  pairs,
  pinned,
  createdAt: new Date().toISOString(),
  shots: [],
};
let pageErrors = 0;
try {
  await captureAll();
} finally {
  if (pinnedHere) {
    await setPinned(pinnedHere, false).catch((err) => console.error(`Could not unpin ${pinnedHere}: ${err.message}`));
    console.log(`Unpinned ${pinnedHere}.`);
  }
}

async function captureAll() {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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
        const file = path.join(dir, `${state.name}${suffix}.png`);
        const notes = [];
        try {
          await page.goto(`${studio}${state.url}`, { waitUntil: 'load', timeout: 30000 });
          if (state.world && width > MOBILE_MAX) {
            await page.waitForSelector('[data-world-ready="true"]', { timeout: 30000 }).catch(() => errors.push('world did not report ready'));
            await sleep(2500);
          } else if (state.world) {
            await sleep(3000);
          } else {
            await sleep(state.apiBase ? 3500 : 1500);
          }
          if (state.waitFor) {
            await page.waitForSelector(state.waitFor, { timeout: 30000 }).catch(() => errors.push(`${state.waitFor} did not appear`));
            await sleep(500);
          }
          if (state.prepare) await state.prepare(page).catch((err) => notes.push(`prepare: ${err.message.split('\n')[0]}`));
          await page.screenshot({ path: file });
        } catch (err) {
          errors.push(`capture failed: ${err.message}`);
        }
        // Offline and 404 states expect failed requests (console errors); uncaught errors always count.
        const counted = state.expectConsoleErrors ? errors.filter((e) => !e.startsWith('console:')) : errors;
        pageErrors += errors.filter((e) => !e.startsWith('console:')).length;
        manifest.shots.push({ theme, width, state: state.name, url: state.url, file: path.relative(out, file), errors: counted, notes });
        const flags = [...counted, ...notes];
        console.log(`${theme} ${String(width).padStart(4)} ${state.name}${flags.length ? `  ! ${flags.join(' | ')}` : ''}`);
        await context.close();
      }
    }
  }

  await browser.close();
}

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
