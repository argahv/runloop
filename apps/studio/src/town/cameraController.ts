/**
 * The town's game camera controller (immersive contract §2.2–2.3): drag to pan
 * (ground-anchored, with inertia), wheel and pinch zoom towards the cursor,
 * free rotation and a limited tilt (right/middle drag, Q E Z X, two-finger
 * twist and vertical drag), WASD and arrows, soft bounds that spring back,
 * and eased moves (quick, cinematic, arcs over long hops) that any input
 * interrupts. Reduced motion: cuts, no inertia, no easing.
 *
 * No React and no three here: TownCamera feeds it the frame, the viewport and
 * the requests, and applies `view` to the PerspectiveCamera; the input hook
 * (input.ts) feeds it pointer, wheel and key events.
 */
import {
  DEG,
  DEFAULT_AZ_DEG,
  DEFAULT_TILT_DEG,
  TILT_MAX_DEG,
  TILT_MIN_DEG,
  angleDelta,
  approach,
  groundHitClamped,
  project,
  quickDuration,
  rubberStep,
  springInto,
  viewOf,
  wheelZoomDelta,
  zoomAt,
  type CamPose,
  type View,
  type Viewport,
} from './cameraMath';
import type { Insets } from './types';

export type Motion = 'quick' | 'cinematic' | 'cut';

interface Tween {
  from: CamPose;
  to: CamPose;
  start: number;
  duration: number;
  ease: (t: number) => number;
  /** log(zoom) at t = 0.4 for an arc (a long hop zooms out to show both ends). */
  mid: number | null;
}

interface Drag {
  id: number;
  mode: 'pan' | 'rotate';
  x0: number;
  y0: number;
  lastX: number;
  lastY: number;
  started: boolean;
  /** The ground point grabbed (pan). */
  gx: number;
  gz: number;
  samples: { t: number; x: number; z: number; az: number }[];
}

interface Gesture {
  /** Centroid, distance and angle of the two fingers at the start. */
  cx0: number;
  cy0: number;
  dist0: number;
  ang0: number;
  ys0: [number, number];
  gx: number;
  gz: number;
  zoom0: number;
  az0: number;
  tilt0: number;
  mode: 'free' | 'tilt';
  rotEngaged: number | null;
}

