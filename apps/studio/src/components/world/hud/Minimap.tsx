'use client';
/**
 * The minimap (contract §1.1 H, §5.3): the town north-up on a 2D canvas, the
 * view's footprint, real agents as hue squares with a status glyph (live
 * ring, waiting hollow, offline slash, needs-you triangle) and rings on
 * unresolved alerts. Click to go there, drag to pan, wheel to zoom. Redrawn
 * at most 8 times a second. The canvas is decorative for assistive tech: the
 * Map (M) and List (L) buttons are its 2D routes. Decorative ambience is
 * never drawn here.
 */
import type { AgentPresence } from '@runloop-world/events';
import type { CompiledTown } from '@runloop-world/town';
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { TownApi } from '../../../town/types';
import { useWorld, useWorldStore } from '../../../world/context';
import { DEFAULT_AZ, DEFAULT_TILT } from '../../../world/link';
import { Icon } from '../../../ui/Icon';
import { Kbd } from '../../../ui/Kbd';
import { AREA_FILL, MAP_COLORS as C } from '../WorldMap';
import styles from './hud.module.css';
import { approxFootprint, gridToMini, mapToMini, miniToGrid, miniTransform, type MiniTransform } from './minimapMath';
import { uiSound } from './sound';

const FRAME_MS = 125;

/** The town drawn once (ground, districts, areas, roads, buildings, lots). */
function drawBase(town: CompiledTown, w: number, h: number, dpr: number, t: MiniTransform): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const rect = (x: number, y: number, rw: number, rh: number, fill: string) => {
    const p = mapToMini(t, x, y);
    g.fillStyle = fill;
    g.fillRect(p.x, p.y, rw * t.scale, rh * t.scale);
  };
  const def = town.def;
  rect(-3, -3, town.width + 6, town.height + 6, '#7f9a69');
  rect(0, 0, town.width, town.height, C.grass);
  for (const d of def.districts) for (const r of d.rects) rect(r[0], r[1], r[2], r[3], d.ground);
  for (const a of def.areas) rect(a.rect[0], a.rect[1], a.rect[2], a.rect[3], AREA_FILL[a.kind] ?? C.plaza);
  for (const r of def.roads) rect(r.rect[0], r.rect[1], r.rect[2], r.rect[3], C.asphalt);
  for (const b of town.buildings) {
    const [x, y, bw, bh] = b.def.footprint;
    rect(x, y, bw, bh, b.def.palette.roof);
  }
  g.strokeStyle = 'rgba(232,235,240,0.55)';
  g.lineWidth = 1;
  g.setLineDash([2, 2]);
  for (const l of town.agentLots) {
    const p = mapToMini(t, l.rect[0] + 0.5, l.rect[1] + 0.5);
    g.strokeRect(p.x, p.y, (l.rect[2] - 1) * t.scale, (l.rect[3] - 1) * t.scale);
  }
  return c;
}

/** Where the view's north is on screen (radians clockwise from up), from two projected cells. */
function northAngle(api: TownApi | null, cam: { x: number; z: number }): number | null {
  if (!api) return null;
  const a = api.projectCell(cam.x, cam.z);
  const b = api.projectCell(cam.x, cam.z - 4);
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return null;
  return Math.atan2(b.x - a.x, -(b.y - a.y));
}

