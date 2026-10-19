// Runloop teaser (30 s, 12 bars): the hero's "30 s teaser" bar map (keeps-running/docs/shotlist.md).
// Pure function of time. Shares the hero's lib/ and sets/ (one module instance of motion.js + gl.js).
// Every C (product UI) bar is a REAL screenshot from docs/assets (copied to assets/shots), cropped and
// pushed in log space. Lime only for the real agent (the HQ beacon live); amber for the town.
// Cheap render: no bloom, no shadows, 1 motion-blur sample (2 on the push through the glass).
import * as M from '../keeps-running/lib/motion.js';
import * as G from '../keeps-running/lib/gl.js';
import { townSet } from '../keeps-running/sets/town.js';
import { tickOf } from '../keeps-running/lib/sim.js';

const { W, H, E, prog, lerp, clamp, font, layout, glyph, text, fill, kf, springU, SPRING } = M;
const C = { void: '#05070F', obsidian: '#101114', ice: '#E8EBF0', muted: '#9297A2', lime: '#B8F36A', amber: '#FFD89A', window: '#FFD18A' };
const DISPLAY = 'Display', UI = 'UI';
const SAFE = { x: 96, y: 60 };

let SET = null, T = null;
const sx = (g) => g - (T.size[0] - 1) / 2, sz = (g) => g - (T.size[1] - 1) / 2;
const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const logz = (a, b, p) => a * (b / a) ** p;   // log-space zoom: a constant-rate dolly
const v3 = new G.THREE.Vector3();
function project([x, y, z]) { v3.set(x, y, z).project(SET.camera); return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H, v3.z]; }

