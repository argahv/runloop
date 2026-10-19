// sim.js: evaluate the exported Runloop data at any sim time (pure functions of the tick).
//
// Ports of the engine's own closed forms, so the film draws residents exactly where the product does:
// - decodeRoute: packages/events/src/world.ts (from + N/E/S/W run lengths -> cells);
// - walk position: packages/world-engine/src/motion.ts positionAt with ticksPerCell = 1/walkCellsPerMinute
//   (apps/studio/src/town/place.ts draws walkers the same way, plus a lane offset);
// - the sky: apps/studio/src/town/sky.ts skyAt, sampled every 10 minutes in town.json (smoothstep between);
// - lamps: townMaterial.ts, smoothstep(0.3, 0.7, night); windows: lit when occupancy > 0 (StaticTown.tsx).
// tools/export-residents.ts checks the engine's decodeRoute + positionAt round trip on every walk.

const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export function decodeRoute(fromX, fromY, rle) {
  let x = fromX, y = fromY;
  const out = [[x, y]];
  for (const m of rle.matchAll(/([NESW])(\d+)/g)) {
    const [dx, dy] = STEP[m[1]];
    for (let n = Number(m[2]); n > 0; n--) { x += dx; y += dy; out.push([x, y]); }
  }
  return out;
}

const smooth = (t) => t * t * (3 - 2 * t);
export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** The Studio's hashIdx and right-hand lane offset for walkers (apps/studio/src/town/place.ts), verbatim. */
function hashIdx(i, salt) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
const lane = (idx) => 0.16 + 0.12 * hashIdx(idx, 3);
export const residentPhase = (idx) => hashIdx(idx, 4) * Math.PI * 2;

/**
 * A resident evaluator over residents.json. pose(i, tick) -> { gx, gy, dx, dy, walking, inside, action } or null.
 * Segments are tick-ordered; walks are decoded once.
 */
export function residents(R, walkCellsPerMinute = 3) {
  const list = R.residents.map((r) => ({
    ...r,
    segs: r.segs.map((s) => (s[0] === 'w' ? { k: 'w', t0: s[1], a: s[2], to: s[3], path: decodeRoute(s[4], s[5], s[6]) } : { k: 's', t0: s[1], a: s[2], at: s[3], gx: s[4], gy: s[5], inside: !!s[6], floor: s[7], pose: s[8] })),
  }));
  const segAt = (r, tick) => {
    let lo = 0, hi = r.segs.length - 1;
    if (hi < 0 || tick < r.segs[0].t0) return r.segs[0] ?? null;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.segs[m].t0 <= tick) lo = m; else hi = m - 1; }
    return r.segs[lo];
  };
  function pose(i, tick, out = {}) {
    const r = list[i];
    const s = segAt(r, tick);
    if (!s) return null;
    out.action = s.a;
    if (s.k === 's') {
      out.gx = s.gx; out.gy = s.gy; out.dx = 0; out.dy = 1; out.walking = false; out.inside = s.inside; out.pose = s.pose;
      return out;
    }
    const path = s.path, last = path.length - 1;
    const steps = Math.max(0, tick - s.t0) * walkCellsPerMinute;
    out.inside = false; out.pose = 'stand';
    if (steps >= last) {
      const a = path[Math.max(0, last - 1)], b = path[last];
      out.gx = b[0]; out.gy = b[1]; out.dx = b[0] - a[0]; out.dy = b[1] - a[1] || (out.dx ? 0 : 1); out.walking = false;
      return out;
    }
    const k = Math.floor(steps), f = steps - k, a = path[k], b = path[k + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = lane(r.idx);
    out.gx = a[0] + dx * f - dy * L; out.gy = a[1] + dy * f + dx * L; out.dx = dx; out.dy = dy; out.walking = true;
    return out;
  }
  /** Buildings with someone inside at `tick` (windows lit), from the engine's occupancy timeline. */
  function occupied(tick) {
    const lit = new Set();
    for (const [id, changes] of Object.entries(R.occupancy.buildings)) {
      let n = 0;
      for (const [t, c] of changes) { if (t <= tick) n = c; else break; }
      if (n > 0) lit.add(id);
    }
    return lit;
  }
  return { list, pose, occupied, count: list.length };
}

/** The product's sky at a sim minute (any tick), from town.json's 10-minute samples. */
export function skyAt(T, tick) {
  const S = T.sky.samples, every = T.sky.every;
  const m = ((tick % 1440) + 1440) % 1440;
  const i = Math.floor(m / every) % S.length, j = (i + 1) % S.length;
  const k = smooth((m - S[i].m + 1440) % 1440 / every);
  const mixHex = (a, b) => { const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16); const c = (s) => Math.round(((A >> s) & 255) * (1 - k) + ((B >> s) & 255) * k); return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`; };
  const lerp = (a, b) => a + (b - a) * k;
  const a = S[i], b = S[j];
  return {
    night: lerp(a.night, b.night), sunDir: a.sunDir.map((v, n) => lerp(v, b.sunDir[n])), sun: mixHex(a.sun, b.sun), sunI: lerp(a.sunI, b.sunI),
    amb: mixHex(a.amb, b.amb), ambI: lerp(a.ambI, b.ambI), hemiSky: mixHex(a.hemiSky, b.hemiSky), hemiGround: mixHex(a.hemiGround, b.hemiGround), hemiI: lerp(a.hemiI, b.hemiI),
    zenith: mixHex(a.zenith, b.zenith), horizon: mixHex(a.horizon, b.horizon), haze: mixHex(a.haze, b.haze), stars: lerp(a.stars, b.stars),
  };
}

export const lampOn = (night) => smoothstep(0.3, 0.7, night);
/** Ticks: Day d HH:MM. */
export const tickOf = (day, hh, mm = 0, ss = 0) => (day - 1) * 1440 + hh * 60 + mm + ss / 60;