export default function Minimap({ api, w, h, onOpenMap, onOpenList, mapOpen, listOpen }: { api: TownApi | null; w: number; h: number; onOpenMap: () => void; onOpenList: () => void; mapOpen: boolean; listOpen: boolean }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const canvas = useRef<HTMLCanvasElement>(null);
  const needle = useRef<HTMLSpanElement>(null);
  const t = useMemo(() => (town ? miniTransform(town.width, town.height, w, h, 8) : null), [town, w, h]);
  const base = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ id: number; moved: boolean; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !town || !t) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    base.current = drawBase(town, w, h, dpr, t);
    const g = el.getContext('2d')!;
    let last = 0;
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      last = now;
      const s = store.getState();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, el.width, el.height);
      if (base.current) g.drawImage(base.current, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cam = api?.getCamera() ?? null;
      const target = cam ?? s.cam;
      // The view: footprint from the renderer, else a box around the linked camera.
      const fp = cam?.footprint?.length ? cam.footprint : target ? approxFootprint(target.x, target.z, target.zoom, window.innerWidth, window.innerHeight) : null;
      if (fp) {
        g.beginPath();
        fp.forEach(([x, z], i) => {
          const p = gridToMini(t, x, z);
          if (i === 0) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
        });
        g.closePath();
        g.fillStyle = 'rgba(232,235,240,0.16)';
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = 1.5;
        g.setLineDash([]);
        g.stroke();
      }
      // Alerts: unresolved critical and attention items about agents or buildings.
      const alerts = new Map<string, 'critical' | 'attention'>();
      for (const it of s.attention) {
        if (it.resolved || (it.severity !== 'critical' && it.severity !== 'attention')) continue;
        const r = it.refs[0];
        if (r && (r.kind === 'agent' || r.kind === 'building')) alerts.set(`${r.kind}:${r.id}`, it.severity === 'critical' || alerts.get(`${r.kind}:${r.id}`) === 'critical' ? 'critical' : 'attention');
      }
      for (const [key, sev] of alerts) {
        const [kind, id] = key.split(':') as ['agent' | 'building', string];
        const box = kind === 'agent' ? agentBox(town, s.snapshot?.agents ?? [], id) : town.buildingById.get(id)?.def.footprint;
        if (!box) continue;
        const p = mapToMini(t, box[0] + box[2] / 2, box[1] + box[3] / 2);
        g.beginPath();
        g.arc(p.x, p.y, Math.max(7, (Math.max(box[2], box[3]) * t.scale) / 2 + 3), 0, Math.PI * 2);
        g.strokeStyle = sev === 'critical' ? '#ff6b76' : '#f5b84b';
        g.lineWidth = 2;
        g.stroke();
      }
      for (const a of s.snapshot?.agents ?? []) drawAgent(g, t, town, a, alerts.has(`agent:${a.agentId}`));
      // Camera target.
      if (target) {
        const p = gridToMini(t, target.x, target.z);
        g.beginPath();
        g.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        g.fillStyle = '#ffffff';
        g.fill();
      }
      const angle = cam ? northAngle(api, cam) : null;
      if (needle.current) needle.current.style.transform = `rotate(${angle ?? 0}rad)`;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [api, store, town, t, w, h]);

  const toGrid = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return t ? miniToGrid(t, e.clientX - r.left, e.clientY - r.top) : null;
  };
  const goto = (p: { x: number; z: number } | null, motion: 'quick' | 'cut') => {
    if (p) store.getState().requestCamera('goto', null, motion, { point: p });
  };
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    drag.current = { id: e.pointerId, moved: false, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    if (d.moved) goto(toGrid(e), 'cut');
  };
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      uiSound('select');
      goto(toGrid(e), 'quick');
    }
  };
  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    const cam = api?.getCamera() ?? store.getState().cam;
    if (!cam) return;
    const k = Math.exp(-Math.max(-0.35, Math.min(0.35, e.deltaY * 0.0016)));
    store.getState().requestCamera('cam', null, 'cut', { cam: { x: cam.x, z: cam.z, zoom: cam.zoom * k, az: cam.az ?? DEFAULT_AZ, tilt: cam.tilt ?? DEFAULT_TILT } });
  };
  const resetNorth = () => {
    const cam = api?.getCamera() ?? store.getState().cam;
    uiSound('toggle');
    if (cam) store.getState().requestCamera('cam', null, 'quick', { cam: { x: cam.x, z: cam.z, zoom: cam.zoom, az: DEFAULT_AZ, tilt: cam.tilt ?? DEFAULT_TILT } });
  };

  return (
    <section className={styles.minimap} aria-label="Minimap" data-hud-fade style={{ width: w }}>
      <div className={styles.miniHead}>
        <button type="button" className={styles.miniBtn} aria-pressed={mapOpen} aria-keyshortcuts="M" onClick={onOpenMap} onPointerEnter={() => uiSound('hover')}>
          <Icon name="map" size={13} />
          Map <Kbd keys={['M']} />
        </button>
        <button type="button" className={styles.miniBtn} aria-pressed={listOpen} aria-keyshortcuts="L" onClick={onOpenList} onPointerEnter={() => uiSound('hover')}>
          <Icon name="table" size={13} />
          List <Kbd keys={['L']} />
        </button>
        <button type="button" className={styles.compass} aria-label="Face the default direction (north-west up)" title="Reset the view's direction" onClick={resetNorth}>
          <span ref={needle} className={styles.needle} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
              <path d="M12 4.5l3 7.5h-6z" fill="currentColor" />
              <path d="M12 19.5l3-7.5h-6z" fill="currentColor" fillOpacity="0.35" />
            </svg>
            <span className={styles.compassN}>N</span>
          </span>
        </button>
      </div>
      <canvas
        ref={canvas}
        className={styles.miniCanvas}
        style={{ width: w, height: h }}
        aria-hidden="true"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (drag.current = null)}
        onWheel={onWheel}
      />
    </section>
  );
}

function agentBox(town: CompiledTown, agents: readonly AgentPresence[], id: string) {
  const a = agents.find((x) => x.agentId === id);
  return a ? town.lotById.get(a.lotId)?.rect : undefined;
}

/** A hue square with its status glyph: live ring, waiting hollow, offline slash, needs-you triangle. */
function drawAgent(g: CanvasRenderingContext2D, t: MiniTransform, town: CompiledTown, a: AgentPresence, alert: boolean) {
  const lot = town.lotById.get(a.lotId);
  if (!lot) return;
  const [x, y, w, h] = lot.rect;
  const c = mapToMini(t, x + w / 2, y + h / 2);
  const s = Math.max(7, Math.min(w, h) * t.scale * 0.55);
  const waiting = a.health === 'awaiting_first_event' || a.health === 'not_connected';
  g.setLineDash([]);
  if (waiting) {
    g.strokeStyle = a.hue;
    g.lineWidth = 2;
    g.strokeRect(c.x - s / 2, c.y - s / 2, s, s);
  } else {
    g.fillStyle = a.hue;
    g.fillRect(c.x - s / 2, c.y - s / 2, s, s);
  }
  g.lineWidth = 1.5;
  if (a.health === 'live') {
    g.beginPath();
    g.arc(c.x, c.y, s * 0.9, 0, Math.PI * 2);
    g.strokeStyle = '#ffffff';
    g.stroke();
  } else if (a.health === 'offline') {
    g.beginPath();
    g.moveTo(c.x - s / 2, c.y + s / 2);
    g.lineTo(c.x + s / 2, c.y - s / 2);
    g.strokeStyle = '#101114';
    g.stroke();
  }
  if (alert || a.attention !== 'none') {
    const ty = c.y - s / 2 - 3;
    g.beginPath();
    g.moveTo(c.x, ty - 7);
    g.lineTo(c.x + 5, ty + 1);
    g.lineTo(c.x - 5, ty + 1);
    g.closePath();
    g.fillStyle = '#f5b84b';
    g.fill();
    g.strokeStyle = '#101114';
    g.lineWidth = 1;
    g.stroke();
  }
}
