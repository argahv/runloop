#!/usr/bin/env node
// Town renderer budgets (plan §9 Render): draw calls, triangles and JS time per frame, read from
// window.__runloopPerf at camera bookmarks, under SwiftShader. SwiftShader frame rates are not a
// target (a real GPU is measured by hand with --gpu); draw calls, triangles and JS time do not
// depend on the GPU.
//
// It serves the town harness (apps/studio/src/town/harness: the engine runs in the page on the
// Commons, nothing else needed) with Vite, then visits each bookmark in Chromium.
//
//   node scripts/perf-town.mjs                      # measure every bookmark, check the budgets
//   node scripts/perf-town.mjs --serve              # just serve the harness (default port 3053)
//   node scripts/perf-town.mjs --shots <dir>        # also save a screenshot per bookmark
//
// Options: --port <n> (3053) · --only <names> · --width <px> (1440) · --height <px> (900)
//          --quality high|low|auto (high) · --gpu (no SwiftShader flags; record fps) · --no-assert
//          --wait <ms> (settle time per bookmark, 5000) · --out <file.json> (report)
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HARNESS = path.join(ROOT, 'apps/studio/src/town/harness');
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 3053);
const width = Number(args.width ?? 1440);
const height = Number(args.height ?? 900);
const quality = args.quality ?? 'high';
const wait = Number(args.wait ?? 5000);

/**
 * Budgets (plan §9): draw calls by view (main pass), triangles, JS per frame with 500 actors.
 * JS is checked at the median: under SwiftShader the software rasteriser's threads compete with the
 * page's main thread for CPU, so the tail of wall-clock JS timings measures preemption, not our code
 * (a CPU profile of street-500 shows ~0.5 s of JS in 8 s). The p95 is still recorded.
 */
const BUDGET = { calls: { town: 120, street: 150, interior: 250 }, triangles: 400_000, jsMsWith500: 4 };

/** Camera bookmarks (render draft §5): ?cam=town|street:market|interior:cafe|interior:eng-house, plus stress views. */
const BOOKMARKS = [
  { name: 'town', view: 'town', q: 'cam=town&t=08:15' },
  { name: 'district-market', view: 'town', q: 'cam=district:dst_market_street&t=12:35' },
  { name: 'street-market', view: 'street', q: 'cam=street:40,47&t=12:35' },
  { name: 'street-atrium', view: 'street', q: 'cam=street:48,38&t=12:40' },
  { name: 'interior-cafe', view: 'interior', q: 'cam=interior:bld_corner_cafe&t=12:40' },
  { name: 'interior-eng-house', view: 'interior', q: 'cam=interior:hq&t=10:00' },
  { name: 'town-night', view: 'town', q: 'cam=town&t=22:30' },
  { name: 'town-500', view: 'town', q: 'cam=town&t=08:15&stress=420', actors: 500 },
  { name: 'street-500', view: 'street', q: 'cam=street:48,40&t=08:15&stress=420', actors: 500 },
];

function fixturePlugin() {
  return {
    name: 'runloop-town-fixtures',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (req.url === '/fixture/town') {
            const dir = path.join(ROOT, 'worlds/runloop-commons');
            const interiors = {};
            for (const f of fs.readdirSync(path.join(dir, 'interiors'))) {
              if (f.endsWith('.json')) interiors[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, 'interiors', f), 'utf8'));
            }
            const town = JSON.parse(fs.readFileSync(path.join(dir, 'town.json'), 'utf8'));
            return send(res, { town, interiors });
          }
          if (req.url === '/fixture/run') {
            // The canonical recorded coding-mission run (testkit), for an agent headquarters' diorama.
            const kit = await server.ssrLoadModule(path.join(ROOT, 'packages/testkit/src/index.ts'));
            const world = JSON.parse(fs.readFileSync(path.join(ROOT, 'worlds/research-campus/world.json'), 'utf8'));
            return send(res, { events: kit.codingMissionFixture(), world });
          }
        } catch (err) {
          res.statusCode = 500;
          return res.end(String(err?.stack ?? err));
        }
        next();
      });
    },
  };
}

function send(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const server = await createServer({
  configFile: false,
  root: HARNESS,
  logLevel: 'warn',
  server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [ROOT] } },
  plugins: [fixturePlugin()],
  // Studio modules read Next's public env at import time (lib/config.ts).
  define: { 'process.env.NEXT_PUBLIC_RUNLOOP_API': 'undefined', 'process.env.NODE_ENV': '"development"' },
});
await server.listen();
const base = `http://127.0.0.1:${port}/`;
console.log(`Town harness on ${base}`);

if (args.serve) {
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const code = await measure();
  await server.close();
  process.exit(code);
}

async function measure() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: args.gpu ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const results = [];
  let failed = false;
  for (const b of BOOKMARKS) {
    if (only && !only.has(b.name)) continue;
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const url = `${base}?${b.q}&quality=${quality}${args.theme ? `&theme=${args.theme}` : ''}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    // Warm up (shader compiles, the first shadow map, label fonts), then measure a clean window.
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__runloopPerfReset?.());
    await page.waitForTimeout(wait);
    const perf = await page.evaluate(() => window.__runloopPerf ?? null);
    if (args.shots) {
      fs.mkdirSync(args.shots, { recursive: true });
      await page.screenshot({ path: path.join(args.shots, `world-town-${b.name}${args.theme ? `-${args.theme}` : ''}.png`) });
    }
    await page.close();
    const budgetCalls = BUDGET.calls[b.view];
    const checks = perf
      ? [
          [`calls ${perf.calls} ≤ ${budgetCalls}`, perf.calls <= budgetCalls],
          [`triangles ${perf.triangles} ≤ ${BUDGET.triangles}`, perf.triangles <= BUDGET.triangles],
          ...(b.actors ? [[`JS p50 ${perf.jsMs.p50} ms ≤ ${BUDGET.jsMsWith500} ms (${perf.actors} actors)`, perf.jsMs.p50 <= BUDGET.jsMsWith500]] : []),
          [`no page errors (${errors.length})`, errors.length === 0],
        ]
      : [['window.__runloopPerf present', false]];
    const ok = checks.every(([, pass]) => pass);
    if (!ok) failed = true;
    results.push({ name: b.name, url, perf, errors: errors.slice(0, 5), checks: checks.map(([text, pass]) => ({ text, pass })) });
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${b.name.padEnd(20)} ${
        perf
          ? `calls ${String(perf.calls).padStart(3)} (+shadow ${perf.shadowCalls})  tris ${String(perf.triangles).padStart(7)}  js p50/p95 ${perf.jsMs.p50}/${perf.jsMs.p95} ms  render p50/p95 ${perf.renderMs.p50}/${perf.renderMs.p95} ms  frame p50 ${perf.frameMs.p50} ms  tier ${perf.tier}  actors ${perf.actors} (drawn ${perf.residents})  labels ${perf.labels}`
          : 'no perf data'
      }`,
    );
    for (const [text, pass] of checks) if (!pass) console.log(`       ✗ ${text}`);
    for (const e of errors.slice(0, 3)) console.log(`       page error: ${e}`);
  }
  await browser.close();
  const report = { at: new Date().toISOString(), renderer: args.gpu ? 'gpu' : 'swiftshader', viewport: [width, height], quality, budget: BUDGET, results };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  return failed && !args['no-assert'] ? 1 : 0;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = list[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else {
      out[k] = v;
      i++;
    }
  }
  return out;
}
