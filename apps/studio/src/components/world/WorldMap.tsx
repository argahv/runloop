'use client';
import { formatEntityRef, type EntityRef, type ResidentState } from '@runloop-world/events';
import type { CompiledTown, Rect } from '@runloop-world/town';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useWorld, useWorldStore } from '../../world/context';
import { tickNow, walkPosition } from '../../world/interpolate';
import { healthView } from '../../world/selectors';
import { focusOf } from '../../world/store';
import styles from './WorldMap.module.css';

/** Town colours (the same warm palette as the 3D town; the theme never changes the town). */
const C = {
  grass: '#a7c08b',
  asphalt: '#646a74',
  sidewalk: '#e2d8c6',
  crosswalk: '#f3eee2',
  plaza: '#e9dfcb',
  path: '#d6c39b',
  park: '#9bbb7e',
  garden: '#9a7656',
  water: '#6aa6c6',
  landmark: '#d2c6af',
  landmarkLine: '#a89a7f',
  hqShell: '#2a2d34',
  hqTrim: '#1b1d22',
} as const;

const AREA_FILL: Record<string, string> = { plaza: C.plaza, path: C.path, park: C.park, garden: C.garden, water: C.water };

type Box = [number, number, number, number];

/** Pixels the floating top bar and the ticker cover on the stage. */
const STAGE_INSET_TOP = 84;
const STAGE_INSET_BOTTOM = 64;

/** Where a resident is drawn on the map (null = inside a building). */
export function residentMapPos(town: CompiledTown, r: ResidentState, tick: number): { x: number; y: number; walking: boolean } | null {
  if (r.motion) {
    const p = walkPosition(r.motion, tick, town.def.walkCellsPerMinute);
    return { x: p.x + 0.5, y: p.y + 0.5, walking: p.walking };
  }
  if (r.place.kind === 'building' || !r.place.spotId) return null;
  const spot = town.spotById.get(r.place.spotId);
  if (!spot) return null;
  const i = r.slotId ? Number(r.slotId.slice(r.slotId.indexOf('#') + 1)) : 0;
  const cell = spot.cellIndex[i] ?? spot.cellIndex[0]!;
  return { x: (cell % town.width) + 0.5, y: Math.floor(cell / town.width) + 0.5, walking: false };
}

/** The map box (cells) of an entity, for focusing. */
export function entityBox(town: CompiledTown, ref: EntityRef, residents: readonly ResidentState[], agentLot: (agentId: string) => string | null, tick: number): Box | null {
  const pad = (r: Rect, m: number): Box => [r[0] - m, r[1] - m, r[2] + 2 * m, r[3] + 2 * m];
  switch (ref.kind) {
    case 'building': {
      const b = town.buildingById.get(ref.id);
      if (b) return pad(b.def.footprint, 14);
      const lot = town.agentLots.find((l) => l.buildingId === ref.id);
      return lot ? pad(lot.rect, 12) : null;
    }
    case 'agent': {
      const lotId = agentLot(ref.id);
      const lot = lotId ? town.lotById.get(lotId) : undefined;
      return lot ? pad(lot.rect, 12) : null;
    }
    case 'lot': {
      const lot = town.lotById.get(ref.id);
      return lot ? pad(lot.rect, 12) : null;
    }
    case 'spot': {
      const s = town.spotById.get(ref.id);
      if (!s) return null;
      const xs = s.def.cells.map((c) => c[0]);
      const ys = s.def.cells.map((c) => c[1]);
      return [Math.min(...xs) - 14, Math.min(...ys) - 12, Math.max(...xs) - Math.min(...xs) + 29, Math.max(...ys) - Math.min(...ys) + 25];
    }
    case 'district': {
      const d = town.def.districts.find((x) => x.id === ref.id);
      if (!d) return null;
      const x0 = Math.min(...d.rects.map((r) => r[0]));
      const y0 = Math.min(...d.rects.map((r) => r[1]));
      const x1 = Math.max(...d.rects.map((r) => r[0] + r[2]));
      const y1 = Math.max(...d.rects.map((r) => r[1] + r[3]));
      return [x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4];
    }
    case 'resident': {
      const r = residents.find((x) => x.id === ref.id);
      if (!r) return null;
      const p = residentMapPos(town, r, tick);
      if (p) return [p.x - 16, p.y - 11, 32, 22];
      const home = r.place.kind === 'building' ? town.buildingById.get(r.place.buildingId) : null;
      return home ? pad(home.def.footprint, 14) : null;
    }
  }
}

