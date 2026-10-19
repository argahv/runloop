// sets/town.js: Runloop Commons as a midnight diorama, built once from data/town.json (the product's
// compiled town) and drawn at any sim tick from data/residents.json (the engine's residents) and the
// product's sky. A first real set: ground, buildings with lit windows, lamps and their pools, trees,
// the agent HQ (waiting / live / offline), residents, the land and haze. update() is a pure function
// of (t, u, opts): opts.tick (sim minutes), opts.cam {pos, target, fov}, opts.hq ('waiting'|'live'|'offline'|'none').
//
// Draw-call budget (probe): ground 1, buildings 1, windows 1, roofs folded into buildings, lamps 3, trees 3,
// land 2, HQ 3, residents 1, sky 1. Everything repeated is merged or instanced.
import * as G from '../lib/gl.js';
import { residents as residentEval, skyAt, lampOn } from '../lib/sim.js';

const { THREE } = G;
const CODE = { '.': 'grass', R: 'road', S: 'sidewalk', X: 'crosswalk', P: 'plaza', p: 'path', G: 'park', g: 'garden', W: 'water', L: 'lot', F: 'footprint', D: 'door', M: 'landmark' };

const col = (hex) => new THREE.Color(hex);

/** A merged, vertex-coloured geometry builder (non-indexed triangles). */
class Geo {
  constructor() { this.p = []; this.c = []; this.n = []; }
  tri(a, b, c, color) {
    const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
    const n = new THREE.Vector3().crossVectors(ab, ac).normalize();
    for (const v of [a, b, c]) { this.p.push(v.x, v.y, v.z); this.c.push(color.r, color.g, color.b); this.n.push(n.x, n.y, n.z); }
  }
  quad(a, b, c, d, color) { this.tri(a, b, c, color); this.tri(a, c, d, color); }
  /** Axis-aligned box from (x0,y0,z0) to (x1,y1,z1), top and sides (no bottom). */
  box(x0, y0, z0, x1, y1, z1, color, top = color) {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    this.quad(V(x0, y1, z0), V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), top);
    this.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), color);
    this.quad(V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0), color);
    this.quad(V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), color);
    this.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0), color);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

