#!/usr/bin/env node
// The soundscape's browser check (contract §4b, S1 and S4). Nobody can listen in CI, so this measures:
//   1. live, in headless Chromium with the real autoplay policy: no AudioContext before the first gesture,
//      a click starts it, the bed follows a listener, a hidden tab suspends it and showing it resumes;
//   2. offline (OfflineAudioContext): every UI sound, the whoosh and the four cues are non-silent and never
//      clip (peak < 0.9) at default and full volume; the ambient bed is quiet (RMS bounds); the busiest
//      mix at full volume does not clip; every setting (master, ambient, UI, events, mute, reduce) changes
//      the output.
//
//   node apps/studio/src/audio/check/render-check.mjs           # run the checks (exit 1 on failure)
//   node apps/studio/src/audio/check/render-check.mjs --serve   # keep the sound board up (port 3074) to listen;
//                                                                # ?ui=1 shows the HUD toggle and the Sound settings
//   [--port 3074] [--json out.json]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '../../../../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(opt('--port', '3074'));
const SERVE = args.includes('--serve');
const JSON_OUT = opt('--json', null);

const server = await createServer({
  configFile: false,
  root: HERE,
  logLevel: 'warn',
  server: { port: PORT, strictPort: true, host: '127.0.0.1', fs: { allow: [ROOT] } },
  // `?ui=1` mounts the React toggle and settings outside Next.
  resolve: { alias: { 'next/link': path.join(HERE, 'next-link-stub.tsx') } },
});
await server.listen();
const url = `http://127.0.0.1:${PORT}/`;
if (SERVE) {
  console.log(`Sound board: ${url}  (offline check: ${url}?check=1)`);
} else {
  let failed = 0;
  const line = (ok, text) => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
  };
  const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const audio = () => page.evaluate(() => window.__runloopAudio);

    // ── Live (S1) ──
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    let a = await audio();
    line(a.created === false && a.state === 'locked', `no AudioContext before the first gesture (state ${a.state}, created ${a.created})`);
    await page.getByRole('button', { name: 'Start the bed' }).click();
    await page.waitForTimeout(300);
    a = await audio();
    line(a.created === true && a.state === 'running', `the first click starts sound (state ${a.state})`);
    await page.waitForTimeout(3000);
    a = await audio();
    line(a.active.includes('breeze') && a.active.includes('murmur') && a.buses.ambient > 0.2, `the bed fades in and follows the listener (active: ${a.active.join(', ')}; ambient bus ${a.buses.ambient})`);
    line(a.persistentNodes <= 40, `persistent nodes ${a.persistentNodes} ≤ 40`);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    a = await audio();
    line(a.state === 'suspended' && a.buses.master === 0, `a hidden tab mutes and suspends (state ${a.state}, master ${a.buses.master})`);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(800);
    a = await audio();
    line(a.state === 'running' && a.buses.master > 0.28, `showing it resumes and fades back in (state ${a.state}, master ${a.buses.master})`);
    await page.getByRole('button', { name: 'needsApproval' }).click();
    await page.getByRole('button', { name: 'select' }).click();
    await page.waitForTimeout(100);
    a = await audio();
    line(a.voices >= 1 && a.voices <= 12, `one-shot voices play within the cap (${a.voices})`);

    // ── Offline (S4) ──
    await page.goto(`${url}?check=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__renderCheck, null, { timeout: 180_000 });
    const r = await page.evaluate(() => window.__renderCheck);
    if (r.error) line(false, `render check crashed: ${r.error}`);
    else {
      const f = (v) => (v === null || !Number.isFinite(v) ? '  −∞ ' : v.toFixed(1).padStart(5));
      for (const row of r.rows) line(row.ok, `${row.group.padEnd(8)} ${row.name.padEnd(36)} peak ${f(row.measure?.peakDb)} dBFS  rms ${f(row.measure?.rmsDb)} dBFS  (${row.expect})`);
      if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(r, null, 1));
    }
    line(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll sound checks passed.');
  process.exit(failed ? 1 : 0);
}