/** Fit `box` to the aspect of the viewport (so focusing never distorts). */
function fitAspect(box: Box, aspect: number): Box {
  const [x, y, w, h] = box;
  if (w / h > aspect) {
    const nh = w / aspect;
    return [x, y - (nh - h) / 2, w, nh];
  }
  const nw = h * aspect;
  return [x - (nw - w) / 2, y, nw, h];
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * The town as a 2D map (UX §7): districts, roads, lots and buildings, with
 * residents as dots refreshed every second. It is the view on phones and
 * without WebGL, and the Map overlay (M). A click opens the entity's panel;
 * camera requests (focus, enter) pan and zoom it, quickly or as a cut with
 * reduced motion; any wheel or drag interrupts a move.
 */
export default function WorldMap({ variant = 'stage' }: { variant?: 'stage' | 'overlay' }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const rev = useWorld((s) => s.rev);
  const snapshot = useWorld((s) => s.snapshot);
  const focus = useWorld((s) => focusOf(s));
  const follow = useWorld((s) => s.follow);
  const mode = useWorld((s) => s.mode);
  const camera = useWorld((s) => s.camera);
  const reducedMotion = useWorld((s) => s.reducedMotion);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [view, setView] = useState<Box | null>(null);
  const anim = useRef<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Resident dots move once a second (UX §7); reduced motion steps without easing.
  const [tick, setTick] = useState(() => tickNow(store.getState().clock, Date.now()));
  useEffect(() => {
    const id = setInterval(() => setTick(tickNow(store.getState().clock, Date.now())), reducedMotion ? 500 : 1000);
    return () => clearInterval(id);
  }, [store, reducedMotion]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: Math.max(1, e.contentRect.width), h: Math.max(1, e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const aspect = size.w / size.h;
  // The whole town, framed inside the part of the stage the floating chrome leaves free.
  const full = useMemo<Box | null>(() => {
    if (!town) return null;
    const [top, bottom] = variant === 'stage' ? [STAGE_INSET_TOP, STAGE_INSET_BOTTOM] : [0, 0];
    const freeH = Math.max(1, size.h - top - bottom);
    const inner = fitAspect([-1, -1, town.width + 2, town.height + 2], size.w / freeH);
    const perPx = inner[3] / freeH;
    return [inner[0], inner[1] - top * perPx, inner[2], inner[3] + (top + bottom) * perPx];
  }, [town, size, variant]);
  const box = view ? fitAspect(view, aspect) : full;

  const cancel = useCallback(() => {
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    anim.current = null;
  }, []);

  const moveTo = useCallback(
    (target: Box, motion: 'quick' | 'cinematic' | 'cut') => {
      cancel();
      const from = view ?? full;
      if (!from || motion === 'cut') {
        setView(target);
        return;
      }
      const dur = motion === 'cinematic' ? 1800 : 550;
      const t0 = performance.now();
      const step = (t: number) => {
        const k = ease(Math.min(1, (t - t0) / dur));
        setView([0, 1, 2, 3].map((i) => from[i]! + (target[i]! - from[i]!) * k) as Box);
        anim.current = k < 1 ? requestAnimationFrame(step) : null;
      };
      anim.current = requestAnimationFrame(step);
    },
    [cancel, view, full],
  );

  // Camera requests from panels, ⌘K and the directory. An entity that is not in the
  // snapshot yet (an agent whose housing event is on its way) is retried for 3 s.
  const lastCamera = useRef<number>(0);
  const firstTry = useRef<{ id: number; at: number }>({ id: 0, at: 0 });
  useEffect(() => {
    if (!camera || !town || !snapshot || camera.id === lastCamera.current) return;
    if (camera.kind === 'overview' || camera.kind === 'exit' || !camera.ref) {
      lastCamera.current = camera.id;
      if (camera.kind === 'overview' && full) moveTo(full, camera.motion);
      return;
    }
    if (firstTry.current.id !== camera.id) firstTry.current = { id: camera.id, at: Date.now() };
    const agentLot = (id: string) => snapshot.agents.find((a) => a.agentId === id)?.lotId ?? null;
    const target = entityBox(town, camera.ref, snapshot.residents, agentLot, tickNow(store.getState().clock, Date.now()));
    if (target) {
      lastCamera.current = camera.id;
      moveTo(camera.kind === 'enter' ? shrink(target, 0.6) : target, camera.motion);
    } else if (Date.now() - firstTry.current.at > 3000) lastCamera.current = camera.id;
  }, [camera, town, snapshot, rev, store, full, moveTo]);

  // Follow keeps the followed resident in the middle.
  useEffect(() => {
    if (!follow || follow.kind !== 'resident' || !town || !snapshot) return;
    const r = snapshot.residents.find((x) => x.id === follow.id);
    const p = r ? residentMapPos(town, r, tick) : null;
    if (!p) return;
    const cur = view ?? full;
    if (!cur) return;
    setView([p.x - cur[2] / 2, p.y - cur[3] / 2, cur[2], cur[3]]);
  }, [tick, follow]);

  const drag = useRef<{ x: number; y: number; box: Box; moved: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!box) return;
    cancel();
    drag.current = { x: e.clientX, y: e.clientY, box, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.x) / size.w) * d.box[2];
    const dy = ((e.clientY - d.y) / size.h) * d.box[3];
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
    if (d.moved) {
      (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
      setView([d.box[0] - dx, d.box[1] - dy, d.box[2], d.box[3]]);
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    if (!box || !town) return;
    cancel();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = box[0] + ((e.clientX - rect.left) / rect.width) * box[2];
    const py = box[1] + ((e.clientY - rect.top) / rect.height) * box[3];
    const k = Math.min(1.6, Math.max(0.6, Math.exp(e.deltaY * 0.0015)));
    const w = Math.min(town.width * 1.6, Math.max(12, box[2] * k));
    const h = w / aspect;
    setView([px - ((px - box[0]) / box[2]) * w, py - ((py - box[1]) / box[3]) * h, w, h]);
  };

  const select = (ref: EntityRef) => {
    if (drag.current?.moved) return;
    store.getState().focusEntity(ref, { camera: false });
  };

  if (!town || !box) {
    return <div className={styles.loading}>{town ? null : 'Loading the town…'}</div>;
  }
  const def = town.def;
  const zoomedIn = box[2] < 56;
  // Map units (cells) per screen pixel: labels and dots keep a constant size on screen.
  const px = box[2] / size.w;
  const fs = (n: number) => ({ fontSize: n * px });
  const dotR = Math.min(0.55, Math.max(0.28, 4.5 * px));
  const focusKey = focus ? formatEntityRef(focus) : null;
  const residents = snapshot?.residents ?? [];
  const inside = new Map<string, number>();
  for (const b of snapshot?.buildings ?? []) inside.set(b.id, b.occupancy);
  const takenLots = new Set(snapshot?.agents.map((a) => a.lotId) ?? []);

  return (
    <div className={styles.wrap} data-variant={variant}>
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={box.join(' ')}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Map of ${def.name}. Choose people and places by keyboard in the directory (L) or with ⌘K.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="rl-xing" width="0.5" height="0.5" patternUnits="userSpaceOnUse">
            <rect width="0.5" height="0.5" fill={C.asphalt} />
            <rect width="0.25" height="0.5" fill={C.crosswalk} />
          </pattern>
        </defs>
        <rect x={-200} y={-200} width={town.width + 400} height={town.height + 400} className={styles.backdrop} />
        <rect x={0} y={0} width={town.width} height={town.height} fill={C.grass} />
        {def.districts.map((d) => d.rects.map((r, i) => <rect key={`${d.id}${i}`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={d.ground} />))}
        {def.areas.map((a) => (
          <rect key={a.id} x={a.rect[0]} y={a.rect[1]} width={a.rect[2]} height={a.rect[3]} fill={AREA_FILL[a.kind] ?? C.plaza} rx={a.kind === 'water' ? 1.2 : 0} />
        ))}
        {def.roads.map((r) => (
          <g key={r.id}>
            {r.sidewalks.map((side) => {
              const [x, y, w, h] = r.rect;
              const s: Box = side === 's' ? [x, y + h, w, 1] : side === 'n' ? [x, y - 1, w, 1] : side === 'e' ? [x + w, y, 1, h] : [x - 1, y, 1, h];
              return <rect key={side} x={s[0]} y={s[1]} width={s[2]} height={s[3]} fill={C.sidewalk} />;
            })}
          </g>
        ))}
        {def.roads.map((r) => (
          <rect key={r.id} x={r.rect[0]} y={r.rect[1]} width={r.rect[2]} height={r.rect[3]} fill={C.asphalt} />
        ))}
        {def.crossings.map((x) => (
          <rect key={x.id} x={x.rect[0]} y={x.rect[1]} width={x.rect[2]} height={x.rect[3]} fill="url(#rl-xing)" />
        ))}
        {def.landmarks.map((l) => (
          <rect key={l.id} x={l.rect[0]} y={l.rect[1]} width={l.rect[2]} height={l.rect[3]} fill={C.landmark} stroke={C.landmarkLine} strokeWidth={0.12} rx={l.kind === 'fountain' ? 1 : 0.2}>
            <title>{l.label}</title>
          </rect>
        ))}
        {town.spots.map((s) => (
          <g key={s.def.id} className={styles.spot} onClick={() => select({ kind: 'spot', id: s.def.id })} data-focus={focusKey === `spot:${s.def.id}` || undefined}>
            {s.def.cells.map((c, i) => (
              <rect key={i} x={c[0] + 0.3} y={c[1] + 0.3} width={0.4} height={0.4} rx={0.1} />
            ))}
            <title>{s.def.label}</title>
          </g>
        ))}

        {/* Agent lots: free ones are outlined (labelled in Agents mode), taken ones hold the agent's building. */}
        {town.agentLots.map((l) => {
          if (takenLots.has(l.id)) return null;
          const [x, y, w, h] = l.rect;
          return (
            <g key={l.id} className={styles.freeLot}>
              <rect x={x + 0.4} y={y + 0.4} width={w - 0.8} height={h - 0.8} rx={0.4} />
              {(mode === 'agents' || zoomedIn) && (
                <text x={x + w / 2} y={y + h / 2 + 4 * px} textAnchor="middle" className={styles.lotText} style={fs(11.5)}>
                  Free lot
                </text>
              )}
            </g>
          );
        })}

        {town.buildings.map((b) => {
          const [x, y, w, h] = b.def.footprint;
          const key = `building:${b.def.id}`;
          const n = inside.get(b.def.id) ?? 0;
          const shown = zoomedIn || hover === key || focusKey === key;
          return (
            <g
              key={b.def.id}
              className={styles.building}
              data-focus={focusKey === key || undefined}
              onClick={() => select({ kind: 'building', id: b.def.id })}
              onPointerEnter={() => setHover(key)}
              onPointerLeave={() => setHover((h) => (h === key ? null : h))}
            >
              <rect x={x} y={y} width={w} height={h} fill={b.def.palette.wall} className={styles.footprint} />
              <rect x={x + 0.45} y={y + 0.45} width={w - 0.9} height={h - 0.9} fill={b.def.palette.roof} />
              <rect x={b.def.door[0] + 0.25} y={b.def.door[1] + 0.25} width={0.5} height={0.5} fill={b.def.palette.trim} />
              {n > 0 && (
                <g className={styles.count} transform={`translate(${x + w - 0.6} ${y + 0.6})`}>
                  <circle r={Math.min(1.1, 9 * px)} />
                  <text y={3.8 * px} textAnchor="middle" style={fs(11)}>
                    {n}
                  </text>
                </g>
              )}
              {shown && (
                <text x={x + w / 2} y={y + h + 16 * px} textAnchor="middle" className={styles.label} style={fs(12.5)}>
                  {b.def.name}
                </text>
              )}
              <title>
                {b.def.name} · {n} inside
              </title>
            </g>
          );
        })}

        {snapshot?.agents.map((a) => {
          const lot = town.lotById.get(a.lotId);
          if (!lot) return null;
          const [x, y, w, h] = lot.rect;
          const hv = healthView(a.health);
          const key = `agent:${a.agentId}`;
          const waiting = a.health === 'awaiting_first_event' || a.health === 'not_connected';
          return (
            <g
              key={a.agentId}
              className={styles.agentHq}
              data-focus={focusKey === key || undefined}
              data-waiting={waiting || undefined}
              data-live={a.health === 'live' || undefined}
              onClick={() => select({ kind: 'agent', id: a.agentId })}
            >
              <rect x={x + 1.5} y={y + 1.5} width={w - 3} height={h - 3} rx={0.4} fill={C.hqShell} stroke={a.hue} strokeWidth={0.35} />
              <rect x={x + 2.4} y={y + 2.4} width={w - 4.8} height={h - 4.8} rx={0.3} fill={C.hqTrim} />
              {px <= 0.13 && (
                <text x={x + w / 2} y={y + h / 2 - 4 * px} textAnchor="middle" className={styles.hqName} style={fs(11.5)}>
                  {a.displayName}
                </text>
              )}
              {(px <= 0.13 ? splitLabel(hv.text) : []).map((line, i) => (
                <text key={i} x={x + w / 2} y={y + h / 2 + (15 + i * 13) * px} textAnchor="middle" className={styles.hqHealth} data-tone={hv.tone} style={fs(10.5)}>
                  {line}
                </text>
              ))}
              <title>
                {a.displayName} · Real · Claude Code · {hv.text}
              </title>
            </g>
          );
        })}

        {(zoomedIn || px > 0.15 ? [] : def.districts).map((d) => {
          const r = d.rects.reduce((a, b) => (a[2] * a[3] >= b[2] * b[3] ? a : b));
          return (
            <text key={d.id} x={r[0] + r[2] / 2} y={r[1] + r[3] / 2} textAnchor="middle" className={styles.district} style={fs(12)}>
              {d.label}
            </text>
          );
        })}

        <g className={styles.residents} data-reduced={reducedMotion || undefined}>
          {residents.map((r) => {
            const p = residentMapPos(town, r, tick);
            if (!p) return null;
            const key = `resident:${r.id}`;
            return (
              <g
                key={r.id}
                className={styles.resident}
                style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                data-focus={focusKey === key || undefined}
                onClick={() => select({ kind: 'resident', id: r.id })}
              >
                <circle r={focusKey === key ? dotR * 1.5 : dotR} fill={r.outfit.top} />
                <title>
                  {r.name} · {r.action}
                </title>
              </g>
            );
          })}
        </g>
      </svg>
      {variant === 'stage' && (
        <div className={styles.zoom} role="group" aria-label="Map zoom">
          <button type="button" aria-label="Zoom in" onClick={() => box && town && setView(shrink(box, 0.7))}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => box && town && setView(shrink(box, 1.4))}>
            −
          </button>
          <button type="button" aria-label="Show the whole town" onClick={() => full && moveTo(full, reducedMotion ? 'cut' : 'quick')}>
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}

/** A long label on two lines (at the middle space). */
function splitLabel(text: string): string[] {
  if (text.length <= 14) return [text];
  const mid = text.length / 2;
  let cut = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
  return cut < 0 ? [text] : [text.slice(0, cut), text.slice(cut + 1)];
}

function shrink(b: Box, k: number): Box {
  const w = b[2] * k;
  const h = b[3] * k;
  return [b[0] + (b[2] - w) / 2, b[1] + (b[3] - h) / 2, w, h];
}