export function townSet(T, R, { shadows = true } = {}) {
  const [W, H] = T.size;
  const sx = (gx) => gx - (W - 1) / 2, sz = (gy) => gy - (H - 1) / 2;
  const Y = T.frame.surfaceY;
  const scene = new THREE.Scene();
  const cam = G.camera(24, 0.5, 900);
  const pal = T.palette;
  const groundCol = { grass: pal.ground.grass, road: pal.ground.asphalt, sidewalk: pal.ground.sidewalk, crosswalk: pal.ground.crosswalk, plaza: pal.ground.plazaA, path: pal.ground.path, park: pal.ground.park, garden: pal.ground.gardenSoil, water: pal.ground.water, lot: '#cdbf9f', footprint: pal.ground.footprint, door: pal.ground.footprint, landmark: pal.ground.landmarkBase };

  // ---- ground: one merged mesh, a quad per cell at the product's surface heights, curbs as side faces
  const dAt = (x, y) => T.districts.find((d) => d.rects.some(([rx, ry, rw, rh]) => x >= rx && y >= ry && x < rx + rw && y < ry + rh));
  const g = new Geo();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? Y['.'] : Y[T.ground.rows[y][x]]);
  const agentLot = new Set();
  for (const l of T.agentLots) for (let y = l.rect[1]; y < l.rect[1] + l.rect[3]; y++) for (let x = l.rect[0]; x < l.rect[0] + l.rect[2]; x++) agentLot.add(y * W + x);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = T.ground.rows[y][x];
    const kind = CODE[ch];
    let c = col(kind === 'grass' ? (dAt(x, y)?.ground ?? groundCol.grass) : groundCol[kind]);
    if (agentLot.has(y * W + x)) c = col('#b9b3a3');
    if (kind === 'road' && (x + y) % 2) c.multiplyScalar(0.97);
    const h = hAt(x, y), X0 = sx(x) - 0.5, X1 = sx(x) + 0.5, Z0 = sz(y) - 0.5, Z1 = sz(y) + 0.5;
    g.quad(V(X0, h, Z0), V(X0, h, Z1), V(X1, h, Z1), V(X1, h, Z0), c);
    const side = c.clone().multiplyScalar(0.7);
    const hs = hAt(x, y + 1); if (hs < h) g.quad(V(X0, hs, Z1), V(X1, hs, Z1), V(X1, h, Z1), V(X0, h, Z1), side);
    const he = hAt(x + 1, y); if (he < h) g.quad(V(X1, he, Z1), V(X1, he, Z0), V(X1, h, Z0), V(X1, h, Z1), side);
    const hn = hAt(x, y - 1); if (hn < h) g.quad(V(X1, hn, Z0), V(X0, hn, Z0), V(X0, h, Z0), V(X1, h, Z0), side);
    const hw = hAt(x - 1, y); if (hw < h) g.quad(V(X0, hw, Z0), V(X0, hw, Z1), V(X0, h, Z1), V(X0, h, Z0), side);
  }
  // lane marks on the ring and avenues (thin quads)
  const mark = col(pal.ground.laneMark);
  for (const r of T.roads) {
    const [x, y, w, h] = r.rect, along = w > h;
    for (let i = 1; i < (along ? w : h) - 1; i += 3) {
      const cx = along ? sx(x + i) : sx(x) + (w - 1) / 2, cz = along ? sz(y) + (h - 1) / 2 : sz(y + i);
      const lx = along ? 0.7 : 0.06, lz = along ? 0.06 : 0.7;
      g.quad(V(cx - lx, 0.006, cz - lz), V(cx - lx, 0.006, cz + lz), V(cx + lx, 0.006, cz + lz), V(cx + lx, 0.006, cz - lz), mark);
    }
  }
  const lambert = (o = {}) => new THREE.MeshLambertMaterial({ vertexColors: true, ...o });
  const groundMesh = new THREE.Mesh(g.build(), lambert());
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  // ---- buildings: walls, trim and roofs merged; windows in their own mesh (colours updated per frame)
  const bg = new Geo(), wg = new Geo();
  const windows = []; // { bld, from, count }
  for (const b of T.buildings) {
    const [fx, fy, fw, fh] = b.footprint;
    const x0 = sx(fx) - 0.5 + 0.2, x1 = sx(fx + fw - 1) + 0.5 - 0.2, z0 = sz(fy) - 0.5 + 0.2, z1 = sz(fy + fh - 1) + 0.5 - 0.2;
    const base = 0.1, top = b.wallTop;
    const wall = col(b.archetype === 'greenhouse' ? pal.building.greenhouseGlass : b.palette.wall), roof = col(b.palette.roof), trim = col(b.palette.trim);
    bg.box(x0 - 0.06, 0.06, z0 - 0.06, x1 + 0.06, base + 0.2, z1 + 0.06, col(pal.building.plinth));
    bg.box(x0, base, z0, x1, top, z1, wall, trim);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, o = 0.28;
    const alongX = b.facing === 's' || b.facing === 'n';
    const ridgeAlongX = b.roof === 'gable_u' || b.roof === 'glass_gable' ? alongX : b.roof === 'gable_v' || b.roof === 'false_front' ? !alongX : null;
    const rise = { gable_u: 1.25, gable_v: 1.35, glass_gable: 1.0, false_front: 0.7, hip: 1.0, hip_portico: 1.1, hip_portico_cupola: 1.5, sawtooth: 0.95 }[b.roof] ?? 0;
    const rc = b.roof === 'glass_gable' ? col(pal.building.greenhouseGlass) : roof;
    if (ridgeAlongX !== null) {
      const X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o;
      if (ridgeAlongX) {
        bg.quad(V(X0, top, Z1), V(X1, top, Z1), V(X1, top + rise, cz), V(X0, top + rise, cz), rc);
        bg.quad(V(X1, top, Z0), V(X0, top, Z0), V(X0, top + rise, cz), V(X1, top + rise, cz), rc);
        bg.tri(V(x0, top, z1), V(x0, top + rise, cz), V(x0, top, z0), wall); bg.tri(V(x1, top, z0), V(x1, top + rise, cz), V(x1, top, z1), wall);
      } else {
        bg.quad(V(X1, top, Z1), V(X1, top, Z0), V(cx, top + rise, Z0), V(cx, top + rise, Z1), rc);
        bg.quad(V(X0, top, Z0), V(X0, top, Z1), V(cx, top + rise, Z1), V(cx, top + rise, Z0), rc);
        bg.tri(V(x0, top, z1), V(x1, top, z1), V(cx, top + rise, z1), wall); bg.tri(V(x1, top, z0), V(x0, top, z0), V(cx, top + rise, z0), wall);
      }
    } else if (b.roof.startsWith('hip')) {
      const X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o, r = Math.min(X1 - X0, Z1 - Z0) / 2;
      const a = alongX || (X1 - X0) >= (Z1 - Z0) ? [V(X0 + r, top + rise, cz), V(X1 - r, top + rise, cz)] : [V(cx, top + rise, Z0 + r), V(cx, top + rise, Z1 - r)];
      const [p, q] = a;
      if ((X1 - X0) >= (Z1 - Z0)) {
        bg.quad(V(X0, top, Z1), V(X1, top, Z1), q, p, rc); bg.quad(V(X1, top, Z0), V(X0, top, Z0), p, q, rc);
        bg.tri(V(X0, top, Z0), V(X0, top, Z1), p, rc); bg.tri(V(X1, top, Z1), V(X1, top, Z0), q, rc);
      } else {
        bg.quad(V(X1, top, Z1), V(X1, top, Z0), p, q, rc); bg.quad(V(X0, top, Z0), V(X0, top, Z1), q, p, rc);
        bg.tri(V(X1, top, Z0), V(X0, top, Z0), p, rc); bg.tri(V(X0, top, Z1), V(X1, top, Z1), q, rc);
      }
    } else if (b.roof === 'sawtooth') {
      const n = Math.max(2, Math.round((z1 - z0) / 2.2)), st = (z1 - z0) / n;
      for (let i = 0; i < n; i++) { const a0 = z0 + i * st; bg.quad(V(x1, top, a0 + st), V(x0, top, a0 + st), V(x0, top + rise, a0), V(x1, top + rise, a0), rc); }
    } else {
      bg.box(x0 - 0.02, top - 0.02, z0 - 0.02, x1 + 0.02, top + 0.3, z1 + 0.02, rc.clone().multiplyScalar(0.8), col('#8f8a82'));
      if (b.roof === 'flat_dome') bg.box(cx - 1, top + 0.3, cz - 1, cx + 1, top + 1.2, cz + 1, col('#f1f0ea'));
    }
    // windows: rows of panes on all four sides, every floor
    const from = wg.p.length / 9;
    const pane = (ax, az, bx, bz, y0, nx, nz) => {
      const e = 0.06; const c = col('#46566a');
      wg.quad(V(ax + nx * e, y0, az + nz * e), V(bx + nx * e, y0, bz + nz * e), V(bx + nx * e, y0 + 0.66, bz + nz * e), V(ax + nx * e, y0 + 0.66, az + nz * e), c);
    };
    const step = b.archetype === 'office' || b.archetype === 'lab' ? 1.25 : 1.6, ww = b.archetype === 'office' || b.archetype === 'lab' ? 0.86 : 0.55;
    for (let f = 0; f < b.floors; f++) {
      const y0 = base + f * T.frame.storey + 0.5;
      const along = (a0, a1, fn) => { const n = Math.max(1, Math.floor((a1 - a0 - 0.9) / step)); for (let i = 0; i < n; i++) { const u = (a0 + a1) / 2 - ((n - 1) * step) / 2 + i * step; fn(u); } };
      along(x0, x1, (u) => { pane(u - ww / 2, z1, u + ww / 2, z1, y0, 0, 1); pane(u + ww / 2, z0, u - ww / 2, z0, y0, 0, -1); });
      along(z0, z1, (v) => { pane(x1, v + ww / 2, x1, v - ww / 2, y0, 1, 0); pane(x0, v - ww / 2, x0, v + ww / 2, y0, -1, 0); });
    }
    windows.push({ id: b.id, from, count: wg.p.length / 9 - from });
  }
  const buildMesh = new THREE.Mesh(bg.build(), lambert());
  buildMesh.castShadow = shadows; buildMesh.receiveShadow = shadows;
  scene.add(buildMesh);
  const winGeo = wg.build();
  const winMesh = new THREE.Mesh(winGeo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }));
  scene.add(winMesh);

  // ---- landmarks (simple massing: clock tower, fountain, board, statue)
  const lg = new Geo();
  for (const l of T.landmarks) {
    const [x, y, w, h] = l.rect, X0 = sx(x) - 0.45, X1 = sx(x + w - 1) + 0.45, Z0 = sz(y) - 0.45, Z1 = sz(y + h - 1) + 0.45;
    const ht = { clock_tower: 4.2, fountain: 0.45, signal_board: 1.6, statue: 1.8, gazebo: 1.4 }[l.kind] ?? 1;
    lg.box(X0, 0.1, Z0, X1, 0.1 + ht, Z1, col(T.palette.landmark.stone), col(l.kind === 'fountain' ? T.palette.landmark.fountainWater : T.palette.landmark.stoneDark));
  }
  const lmMesh = new THREE.Mesh(lg.build(), lambert()); lmMesh.castShadow = shadows; scene.add(lmMesh);

  // ---- lamps: posts + heads instanced; ground pools and soft light cones (additive, cheap volumetrics)
  const lamps = T.decoration.items.filter((d) => d[0] === 'lamp').map(([, gx, gy]) => [sx(gx), hAt(gx, gy), sz(gy)]);
  const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1.9, 0.08), new THREE.MeshLambertMaterial({ color: T.palette.deco.lampPost }), lamps.length);
  const headMat = new THREE.MeshBasicMaterial({ color: T.palette.glow.lamp });
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.2, 0.26), headMat, lamps.length);
  const poolTex = (() => { const t = G.canvasTexture(128, 128); t.draw((c, w, h) => { const gr = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(255,216,154,1)'); gr.addColorStop(0.45, 'rgba(255,200,130,0.35)'); gr.addColorStop(1, 'rgba(255,200,130,0)'); c.fillStyle = gr; c.fillRect(0, 0, w, h); }); return t; })();
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 });
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(5.5, 5.5).rotateX(-Math.PI / 2), poolMat, lamps.length);
  const coneMat = new THREE.MeshBasicMaterial({ color: '#ffd89a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.05, side: THREE.DoubleSide });
  const cone = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 1.9, 16, 1, true), coneMat, lamps.length);
  const m4 = new THREE.Matrix4();
  lamps.forEach(([x, y, z], i) => {
    post.setMatrixAt(i, m4.makeTranslation(x, y + 0.95, z));
    head.setMatrixAt(i, m4.makeTranslation(x, y + 1.95, z));
    pool.setMatrixAt(i, m4.makeTranslation(x, y + 0.02, z));
    cone.setMatrixAt(i, m4.makeTranslation(x, y + 0.95, z));
  });
  post.castShadow = shadows;
  scene.add(post, head, pool, cone);

  // ---- trees: town decoration (cones, rounds, blossoms) and the land's trees, instanced
  const crown = { tree_cone: new THREE.ConeGeometry(0.75, 2.2, 7).translate(0, 1.9, 0), tree_round: new THREE.IcosahedronGeometry(0.9, 0).translate(0, 1.9, 0), tree_blossom: new THREE.IcosahedronGeometry(0.85, 0).translate(0, 1.8, 0) };
  const crownCol = { tree_cone: T.palette.deco.coneA, tree_round: T.palette.deco.leafA, tree_blossom: T.palette.deco.blossomA };
  const treeMeshes = [];
  for (const kind of Object.keys(crown)) {
    const items = T.decoration.items.filter((d) => d[0] === kind);
    const land = kind === 'tree_cone' ? T.land.trees.filter((t) => t[5] < 0.6) : kind === 'tree_round' ? T.land.trees.filter((t) => t[5] >= 0.6) : [];
    const n = items.length + land.length;
    const mesh = new THREE.InstancedMesh(crown[kind], new THREE.MeshLambertMaterial({ color: crownCol[kind] }), n);
    let i = 0;
    for (const [, gx, gy] of items) mesh.setMatrixAt(i++, m4.makeTranslation(sx(gx), hAt(gx, gy), sz(gy)));
    for (const [x, z, s, h] of land) mesh.setMatrixAt(i++, m4.compose(new THREE.Vector3(x, 0.075, z), new THREE.Quaternion(), new THREE.Vector3(s * 1.2, h * 1.3, s * 1.2)));
    mesh.castShadow = shadows;
    scene.add(mesh);
    treeMeshes.push(mesh);
  }

  // ---- the land beyond: a dark disc (the Studio's land radius is 900; the film fogs it out by 260)
  const land = new THREE.Mesh(new THREE.CircleGeometry(420, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#7f9a6c' }));
  land.position.y = 0.0; land.receiveShadow = shadows;
  scene.add(land);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uZen: { value: col('#0a1226') }, uHor: { value: col('#1d2944') } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uZen; uniform vec3 uHor; varying vec3 vP; void main(){ float k = clamp(normalize(vP).y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(uHor, uZen, k), 1.0); }',
  }));
  scene.add(sky);

  // ---- the agent HQ on lot 5 (AgentHq.tsx volumes in the lot's frame; frontage n: v points north)
  const lot = T.agentLots.find((l) => l.id === 'lot_agent_5');
  const hq = T.agentHq;
  const lx = sx(lot.rect[0]) + (lot.rect[2] - 1) / 2, lz = sz(lot.rect[1]) + (lot.rect[3] - 1) / 2;
  const sgn = lot.frontage === 'n' ? -1 : 1; // v (towards the street) in scene z
  const box = (gb, u0, u1, v0, v1, y0, h, c) => { const za = lz + sgn * v0, zb = lz + sgn * v1; gb.box(lx + u0, y0, Math.min(za, zb), lx + u1, y0 + h, Math.max(za, zb), c); };
  const hs = new Geo(), hg = new Geo();
  const { main, upper } = hq;
  box(hs, main.u0 - 0.1, main.u1 + 0.1, main.v0 - 0.1, main.v1 + 0.1, 0.085, 0.18, col(hq.colors.trim));
  box(hs, main.u0, main.u1, main.v0, main.v1, 0.265, main.h - 0.18, col(hq.colors.shell));
  box(hs, upper.u0, upper.u1, upper.v0, upper.v1, main.h + 0.06, upper.h + 0.06, col(hq.colors.shellLight));
  box(hs, main.u0, main.u1, main.v1 - 0.02, main.v1 + 0.04, main.h - 0.32, 0.16, col('#5aa9f5')); // identity band (id1)
  for (let i = 0; i < 5; i++) { const u = main.u0 + 0.7 + i * 1.95; if (Math.abs(u) < 0.6) continue; box(hg, u - 0.7, u + 0.7, main.v1, main.v1 + 0.05, 0.4, 1.55, col(hq.colors.glass)); }
  box(hg, -0.55, 0.55, main.v1, main.v1 + 0.06, 0.18, 1.3, col(hq.colors.glass));
  const hqShellMat = lambert(), hqGlassMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const hqShell = new THREE.Mesh(hs.build(), hqShellMat), hqGlass = new THREE.Mesh(hg.build(), hqGlassMat);
  hqShell.castShadow = shadows;
  const beaconMat = new THREE.MeshBasicMaterial({ color: '#b8f36a', transparent: true });
  const beacon = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.07, 8, 32).rotateX(-Math.PI / 2), beaconMat);
  beacon.position.set(lx + hq.beacon.u, hq.beacon.y, lz + sgn * hq.beacon.v);
  scene.add(hqShell, hqGlass, beacon);

  // ---- residents: one instanced body (a capsule-ish column), coloured by outfit, hidden when inside
  const ev = residentEval(R, T.walkCellsPerMinute);
  const body = new THREE.CylinderGeometry(0.17, 0.21, 0.78, 7).translate(0, 0.39, 0);
  const headG = new THREE.SphereGeometry(0.16, 8, 6).translate(0, 0.92, 0);
  const resGeo = (() => { const g2 = new THREE.BufferGeometry(); const a = body.toNonIndexed(), b = headG.toNonIndexed(); const pos = [...a.attributes.position.array, ...b.attributes.position.array], nor = [...a.attributes.normal.array, ...b.attributes.normal.array]; g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g2.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); return g2; })();
  const people = new THREE.InstancedMesh(resGeo, new THREE.MeshLambertMaterial({ color: '#ffffff' }), ev.count);
  ev.list.forEach((r, i) => people.setColorAt(i, col(r.outfit.top)));
  people.castShadow = shadows;
  scene.add(people);

  // ---- light: the product's sky drives everything (hemisphere, ambient, the moon / sun as key)
  const hemi = new THREE.HemisphereLight('#4d5f96', '#1d1f2e', 0.75);
  const amb = new THREE.AmbientLight('#8ea0d8', 0.4);
  const key = new THREE.DirectionalLight('#9fb2ff', 0.55);
  key.castShadow = shadows;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -62, right: 62, top: 50, bottom: -50, near: 1, far: 400 });
  key.shadow.bias = -0.0006;
  scene.add(hemi, amb, key, key.target);
  scene.fog = new THREE.Fog('#1a233b', 90, 360);

  const pose = {};
  const dummy = new THREE.Object3D();
  return {
    scene, camera: cam, bloom: 0.32, bloomThreshold: 0.86, bloomRadius: 0.5,
    info: { lamps: lamps.length, windows: winGeo.attributes.position.count / 6, residents: ev.count },
    update(t, u, o = {}) {
      const tick = o.tick ?? 1440 + 22 * 60;
      const s = skyAt(T, tick);
      // camera
      const c = o.cam ?? { pos: [120, 110, 120], target: [0, 0, 0], fov: 24 };
      cam.fov = c.fov; cam.updateProjectionMatrix();
      G.lookFrom(cam, c.pos, c.target);
      // sky and light
      sky.material.uniforms.uZen.value.set(s.zenith); sky.material.uniforms.uHor.value.set(s.horizon);
      sky.position.copy(cam.position);
      scene.fog.color.set(s.haze);
      hemi.color.set(s.hemiSky); hemi.groundColor.set(s.hemiGround); hemi.intensity = s.hemiI;
      amb.color.set(s.amb); amb.intensity = s.ambI;
      key.color.set(s.sun); key.intensity = s.sunI;
      key.position.set(s.sunDir[0] * 160, s.sunDir[1] * 160, s.sunDir[2] * 160); key.target.position.set(0, 0, 0);
      // lamps by the clock (or a film reveal: o.lampReveal(i) in 0..1 multiplies)
      const on = lampOn(s.night);
      for (let i = 0; i < lamps.length; i++) {
        const k = on * (o.lampReveal ? o.lampReveal(i, lamps[i]) : 1);
        const sc = Math.max(1e-4, k);
        pool.setMatrixAt(i, m4.compose(new THREE.Vector3(lamps[i][0], lamps[i][1] + 0.02, lamps[i][2]), new THREE.Quaternion(), new THREE.Vector3(sc, 1, sc)));
        cone.setMatrixAt(i, m4.compose(new THREE.Vector3(lamps[i][0], lamps[i][1] + 0.95, lamps[i][2]), new THREE.Quaternion(), new THREE.Vector3(sc, 1, sc)));
      }
      pool.instanceMatrix.needsUpdate = true; cone.instanceMatrix.needsUpdate = true;
      headMat.color.set(T.palette.glow.lamp).multiplyScalar(0.25 + 1.6 * on);
      // windows: lit where the engine says someone is inside, glowing with the night
      const lit = ev.occupied(tick);
      const ca = winGeo.attributes.color;
      const warm = col(T.palette.glow.window).multiplyScalar(0.07 + 1.5 * s.night), dark = col('#46566a').lerp(col('#1c2433'), s.night * 0.85);
      for (const w of windows) { const cc = lit.has(w.id) ? warm : dark; for (let v = w.from * 3; v < (w.from + w.count) * 3; v++) ca.setXYZ(v, cc.r, cc.g, cc.b); }
      ca.needsUpdate = true;
      // the HQ: waiting (unpainted), live (painted, glass lit, beacon lime), offline (painted, dark, beacon grey)
      const state = o.hq ?? 'waiting';
      const show = state !== 'none';
      hqShell.visible = hqGlass.visible = beacon.visible = show;
      const painted = state !== 'waiting';
      // (a material's program depends on vertexColors: flag a recompile only when it changes)
      if (hqShellMat.vertexColors !== painted) { hqShellMat.vertexColors = painted; hqGlassMat.vertexColors = painted; hqShellMat.needsUpdate = hqGlassMat.needsUpdate = true; }
      hqShellMat.color.set(painted ? '#ffffff' : hq.colors.unpaintedShell);
      hqGlassMat.color.set(painted ? '#ffffff' : hq.colors.unpaintedGlass);
      hqGlassMat.emissive.set(state === 'live' ? '#ffd18a' : '#000000').multiplyScalar(state === 'live' ? 0.12 + 0.5 * s.night : 0);
      beaconMat.color.set(state === 'live' ? '#b8f36a' : state === 'offline' ? '#5d626c' : '#b8f36a').multiplyScalar(state === 'live' ? 1.4 : 1);
      beaconMat.opacity = state === 'waiting' ? 0.0 : 0.95;
      // residents at the tick (engine positions), hidden inside buildings
      for (let i = 0; i < ev.count; i++) {
        const p = ev.pose(i, tick, pose);
        if (!p || p.inside) { people.setMatrixAt(i, m4.makeScale(0, 0, 0)); continue; }
        dummy.position.set(sx(p.gx), hAt(Math.round(p.gx), Math.round(p.gy)), sz(p.gy));
        dummy.rotation.set(0, Math.atan2(p.dx, p.dy), 0);
        dummy.scale.setScalar(p.pose === 'sit' ? 0.82 : 1);
        dummy.updateMatrix();
        people.setMatrixAt(i, dummy.matrix);
      }
      people.instanceMatrix.needsUpdate = true;
    },
  };
}
