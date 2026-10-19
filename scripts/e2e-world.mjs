#!/usr/bin/env node
// World E2E (plan §8 S2): open the town and check that it lives.
//
//   1. `/` renders the 3D town (data-world-ready) and the clock advances.
//   2. Residents move: on a fresh world (--fresh) at least 48 of 80 walk within 3 s
//      of the page being ready; otherwise at least one walks in that window by day
//      (06:00–22:00 sim time; at night most residents sleep).
//   3. ⌘K on a resident's name opens their panel with a Why labelled as a simulated,
//      rule-based decision, and every factor cites a recorded event that exists.
//   4. Follow, then the café: Enter shows its interior.
//
// Needs a running runtime and the Studio, for example:
//   pnpm serve & python3 -m http.server 3000 -d apps/studio/out
//   node scripts/e2e-world.mjs [--studio http://127.0.0.1:3000] [--api http://127.0.0.1:4380] [--fresh] [--shots <dir>]
// Prints a JSON report; exits 1 when a check fails. Chromium comes from Playwright.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const studio = (args.studio ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const api = (args.api ?? 'http://127.0.0.1:4380').replace(/\/+$/, '');
const shots = args.shots ? path.resolve(args.shots) : null;
const theme = args.theme ?? 'dark';
const CAFE = 'bld_corner_cafe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (p) => {
  const res = await fetch(`${api}${p}`);
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return res.json();
};

/** Residents walking at the snapshot's tick (a route whose last cell is still ahead). */
const walking = (snap) =>
  snap.residents.filter((r) => r.motion && snap.tick <= r.motion.startTick + Math.ceil((r.motion.path.length - 1) / 3)).map((r) => r.id);

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
// The Studio reads the runtime URL from the viewer's prefs when it is not the build default.
const apiBase = api === 'http://127.0.0.1:4380' ? null : api;
await context.addInitScript(([t, a]) => {
  try {
    window.localStorage.setItem('runloop.prefs.v1', JSON.stringify({ theme: t, motion: 'system', quality: 'high', apiBase: a }));
  } catch {}
}, [theme, apiBase]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  // 1. The town renders.
  const t0 = Date.now();
  const before = await getJson('/api/world/snapshot');
  await page.goto(`${studio}/`, { waitUntil: 'load' });
  const ready = await page.waitForSelector('[data-world-ready="true"]', { timeout: 30000 }).then(() => true, () => false);
  check('town renders (data-world-ready)', ready, { ms: Date.now() - t0 });

  // 2. Residents move within 3 s; the clock advances.
  const snapA = await getJson('/api/world/snapshot');
  // The world clock is `/api/world`'s tick; a snapshot's tick is its last event's, which can stand still at night.
  const infoA = await getJson('/api/world');
  const clockA = await page.locator('[aria-label^="Day "]').first().textContent().catch(() => null);
  const moving = new Set(walking(snapA));
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    for (const id of walking(await getJson('/api/world/snapshot'))) moving.add(id);
  }
  const snapB = await getJson('/api/world/snapshot');
  const infoB = await getJson('/api/world');
  const clockB = await page.locator('[aria-label^="Day "]').first().textContent().catch(() => null);
  const freshNeeded = Math.ceil(snapA.residents.length * 0.6);
  // At night most residents sleep; walking is required only by day (a fresh world starts at 08:00).
  const hour = Math.floor((snapA.tick % 1440) / 60);
  const night = hour >= 22 || hour < 6;
  const need = args.fresh ? freshNeeded : night ? 0 : 1;
  check(`residents moving within 3 s (${args.fresh ? `fresh world: ≥ ${freshNeeded}` : night ? 'night: not required' : '≥ 1'})`, moving.size >= need, {
    moving: moving.size,
    of: snapA.residents.length,
    ticks: [before.tick, snapA.tick, snapB.tick],
  });
  check('clock advances', (infoB.speed === 0 || infoB.tick > infoA.tick) && (infoB.speed === 0 || clockA !== clockB), { clockA, clockB, ticks: [infoA.tick, infoB.tick], speed: infoB.speed });
  if (shots) await page.screenshot({ path: path.join(shots, `world-e2e-town-${theme}.png`) });

  // 3. ⌘K → a walking resident → their Why.
  const subject = snapB.residents.find((r) => moving.has(r.id)) ?? snapB.residents[0];
  await page.keyboard.press('Control+K');
  await sleep(400);
  await page.keyboard.type(subject.name, { delay: 10 });
  await sleep(500);
  await page.keyboard.press('Enter');
  const panel = await page.getByRole('heading', { level: 2, name: subject.name }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('⌘K opens the resident panel', panel, { resident: subject.id, name: subject.name });
  const why = await page.locator('[aria-labelledby="why-title"]').first();
  await why.waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-labelledby="why-title"][aria-busy="true"]'), null, { timeout: 10000 }).catch(() => {});
  const whyText = (await why.textContent().catch(() => '')) ?? '';
  check('Why is labelled a simulated, rule-based decision', whyText.includes('Simulated resident · rule-based decision'));
  const cited = await why.locator('button[title^="Recorded in event"]').evaluateAll((els) => els.map((e) => Number(/event (\d+)/.exec(e.getAttribute('title') ?? '')?.[1])));
  const latest = (await getJson('/api/world')).seq;
  check('every Why factor cites a recorded event', cited.length > 0 && cited.every((s) => Number.isInteger(s) && s >= 1 && s <= latest), { factors: cited.length, latestSeq: latest });
  if (cited.length) {
    const ev = await getJson(`/api/world/events?after=${cited[0] - 1}&limit=1`);
    check('the cited event is the resident’s decision', ev.events[0]?.seq === cited[0] && ev.events[0]?.actor === subject.id && ev.events[0]?.prov === 'simulation', ev.events[0] && { seq: ev.events[0].seq, type: ev.events[0].type, prov: ev.events[0].prov });
  }
  const follow = page.locator('button[aria-keyshortcuts="F"]').first();
  // Picking a resident in ⌘K may already follow them.
  if ((await follow.getAttribute('aria-pressed').catch(() => null)) !== 'true') await follow.click({ timeout: 5000 }).catch(() => {});
  await sleep(2500);
  check('Follow is pressed', (await follow.getAttribute('aria-pressed').catch(() => null)) === 'true');
  if (shots) await page.screenshot({ path: path.join(shots, `world-e2e-follow-why-${theme}.png`) });

  // 4. The café interior.
  await page.goto(`${studio}/?focus=building:${CAFE}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-world-ready="true"]', { timeout: 30000 }).catch(() => {});
  const cafe = await page.getByRole('heading', { level: 2, name: 'Corner Café' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('focus link opens the café panel', cafe);
  // Clicks wait for the town's frame under software rendering (a click can take several seconds there).
  await page.getByRole('button', { name: 'Enter', exact: true }).first().click({ timeout: 20000 }).catch(() => {});
  await page.getByRole('button', { name: 'Leave interior' }).first().waitFor({ timeout: 15000 }).catch(() => {});
  check('Enter shows the café interior', (await page.getByRole('button', { name: 'Leave interior' }).count()) > 0);
  if (shots) await page.screenshot({ path: path.join(shots, `world-e2e-cafe-${theme}.png`) });
} catch (err) {
  check('no exception', false, err.message);
} finally {
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 5));
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ studio, api, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length ? 1 : 0);

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
