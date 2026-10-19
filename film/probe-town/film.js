// Speed probe: the keeps-running town set at three of the film's real moments. Not the film.
// It imports keeps-running's own lib/ and sets/ (one module instance of gl.js and motion.js).
import * as M from '../keeps-running/lib/motion.js';
import * as G from '../keeps-running/lib/gl.js';
import { townSet } from '../keeps-running/sets/town.js';
import { tickOf } from '../keeps-running/lib/sim.js';

const PROBE = { samples: 8, shadows: true };
window.__probe = { frames: [] };
window.__setSamples = (n) => { PROBE.samples = n; };
// probe toggles: which passes cost what (bloom = the composer with its 4x MSAA half-float target + UnrealBloom; shadows = the 2048 moon shadow map)
window.__probeSet = (o) => {
  if ('bloom' in o) SET.bloom = o.bloom ? 0.32 : 0;
  if ('shadows' in o) { G.R.shadowMap.enabled = o.shadows; SET.scene.traverse((m) => { if (m.material) m.material.needsUpdate = true; }); }
};
let SET = null, T = null;

const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
function shot(t) {
  const [W, H] = T.size, sx = (g) => g - (W - 1) / 2, sz = (g) => g - (H - 1) / 2;
  if (t < 3) {
    // A1 macro: the lamp nearest the Commons Fountain, street level, 05:56 at 1x
    const lamps = T.decoration.items.filter((d) => d[0] === 'lamp');
    const f = [47.5, 40];
    const [, gx, gy] = lamps.reduce((a, b) => (Math.hypot(b[1] - f[0], b[2] - f[1]) < Math.hypot(a[1] - f[0], a[2] - f[1]) ? b : a));
    const L = [sx(gx), 0.1, sz(gy)], k = t / 3;
    return { tick: tickOf(2, 5, 56) + t, hq: 'waiting', cam: { pos: lerp3([L[0] - 5.5, 1.9, L[2] + 6.5], [L[0] - 4.6, 1.5, L[2] + 5.8], k), target: [L[0] + 0.5, 0.7, L[2] - 0.5], fov: 40 } };
  }
  if (t < 6) {
    // A3: the Agent District at 21:31, the HQ on lot 5 unpainted (waiting for its first event)
    const lot = T.agentLots.find((l) => l.id === 'lot_agent_5');
    const c = [sx(lot.rect[0]) + (lot.rect[2] - 1) / 2, 1.5, sz(lot.rect[1]) + (lot.rect[3] - 1) / 2], k = (t - 3) / 3;
    return { tick: tickOf(2, 21, 31) + (t - 3), hq: 'waiting', cam: { pos: lerp3([c[0] + 22, 19, c[2] - 34], [c[0] + 17, 16, c[2] - 30], k), target: c, fov: 24 } };
  }
  // A6: the whole Commons at 22:07 at the product's view (azimuth 45, tilt 37), the HQ offline
  const d = 235, az = (45 + (t - 6) * 1.0) * Math.PI / 180, tilt = 37 * Math.PI / 180;
  return { tick: tickOf(2, 22, 7) + (t - 6), hq: 'offline', cam: { pos: [d * Math.cos(tilt) * Math.sin(az), d * Math.sin(tilt), d * Math.cos(tilt) * Math.cos(az)], target: [0, 0, 0], fov: 22 } };
}

M.film({
  samples: () => PROBE.samples,
  async init() {
    const [t, r] = await Promise.all(['../keeps-running/data/town.json', '../keeps-running/data/residents.json'].map((p) => fetch(p).then((x) => x.json())));
    T = t;
    await G.initGL();
    SET = townSet(t, r, { shadows: PROBE.shadows });
    G.R.info.autoReset = false;
    window.__probe.info = SET.info;
  },
  draw(ctx, u, t) {
    M.fill(ctx, '#05070f');
    G.R.info.reset();
    G.renderSet(ctx, SET, t, u, shot(t));
    window.__probe.calls = G.R.info.render.calls;
    window.__probe.triangles = G.R.info.render.triangles;
  },
});