export interface ControllerHooks {
  /** Viewer input that should break a follow and drop pending moves. */
  onUserInput(): void;
  onInteraction(active: boolean): void;
  onFly(durationMs: number, pan: number): void;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const CINEMATIC_MS = 2200;
const DRAG_THRESHOLD = 4;
const KEY_ROTATE_TAP_MS = 300;
const KEYS_PAN: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export class CameraController {
  pose: CamPose = { x: 0, z: 0, zoom: 10, az: DEFAULT_AZ_DEG * DEG, tilt: DEFAULT_TILT_DEG * DEG };
  view: View;
  width = 1;
  height = 1;
  /** Eased HUD insets (px) and the principal point they give. */
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  goalInsets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  reducedMotion = false;
  keyboard = true;
  /** Soft limits. */
  zoomMin = 4;
  zoomMax = 200;
  boundX = 68;
  boundZ = 56;
  tiltMin = TILT_MIN_DEG * DEG;
  tiltMax = TILT_MAX_DEG * DEG;
  /** A press turned into a drag or gesture: the input hook must not treat its release as a click. */
  consumed = false;
  /** The whole town (0 / Home): set by TownCamera, which knows the town's framing. */
  overview: (() => void) | null = null;

  private tween: Tween | null = null;
  private vel = { x: 0, z: 0, az: 0 };
  private wheel: { goal: number; sx: number; sy: number } | null = null;
  private lastWheelAt = 0;
  private lastAnchor: { sx: number; sy: number } | null = null;
  private drag: Drag | null = null;
  private touches = new Map<number, { x: number; y: number; x0: number; y0: number }>();
  private gesture: Gesture | null = null;
  private keys = new Map<string, number>();
  private keyVel = { x: 0, z: 0 };
  private shift = false;
  private interacting = false;

  constructor(private hooks: ControllerHooks) {
    this.view = viewOf(this.pose, { width: 1, height: 1 });
  }

  setHooks(h: ControllerHooks): void {
    this.hooks = h;
  }

  viewport(): Viewport {
    const i = this.insets;
    return { width: this.width, height: this.height, cx: (i.left + this.width - i.right) / 2, cy: (i.top + this.height - i.bottom) / 2 };
  }

  /** The view for the current pose (recomputed after every change). */
  refresh(): View {
    this.view = viewOf(this.pose, this.viewport());
    return this.view;
  }

  get moving(): boolean {
    return !!(this.tween || this.drag?.started || this.gesture || this.wheel || this.vel.x || this.vel.z || this.vel.az || this.keys.size || this.keyVel.x || this.keyVel.z || this.outOfBounds());
  }

  get tweening(): boolean {
    return this.tween !== null;
  }

  /** Is the viewer dragging, rotating or pinching right now. */
  get active(): boolean {
    return this.interacting;
  }

  private outOfBounds(): boolean {
    const p = this.pose;
    return Math.abs(p.x) > this.boundX + 1e-3 || Math.abs(p.z) > this.boundZ + 1e-3 || p.zoom > this.zoomMax * 1.0005 || p.zoom < this.zoomMin * 0.9995;
  }

  // ── Moves ────────────────────────────────────────────────────────────────

  /** Jump without animation. */
  cut(to: Partial<CamPose>): void {
    this.tween = null;
    this.stopMomentum();
    Object.assign(this.pose, to);
    this.clampTilt();
    this.refresh();
  }

  /** Ease to a pose. Quick moves scale with distance; long hops arc out to show both ends. */
  moveTo(to: Partial<CamPose>, motion: Motion = 'quick', now = performance.now()): void {
    const from = { ...this.pose };
    const goal: CamPose = { ...from, ...to };
    goal.zoom = Math.min(this.zoomMax, Math.max(this.zoomMin, goal.zoom));
    goal.tilt = Math.min(this.tiltMax, Math.max(this.tiltMin, goal.tilt));
    // Turn the short way unless the caller asked for an exact angle change (rotate keeps it).
    if (to.az === undefined) goal.az = from.az;
    this.stopMomentum();
    if (this.reducedMotion || motion === 'cut') {
      this.tween = null;
      Object.assign(this.pose, goal);
      this.refresh();
      return;
    }
    const viewW = this.width / from.zoom;
    const dist = Math.hypot(goal.x - from.x, goal.z - from.z);
    const px = dist * from.zoom + Math.abs(Math.log(goal.zoom / from.zoom)) * 400 + Math.abs(goal.az - from.az) * 300 + Math.abs(goal.tilt - from.tilt) * 300;
    const cinematic = motion === 'cinematic';
    const duration = cinematic ? CINEMATIC_MS : quickDuration(px);
    let mid: number | null = null;
    if (dist > 1.5 * viewW) {
      const both = (this.width * 0.7) / (dist + 6);
      mid = Math.log(Math.max(this.zoomMin * 0.9, Math.min(from.zoom, goal.zoom, both)));
    }
    this.tween = { from, to: goal, start: now, duration, ease: cinematic || mid !== null ? easeInOut : easeOut, mid };
    const s = project(this.view, goal.x, 0, goal.z);
    const pan = Math.max(-1, Math.min(1, (s.x - this.view.cx) / (this.width / 2)));
    this.hooks.onFly(duration, Number.isFinite(pan) ? pan : 0);
  }

  /** Where the current move is going (or the pose when none). */
  destination(): CamPose {
    return this.tween ? { ...this.tween.to } : { ...this.pose };
  }

  stopMove(): void {
    this.tween = null;
  }

  private stopMomentum(): void {
    this.vel.x = this.vel.z = this.vel.az = 0;
    this.wheel = null;
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private userInput(): void {
    this.tween = null;
    this.hooks.onUserInput();
  }

  private setInteracting(v: boolean): void {
    if (v === this.interacting) return;
    this.interacting = v;
    this.hooks.onInteraction(v);
  }

  /** A pointer went down on the town (button: 0 left, 1 middle, 2 right). */
  pointerDown(id: number, x: number, y: number, button: number, touch: boolean, now: number): void {
    this.consumed = false;
    if (touch) {
      this.touches.set(id, { x, y, x0: x, y0: y });
      if (this.touches.size === 2) {
        // A second finger: from a one-finger pan to a two-finger gesture (never a click).
        this.endDrag(now, false);
        this.startGesture();
        this.consumed = true;
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.drag) return;
    const mode = button === 0 ? 'pan' : 'rotate';
    const g = groundHitClamped(this.view, x, y);
    this.drag = { id, mode, x0: x, y0: y, lastX: x, lastY: y, started: false, gx: g.x, gz: g.z, samples: [] };
    // Momentum stops under a finger or a click (a fresh grab).
    this.vel.x = this.vel.z = this.vel.az = 0;
  }

  pointerMove(id: number, x: number, y: number, now: number): void {
    const t = this.touches.get(id);
    if (t) {
      t.x = x;
      t.y = y;
      if (this.gesture) {
        this.updateGesture();
        return;
      }
    }
    const d = this.drag;
    if (!d || d.id !== id) return;
    if (!d.started) {
      if (Math.hypot(x - d.x0, y - d.y0) < DRAG_THRESHOLD) return;
      d.started = true;
      this.consumed = true;
      this.userInput();
      this.stopMomentum();
      this.setInteracting(true);
    }
    if (d.mode === 'pan') {
      const v = this.refresh();
      const g = groundHitClamped(v, x, y);
      this.pose.x = rubberStep(this.pose.x, d.gx - g.x, -this.boundX, this.boundX);
      this.pose.z = rubberStep(this.pose.z, d.gz - g.z, -this.boundZ, this.boundZ);
    } else {
      this.pose.az -= (x - d.lastX) * 0.3 * DEG;
      this.pose.tilt += (y - d.lastY) * 0.2 * DEG;
      this.clampTilt();
    }
    d.lastX = x;
    d.lastY = y;
    d.samples.push({ t: now, x: this.pose.x, z: this.pose.z, az: this.pose.az });
    while (d.samples.length > 2 && now - d.samples[0]!.t > 100) d.samples.shift();
    this.refresh();
  }

  pointerUp(id: number, now: number): void {
    if (this.touches.has(id)) {
      this.touches.delete(id);
      if (this.gesture) {
        this.gesture = null;
        // One finger left: carry on panning with it from where it is.
        const rest = [...this.touches.entries()][0];
        if (rest) {
          const [rid, p] = rest;
          const g = groundHitClamped(this.refresh(), p.x, p.y);
          this.drag = { id: rid, mode: 'pan', x0: p.x, y0: p.y, lastX: p.x, lastY: p.y, started: true, gx: g.x, gz: g.z, samples: [] };
        } else this.setInteracting(false);
        return;
      }
    }
    if (this.drag?.id === id) this.endDrag(now, true);
  }

  /** The pointer is gone (cancel, lost capture): end without momentum. */
  pointerCancel(id: number, now: number): void {
    this.touches.delete(id);
    if (this.gesture && this.touches.size < 2) {
      this.gesture = null;
      this.setInteracting(false);
    }
    if (this.drag?.id === id) this.endDrag(now, false);
  }

  private endDrag(now: number, momentum: boolean): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.started) return;
    if (momentum && !this.reducedMotion && d.samples.length >= 2) {
      // Velocity over the last 80 ms of movement; momentum only when released while still moving (≤ 100 ms after the last move).
      const last = d.samples[d.samples.length - 1]!;
      const s = d.samples.filter((p) => last.t - p.t <= 80);
      if (s.length >= 2 && now - last.t <= 100) {
        const a = s[0]!;
        const b = s[s.length - 1]!;
        const dt = Math.max(0.016, (b.t - a.t) / 1000);
        if (d.mode === 'pan') {
          const cap = (4 * this.width) / this.pose.zoom;
          let vx = (b.x - a.x) / dt;
          let vz = (b.z - a.z) / dt;
          const n = Math.hypot(vx, vz);
          if (n > cap) {
            vx *= cap / n;
            vz *= cap / n;
          }
          this.vel.x = vx;
          this.vel.z = vz;
        } else this.vel.az = angleDelta(a.az, b.az) / dt;
      }
    }
    this.setInteracting(false);
  }

  private fingers(): { cx: number; cy: number; dist: number; ang: number; a: { x: number; y: number; y0: number }; b: { x: number; y: number; y0: number } } | null {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return null;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), ang: Math.atan2(b.y - a.y, b.x - a.x), a, b };
  }

  private startGesture(): void {
    const f = this.fingers();
    if (!f) return;
    for (const t of this.touches.values()) {
      t.x0 = t.x;
      t.y0 = t.y;
    }
    const g = groundHitClamped(this.refresh(), f.cx, f.cy);
    this.gesture = { cx0: f.cx, cy0: f.cy, dist0: f.dist, ang0: f.ang, ys0: [f.a.y, f.b.y], gx: g.x, gz: g.z, zoom0: this.pose.zoom, az0: this.pose.az, tilt0: this.pose.tilt, mode: 'free', rotEngaged: null };
    this.userInput();
    this.stopMomentum();
    this.setInteracting(true);
  }

  private updateGesture(): void {
    const g = this.gesture;
    const f = this.fingers();
    if (!g || !f) return;
    const dyA = f.a.y - g.ys0[0];
    const dyB = f.b.y - g.ys0[1];
    const pinch = Math.abs(f.dist / g.dist0 - 1);
    // Both fingers moving the same vertical way with little pinch: tilt (locks for the gesture).
    if (g.mode === 'free' && g.rotEngaged === null && Math.sign(dyA) === Math.sign(dyB) && Math.abs(dyA) > 12 && Math.abs(dyB) > 12 && pinch < 0.1) g.mode = 'tilt';
    if (g.mode === 'tilt') {
      this.pose.tilt = g.tilt0 + (f.cy - g.cy0) * 0.2 * DEG;
      this.clampTilt();
      this.refresh();
      return;
    }
    const zoom = Math.max(this.zoomMin / 1.1, Math.min(this.zoomMax * 1.1, g.zoom0 * (f.dist / g.dist0)));
    const dAng = angleDelta(g.ang0, f.ang);
    if (g.rotEngaged === null && Math.abs(dAng) > 6 * DEG) g.rotEngaged = Math.sign(dAng) * 6 * DEG;
    this.pose.zoom = zoom;
    if (g.rotEngaged !== null) this.pose.az = g.az0 + (dAng - g.rotEngaged);
    // Keep the ground point under the centroid where the fingers are (pan, zoom and twist about it).
    const v = this.refresh();
    const p = groundHitClamped(v, f.cx, f.cy);
    this.pose.x = rubberStep(this.pose.x, g.gx - p.x, -this.boundX, this.boundX);
    this.pose.z = rubberStep(this.pose.z, g.gz - p.z, -this.boundZ, this.boundZ);
    this.refresh();
  }

  /** A wheel step: zoom at the cursor (pinch on trackpads arrives as ctrl+wheel), or rotate with shift. */
  wheelInput(px: number, sx: number, sy: number, mods: { ctrl: boolean; shift: boolean }, now: number): void {
    this.userInput();
    this.vel.x = this.vel.z = 0;
    if (mods.shift && !mods.ctrl) {
      this.pose.az += px * 0.25 * DEG;
      this.refresh();
      return;
    }
    const delta = wheelZoomDelta(px, mods.ctrl);
    this.zoomBy(delta, sx, sy);
    this.lastWheelAt = now;
  }

  /** Change log(zoom) by `delta`, anchored at a pixel (eased unless reduced motion). */
  zoomBy(delta: number, sx: number, sy: number): void {
    const cur = this.wheel?.goal ?? Math.log(this.pose.zoom);
    const lo = Math.log(this.zoomMin);
    const hi = Math.log(this.zoomMax);
    const band = Math.log(1.1);
    let goal = rubberStep(cur, delta, lo, hi);
    goal = Math.max(lo - band, Math.min(hi + band, goal));
    this.wheel = { goal, sx, sy };
    this.lastAnchor = { sx, sy };
    if (this.reducedMotion) this.applyWheel(1);
  }

  private applyWheel(dt: number): void {
    const w = this.wheel;
    if (!w) return;
    const cur = Math.log(this.pose.zoom);
    const next = this.reducedMotion ? w.goal : approach(cur, w.goal, 16, dt);
    this.zoomAnchored(Math.exp(next), w.sx, w.sy);
    if (Math.abs(next - w.goal) < 0.0015) {
      this.zoomAnchored(Math.exp(w.goal), w.sx, w.sy);
      this.wheel = null;
    }
  }

  private zoomAnchored(zoom: number, sx: number, sy: number): void {
    const t = zoomAt(this.pose, this.viewport(), sx, sy, zoom);
    this.pose.x = t.x;
    this.pose.z = t.z;
    this.pose.zoom = zoom;
    this.refresh();
  }

  /** A key went down. Returns true when the camera used it (the caller prevents the default). */
  keyDown(code: string, shift: boolean, repeat: boolean, now: number): boolean {
    if (!this.keyboard) return false;
    this.shift = shift;
    if (KEYS_PAN[code] || code === 'KeyZ' || code === 'KeyX') {
      if (!repeat) {
        this.userInput();
        this.vel.x = this.vel.z = this.vel.az = 0;
      }
      this.keys.set(code, this.keys.get(code) ?? now);
      this.shift = shift;
      return true;
    }
    if (code === 'KeyQ' || code === 'KeyE') {
      if (!repeat) {
        this.userInput();
        this.keys.set(code, now);
        const dir = code === 'KeyQ' ? -1 : 1;
        const base = this.destination();
        this.moveTo({ az: base.az + dir * 45 * DEG }, 'quick', now);
        if (this.tween) this.tween.duration = KEY_ROTATE_TAP_MS;
      }
      return true;
    }
    if (code === 'Equal' || code === 'NumpadAdd' || code === 'Minus' || code === 'NumpadSubtract') {
      this.userInput();
      const v = this.view;
      this.zoomBy((code === 'Equal' || code === 'NumpadAdd' ? 1 : -1) * Math.log(1.3), v.cx, v.cy);
      return true;
    }
    if (code === 'Digit0' || code === 'Numpad0' || code === 'Home') {
      this.userInput();
      this.overview?.();
      return true;
    }
    if (code === 'KeyR') {
      this.userInput();
      this.moveTo({ az: this.pose.az + angleDelta(this.pose.az, DEFAULT_AZ_DEG * DEG), tilt: Math.max(this.tiltMin, DEFAULT_TILT_DEG * DEG) }, 'quick', now);
      return true;
    }
    return false;
  }

  keyUp(code: string, shift: boolean): void {
    this.keys.delete(code);
    this.shift = shift;
  }

  /** Window lost focus: release every key. */
  releaseKeys(): void {
    this.keys.clear();
  }

  // ── Per frame ────────────────────────────────────────────────────────────

  private clampTilt(): void {
    this.pose.tilt = Math.min(this.tiltMax, Math.max(this.tiltMin, this.pose.tilt));
  }

  /**
   * Advance one frame: the move in progress, or held keys, wheel easing,
   * momentum and the springs back inside the soft bounds. `follow` pulls the
   * target towards a point (k = 5/s) unless the viewer is moving the camera.
   */
  update(dt: number, now: number, follow: { x: number; z: number } | null): void {
    dt = Math.min(0.1, Math.max(0, dt));
    const p = this.pose;
    const tw = this.tween;
    if (tw) {
      if (follow) {
        tw.to.x = follow.x;
        tw.to.z = follow.z;
      }
      const raw = tw.duration <= 0 ? 1 : Math.min(1, (now - tw.start) / tw.duration);
      const k = tw.ease(raw);
      p.x = tw.from.x + (tw.to.x - tw.from.x) * k;
      p.z = tw.from.z + (tw.to.z - tw.from.z) * k;
      p.az = tw.from.az + (tw.to.az - tw.from.az) * k;
      p.tilt = tw.from.tilt + (tw.to.tilt - tw.from.tilt) * k;
      const lf = Math.log(tw.from.zoom);
      const lt = Math.log(tw.to.zoom);
      if (tw.mid !== null) p.zoom = Math.exp(raw < 0.4 ? lf + (tw.mid - lf) * easeInOut(raw / 0.4) : tw.mid + (lt - tw.mid) * easeInOut((raw - 0.4) / 0.6));
      else p.zoom = Math.exp(lf + (lt - lf) * k);
      if (raw >= 1) this.tween = null;
      this.clampTilt();
      this.refresh();
      return;
    }

    // Held keys: pan (screen-relative, 1 view height per second, Shift ×2.5, 120 ms ramp), turn and tilt.
    let fx = 0;
    let fz = 0;
    for (const code of this.keys.keys()) {
      const d = KEYS_PAN[code];
      if (d) {
        fx += d[0];
        fz += d[1];
      }
    }
    const speed = (this.height / p.zoom) * (this.shift ? 2.5 : 1);
    const n = Math.hypot(fx, fz) || 1;
    // Screen right and screen forward on the ground.
    const rx = Math.cos(p.az);
    const rz = -Math.sin(p.az);
    const gx = -Math.sin(p.az);
    const gz = -Math.cos(p.az);
    const goalX = ((fx * rx + fz * gx) / n) * speed;
    const goalZ = ((fx * rz + fz * gz) / n) * speed;
    const ramp = this.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.12);
    this.keyVel.x += (goalX - this.keyVel.x) * ramp;
    this.keyVel.z += (goalZ - this.keyVel.z) * ramp;
    if (Math.hypot(this.keyVel.x, this.keyVel.z) < 0.01 * speed && !fx && !fz) this.keyVel.x = this.keyVel.z = 0;
    p.x = rubberStep(p.x, this.keyVel.x * dt, -this.boundX, this.boundX);
    p.z = rubberStep(p.z, this.keyVel.z * dt, -this.boundZ, this.boundZ);
    for (const code of ['KeyQ', 'KeyE'] as const) {
      const at = this.keys.get(code);
      if (at !== undefined && now - at > KEY_ROTATE_TAP_MS) p.az += (code === 'KeyQ' ? -1 : 1) * 90 * DEG * dt;
    }
    if (this.keys.has('KeyZ')) p.tilt -= 30 * DEG * dt;
    if (this.keys.has('KeyX')) p.tilt += 30 * DEG * dt;
    this.clampTilt();

    // Wheel zoom easing.
    if (this.wheel) this.applyWheel(dt);

    // Momentum.
    const dragging = !!this.drag?.started || !!this.gesture;
    if (!dragging) {
      if (this.vel.x || this.vel.z) {
        p.x += this.vel.x * dt;
        p.z += this.vel.z * dt;
        if (Math.abs(p.x) > this.boundX) this.vel.x = 0;
        if (Math.abs(p.z) > this.boundZ) this.vel.z = 0;
        const decay = Math.exp(-6 * dt);
        this.vel.x *= decay;
        this.vel.z *= decay;
        if (Math.hypot(this.vel.x, this.vel.z) < (0.02 * this.width) / p.zoom) this.vel.x = this.vel.z = 0;
      }
      if (this.vel.az) {
        p.az += this.vel.az * dt;
        this.vel.az *= Math.exp(-7 * dt);
        if (Math.abs(this.vel.az) < 0.02) this.vel.az = 0;
      }
      // Springs back inside the soft bounds (cut under reduced motion).
      const tau = this.reducedMotion ? 1e-6 : 0.2;
      p.x = springInto(p.x, -this.boundX, this.boundX, tau, dt);
      p.z = springInto(p.z, -this.boundZ, this.boundZ, tau, dt);
      if (!this.wheel && (p.zoom > this.zoomMax || p.zoom < this.zoomMin)) {
        const lz = springInto(Math.log(p.zoom), Math.log(this.zoomMin), Math.log(this.zoomMax), this.reducedMotion ? 1e-6 : 0.12, dt);
        const a = this.lastAnchor ?? { sx: this.view.cx, sy: this.view.cy };
        this.zoomAnchored(Math.exp(lz), a.sx, a.sy);
      }
    }

    // Follow: the target eases to the entity (no viewer input in progress).
    if (follow && !dragging && !this.keyVel.x && !this.keyVel.z) {
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-5 * dt);
      p.x += (follow.x - p.x) * k;
      p.z += (follow.z - p.z) * k;
    }
    this.refresh();
  }

  /** Ease the HUD insets (the view centre slides with an opening sheet; cut under reduced motion). */
  easeInsets(dt: number): boolean {
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-10 * Math.min(0.1, dt));
    let changed = false;
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const g = this.goalInsets[side];
      const c = this.insets[side];
      if (c === g) continue;
      const next = Math.abs(g - c) < 0.5 ? g : c + (g - c) * k;
      this.insets[side] = next;
      changed = true;
    }
    return changed;
  }
}