// cheap glow: one additive radial gradient (no bloom pass)
function glow(ctx, x, y, r, color, a) {
  if (a <= 0.003 || r <= 0) return;
  const [cr, cg, cb] = M.hexRgb(color);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`); g.addColorStop(0.35, `rgba(${cr},${cg},${cb},${a * 0.35})`); g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.restore();
}
const grade = (ctx, a) => { if (a > 0) { ctx.fillStyle = `rgba(5,7,15,${a})`; ctx.fillRect(0, 0, W, H); } };
// edge vignette toward film.void
function vignette(ctx, a = 0.55) {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
  g.addColorStop(0, 'rgba(5,7,15,0)'); g.addColorStop(1, `rgba(5,7,15,${a})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// mono caption chip (the product's own labels). dot = lime only for the real agent.
function caption(ctx, str, x, y, a, dot = null) {
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  const f = font(26, 500, UI); ctx.font = f;
  const w = ctx.measureText(str).width + (dot ? 34 : 0) + 36;
  M.rrect(ctx, x, y - 34, w, 50, 10); ctx.fillStyle = 'rgba(16,17,20,0.78)'; ctx.fill();
  ctx.strokeStyle = 'rgba(232,235,240,0.14)'; ctx.lineWidth = 1.5; ctx.stroke();
  if (dot) { ctx.beginPath(); ctx.arc(x + 26, y - 9, 6, 0, M.TAU); ctx.fillStyle = dot; ctx.fill(); }
  text(ctx, str, x + 18 + (dot ? 34 : 0), y, f, C.ice);
  ctx.restore();
}

// title rising per word through a mask
function maskedWords(ctx, words, x, base, size, weight, u0, uOut, u, color = C.ice) {
  const f = font(size, weight, DISPLAY); ctx.font = f;
  let cx = x;
  words.forEach((w, i) => {
    const L = layout(ctx, w, f, -0.02 * size);
    const kin = E.outQuint(prog(u, u0 + i * 0.21, u0 + i * 0.21 + 0.75));
    const kout = uOut == null ? 0 : E.inCubic(prog(u, uOut + i * 0.06, uOut + 0.4 + i * 0.06));
    const dy = (1 - kin) * size * 1.1 + kout * size * 1.1;
    if (kin > 0 && kout < 1) {
      ctx.save(); ctx.beginPath(); ctx.rect(cx - 10, base - size * 1.05, L.width + 40, size * 1.32); ctx.clip();
      L.glyphs.forEach((g) => glyph(ctx, g.ch, cx + g.cx, base + dy, f, color));
      ctx.restore();
    }
    cx += L.width + size * 0.26;
  });
}

// ------------------------------------------------------------------ the loop mark (Studio BrandRing paths)
// M12 3 a9 9 0 1 1 -8.5 6 (arc) + dot at (5.2, 5.6) r 2.1, in a 24 box. Drawn in Ice (not an agent).
function mark(ctx, cx, cy, s, draw = 1, dot = 1, color = C.ice) {
  ctx.save(); ctx.translate(cx - 12 * s, cy - 12 * s); ctx.scale(s, s);
  const p = new Path2D('M12 3a9 9 0 1 1-8.5 6');
  ctx.strokeStyle = color; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  const len = 50; ctx.setLineDash([len * draw, len]); ctx.stroke(p); ctx.setLineDash([]);
  if (dot > 0) { ctx.beginPath(); ctx.arc(5.2, 5.6, 2.1 * dot, 0, M.TAU); ctx.fillStyle = color; ctx.fill(); }
  ctx.restore();
}

// ------------------------------------------------------------------ C: a real screenshot, log push toward a point
function shot(ctx, img, u, u0, u1, [fx, fy], z0, z1, cropZoom = 1) {
  fill(ctx, C.obsidian);
  const p = prog(u, u0, u1);
  const z = logz(z0, z1, p) * cropZoom;
  // scale so the image covers the frame at zoom z, keep the focus point (fx, fy in image px) fixed toward centre
  const s = Math.max(W / img.width, H / img.height) * z;
  const dw = img.width * s, dh = img.height * s;
  let x = W / 2 - fx * s, y = H / 2 - fy * s;
  x = clamp(x, W - dw, 0); y = clamp(y, H - dh, 0);
  ctx.drawImage(img, x, y, dw, dh);
}

// ------------------------------------------------------------------ 3-D shots (hero shots re-timed one bar each)
let LAMP0 = null, BAKERY = null, HQ = null;
function hqCam(k) { // the HQ's glass front faces north (scene -z): approach from the north
  const c = HQ;
  return { pos: lerp3([c[0] + 14, 11, c[2] - 30], [c[0] + 3, 3.2, c[2] - 12], k), target: [c[0], 1.4, c[2]], fov: lerp(24, 22, k) };
}
function view(u, t) {
  const bar = Math.floor(u / 4), lu = u - bar * 4, k = lu / 4;   // local beats 0..4 in the bar
  switch (bar) {
    case 0: { // First light: one lamp pool, looking down, title over it
      const L = LAMP0;
      return { tick: tickOf(2, 5, 54) + t / 60, hq: 'waiting', lampReveal: (i) => (i === L.i ? E.outCubic(prog(u, 0, 0.6)) : 0),
        cam: { pos: [L.p[0] - 3.2, lerp(2.9, 2.6, k), L.p[2] + 3.4], target: [L.p[0] + 0.4, 0.2, L.p[2] - 0.3], fov: 40 } };
    }
    case 1: { // Routines begin: Sunrise Bakery, its windows warm at 06:01 (engine occupancy), one beat before the bar ends
      const b = BAKERY, tl = lu * M.GRID.period;
      return { tick: tickOf(2, 6, 1) + (tl - 1.95) / 60, hq: 'waiting',
        cam: { pos: lerp3([b[0] + 20, 13, b[2] + 26], [b[0] + 16, 10.5, b[2] + 21], E.inOutSine(k)), target: [b[0], 1.0, b[2]], fov: 30 } };
    }
    case 2: { // A day in the Commons: 07:45 -> 21:30 time-lapse over one bar, orbit Hearth Row
      const az = (200 + 14 * k) * Math.PI / 180, c = [sx(25.5), 0, sz(10)], d = 70, tilt = 34 * Math.PI / 180;
      return { tick: tickOf(2, 7, 45) + E.inOutSine(k) * (13.75 * 60), hq: 'waiting',
        cam: { pos: [c[0] + d * Math.cos(tilt) * Math.sin(az), d * Math.sin(tilt), c[2] + d * Math.cos(tilt) * Math.cos(az)], target: c, fov: 26 } };
    }
    case 3: // It goes live: the session's first recorded event (go-live sits on this downbeat in the score)
      return { tick: tickOf(2, 21, 40) + lu * M.GRID.period / 60, hq: u < 12.25 ? 'waiting' : 'live', cam: hqCam(E.inOutSine(k) * 0.45) };
    case 4: // through the glass (first 1.5 beats of 3-D)
      return { tick: tickOf(2, 21, 42), hq: 'live', cam: hqCam(0.45 + 0.55 * E.inCubic(prog(lu, 0, 1.5))) };
    case 7: { // Rewind bar: pull away from the HQ to district height; the town keeps moving forward at 1x
      const kk = E.outCubic(k), c = HQ;
      return { tick: tickOf(2, 21, 52) + lu * M.GRID.period / 60, hq: 'live',
        cam: { pos: lerp3([c[0] + 6, 6, c[2] - 16], [c[0] - 18, 30, c[2] - 52], kk), target: lerp3([c[0], 1.4, c[2]], [c[0] - 14, 0, c[2] + 6], kk), fov: 26 } };
    }
    default: { // bars 10-11: the whole Commons at the product's view (azimuth 45, tilt 37), 22:07
      const d = 235 * logz(1, 0.97, prog(u, 40, 48)), az = (45 + (u - 40) * 0.25) * Math.PI / 180, tilt = 37 * Math.PI / 180;
      return { tick: tickOf(2, 22, 7) + (t - 25) / 60, hq: 'offline',
        cam: { pos: [d * Math.cos(tilt) * Math.sin(az), d * Math.sin(tilt), d * Math.cos(tilt) * Math.cos(az)], target: [0, 0, 0], fov: 22 } };
    }
  }
}

const HITS = [
  [0, 'open: sub drone', 'sub', { len: 2 }],
  [1, 'title in', 'tick'],
  [1.5, 'first lamp', 'bell', { pitch: 'A5' }],
  [4, 'cut: bakery', 'click'],
  [7, 'bakery window warms', 'blip', { pitch: 'A5' }],
  [8, 'time-lapse', 'whoosh', { len: 0.5 }],
  [12.25, 'HQ goes live (first recorded event)', 'bell', { pitch: 'D6' }],
  [15.5, 'push through the glass', 'whoosh', { len: 0.5 }],
  [20, 'test failure (exit 1)', 'thud'],
  [24, 'cut: trace', 'click'],
  [27.5, 'out of the trace', 'whoosh', { len: 0.45, from: 2400, to: 300 }],
  [32, 'cut: replay', 'click'],
  [36, 'cut: compare', 'click'],
  [40, 'ring road trace', 'swell'],
  [42.5, 'logo forms', 'bell', { pitch: 'D6' }],
  [44, 'end card', 'impact'],
];

M.film({
  fonts: [font(100, 600, DISPLAY), font(26, 500, UI)],
  images: { live: 'assets/shots/agent-live.png', session: 'assets/shots/claude-code-session.png', trace: 'assets/shots/intelligence.png', replay: 'assets/shots/agent-interior.png', lab: 'assets/shots/lab.png' },
  hits: HITS,
  samples: (t) => (t > 10.0 && t < 11.0 ? 2 : 1),
  async init() {
    const [t, r] = await Promise.all(['../keeps-running/data/town.json', '../keeps-running/data/residents.json'].map((p) => fetch(p).then((x) => x.json())));
    T = t;
    await G.initGL();
    G.R.shadowMap.enabled = false;
    SET = townSet(t, r, { shadows: false });
    SET.bloom = 0;   // no bloom on software GL: cheap 2-D glow instead
    const lamps = T.decoration.items.map((d, j) => d).filter((d) => d[0] === 'lamp');
    const f = [47.5, 40];
    let bi = 0; lamps.forEach((l, i) => { if (Math.hypot(l[1] - f[0], l[2] - f[1]) < Math.hypot(lamps[bi][1] - f[0], lamps[bi][2] - f[1])) bi = i; });
    LAMP0 = { i: bi, p: [sx(lamps[bi][1]), 0.1, sz(lamps[bi][2])] };
    const b = T.buildings.find((x) => x.id === 'bld_sunrise_bakery').footprint;
    BAKERY = [sx(b[0] + (b[2] - 1) / 2), 0, sz(b[1] + (b[3] - 1) / 2)];
    const lot = T.agentLots.find((l) => l.id === 'lot_agent_5');
    HQ = [sx(lot.rect[0]) + (lot.rect[2] - 1) / 2, 0, sz(lot.rect[1]) + (lot.rect[3] - 1) / 2];
    HQ.beacon = [HQ[0] + T.agentHq.beacon.u, T.agentHq.beacon.y, HQ[2] + (lot.frontage === 'n' ? -1 : 1) * T.agentHq.beacon.v];
  },
  draw(ctx, u, t, IMG) {
    const bar = Math.floor(u / 4);
    fill(ctx, C.void);
    const three = [0, 1, 2, 3, 7, 10, 11].includes(bar) || (bar === 4 && u < 17.5);
    if (three) {
      const v = view(u, t);
      G.renderSet(ctx, SET, t, u, v);
      if (bar === 0) {
        grade(ctx, 0.35);
        const [x, y] = project([LAMP0.p[0], 2.0, LAMP0.p[2]]);
        glow(ctx, x, y, 120, C.amber, 0.55 * E.outCubic(prog(u, 0, 0.6)));
        vignette(ctx, 0.8);
      } else if (bar === 3 || bar === 4) {
        grade(ctx, 0.12);
        const [x, y] = project(HQ.beacon);
        if (u >= 12.25) {
          glow(ctx, x, y, 90, C.lime, 0.45);
          // one restrained pulse ring, 0.6 s
          const p = prog(t, M.TS(12.25), M.TS(12.25) + 0.6);
          if (p > 0 && p < 1) {
            const [x2] = project([HQ.beacon[0] + lerp(0.42, 1.6, p), HQ.beacon[1], HQ.beacon[2]]);
            const r = Math.abs(x2 - x);
            ctx.save(); ctx.strokeStyle = C.lime; ctx.globalAlpha = 0.9 * (1 - p); ctx.lineWidth = 3;
            ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.35, 0, 0, M.TAU); ctx.stroke(); ctx.restore();
          }
        }
        vignette(ctx, 0.5);
      } else if (bar >= 10) {
        vignette(ctx, 0.6);
      } else vignette(ctx, 0.45);
    }

    // ---- bar 0: title
    if (bar === 0) maskedWords(ctx, ['A', 'world,', 'not', 'a', 'dashboard.'], SAFE.x + 8, H * 0.62, 104, 600, 1, 3.45, u);
    // ---- bar 3/4: the product's own label for a real agent
    if (bar === 3 || (bar === 4 && u < 17.5)) caption(ctx, 'Real · Claude Code · observed', SAFE.x, H - SAFE.y - 40, E.outCubic(prog(u, 12.5, 13)) * (1 - prog(u, 16.8, 17.3)), C.lime);
    // ---- bar 4: through the glass -> C3 (agent-live.png: the HQ card, "Live · last event 4 s ago")
    if (bar === 4) {
      const g = E.inOutCubic(prog(u, 17.0, 18.0));   // the pane rectangle grows to the frame
      if (g > 0) {
        const w = logz(W * 0.12, W, g), h = w * H / W, x = (W - w) / 2, y = (H - h) / 2 - (1 - g) * 40;
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.translate(x, y); ctx.scale(w / W, h / H);
        shot(ctx, IMG.live, u, 17, 20, [905, 470], 1.7, 1.78);
        ctx.restore();
      }
    }
    // ---- bar 5: the failure (claude-code-session.png: "Test Chamber · Tool error · Exit code 1 · 12 tests")
    if (bar === 5) shot(ctx, IMG.session, u, 20, 24, [560, 270], 2.0, 2.6);
    // ---- bar 6: the failure in the trace (intelligence.png: the Read error row + event panel)
    if (bar === 6) shot(ctx, IMG.trace, u, 24, 28, [880, 560], 1.35, 1.75);
    // ---- bar 7: rewind bar, the town keeps moving forward; the product's own words
    if (bar === 7) caption(ctx, 'Simulated time ×1. Real agents run at real speed.', SAFE.x, H - SAFE.y - 40, E.outCubic(prog(u, 28.5, 29)) * (1 - prog(u, 31.5, 31.95)));
    // ---- bar 8: replay inside the building (agent-interior.png: session bar + diorama)
    if (bar === 8) shot(ctx, IMG.replay, u, 32, 36, [720, 560], 1.3, 1.6);
    // ---- bar 9: compare at the Lattice Lab (lab.png: tests passing, tool calls, tokens not reported)
    if (bar === 9) shot(ctx, IMG.lab, u, 36, 40, [1000, 560], 1.25, 1.55);

    // ---- bar 10: the ring road traces in Ice, then the loop mark forms; bar 11: end card
    if (bar >= 10) {
      const MX = SAFE.x + 70, MY = H * 0.5 - 4, MS = 5.6;   // the mark's end-card position
      const endDim = E.inOutSine(prog(u, 42.5, 44.5));
      grade(ctx, 0.62 * endDim);
      const r = T.ringRoad.gridRect, pts = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]], [r[0], r[1]]].map(([gx, gy]) => project([sx(gx + 0.5), 0.15, sz(gy + 0.5)]));
      const tr = E.inOutSine(prog(u, 40, 42.3)), fade = 1 - prog(u, 42.3, 43.2);
      if (tr > 0 && fade > 0) {
        ctx.save(); ctx.globalAlpha = fade; ctx.strokeStyle = C.ice; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const seg = []; let total = 0; for (let i = 0; i < 4; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); total += l; }
        let left = tr * total; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 0; i < 4 && left > 0; i++) { const q = Math.min(1, left / seg[i]); ctx.lineTo(lerp(pts[i][0], pts[i + 1][0], q), lerp(pts[i][1], pts[i + 1][1], q)); left -= seg[i]; }
        ctx.shadowColor = 'rgba(232,235,240,0.8)'; ctx.shadowBlur = 14; ctx.stroke(); ctx.restore();
      }
      // the mark draws in at the ring's centre and springs to the end-card position
      const md = E.inOutCubic(prog(u, 42.2, 43.4));
      if (md > 0) {
        const c0 = project([0, 0, 0]), sp = springU(u, 43.4, SPRING.gentle);
        const x = lerp(c0[0], MX, clamp(sp, 0, 1.2)), y = lerp(c0[1], MY, clamp(sp, 0, 1.2)), s = lerp(9, MS, clamp(sp, 0, 1.2));
        glow(ctx, x, y, 22 * s, C.ice, 0.18 * md);
        mark(ctx, x, y, s, md, E.outBack(prog(u, 43.1, 43.5)));
      }
      if (bar === 11) {
        maskedWords(ctx, ['Runloop:', 'a', 'world', 'for', 'AI', 'agents'], MX + 12 * MS + 34, MY + 34, 96, 600, 44.1, null, u);
      }
    }
  },
});
