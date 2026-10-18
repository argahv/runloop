/**
 * Town renderer harness (dev only; served by scripts/perf-town.mjs).
 * Mounts <TownCanvas> on the Commons with the engine running in the page
 * (harness/localWorld.ts), so the renderer can be measured and screenshotted
 * without a runtime. Everything on screen is labelled "Fixture".
 *
 * Query parameters:
 *   t=HH:MM     start time (Day 1)                 speed=0|1|4|16   pop=80
 *   cam=town | district:<dst_id> | street:<x>,<y>[,<px per cell>] | focus:<kind>:<id> | interior:<bld_id> | interior:hq
 *   rot=0..3    quarter turns                      theme=dark|light quality=auto|high|low
 *   agents=0..4 fixture agents to house            reduced=1        stress=<n> synthetic extra walkers (perf only)
 *   select=<kind>:<id>                             follow=1 (follow the selection)
 *   live=<runtime url>  render that runtime's world over SSE instead (read only)
 */
import type { AnyEvent, EntityRef, ResidentState, RunDetailResponse, RunEvent, WorldEvent, WorldSnapshot } from '@runloop-world/events';
import { applyEvent } from '@runloop-world/sim';
import { loadTown, type CompiledTown } from '@runloop-world/town';
import { compileWorld, type CompiledWorld } from '@runloop-world/world-engine';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStudioStore, type StudioStore } from '../../state/store';
import type { TownClock } from '../clock';
import TownCanvas from '../TownCanvas';
import type { AgentHouseSource, TownCam, TownCameraRequest, TownLevel, TownState } from '../types';
import { FIXTURE_HQ_AGENT, LocalWorld, houseFixtureAgents } from './localWorld';
import '../../app/tokens.css';
import '../../app/globals.css';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
document.documentElement.setAttribute('data-theme', q.get('theme') === 'light' ? 'light' : 'dark');
// Studio loads Geist through next/font; the harness uses the system stack in its place.
document.documentElement.style.setProperty('--font-geist-sans', 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif');
document.documentElement.style.setProperty('--font-geist-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace');

async function loadCommons(): Promise<CompiledTown> {
  const res = await fetch('/fixture/town');
  const raw = (await res.json()) as { town: unknown; interiors: Record<string, unknown> };
  return loadTown(raw.town, raw.interiors);
}

/** The agent headquarters' diorama: a recorded fixture run (codingMissionFixture) in a StudioStore. */
async function loadHouse(): Promise<{ store: StudioStore; world: CompiledWorld } | null> {
  try {
    const res = await fetch('/fixture/run');
    const { events, world } = (await res.json()) as { events: RunEvent[]; world: unknown };
    const store = createStudioStore();
    const first = events[0]!;
    store.getState().openRun(first.runId);
    const detail = {
      run: {
        runId: first.runId,
        title: 'Fixture run',
        missionId: 'coding-mission',
        worldId: 'research-campus',
        status: 'running',
        createdAt: first.timestamp,
        endedAt: null,
        lastSequence: events.length,
        adapterLabel: 'Scripted adapter',
        paused: false,
      },
      world,
    } as unknown as RunDetailResponse;
    store.getState().loadRun(detail);
    store.getState().ingest(events, 'backlog');
    return { store, world: compileWorld(world as never) };
  } catch (err) {
    console.error('[harness] no fixture run', err);
    return null;
  }
}

function parseRef(s: string | null): EntityRef | null {
  if (!s) return null;
  const i = s.indexOf(':');
  return i > 0 ? ({ kind: s.slice(0, i), id: s.slice(i + 1) } as EntityRef) : null;
}

/** Synthetic walkers for the 500-actor budget: copies of real walkers, shifted along their routes (perf only). */
function stressResidents(src: readonly ResidentState[], n: number): ResidentState[] {
  const walkers = src.filter((r) => r.motion);
  if (!walkers.length) return [];
  return Array.from({ length: n }, (_, i) => {
    const r = walkers[i % walkers.length]!;
    return { ...r, id: `res_${9000 + i}`, idx: src.length + i, motion: { path: r.motion!.path, startTick: r.motion!.startTick - (i % 37) * 0.8 } };
  });
}

function Harness({ town, house }: { town: CompiledTown; house: { store: StudioStore; world: CompiledWorld } | null }) {
  const [hh, mm] = (q.get('t') ?? '08:10').split(':').map(Number);
  const start = (hh ?? 8) * 60 + (mm ?? 0);
  const world = useMemo(() => {
    // Begin at 07:30 (or the requested time minus 40 minutes) so the town is mid-day, not just waking.
    const w = new LocalWorld(town, { seed: num('seed', 42), population: num('pop', 80), startTick: Math.max(0, Math.min(start - 40, 480)) });
    w.runTo(Math.max(w.tick, start - 1));
    houseFixtureAgents(w, num('agents', 4));
    const speed = num('speed', 1);
    if (speed !== 1) w.command({ id: 'clock:harness', source: 'user', command: { type: 'clock.set', speed: speed as 0 | 4 | 16 } });
    return w;
  }, [town]);
  const stress = num('stress', 0);
  const stressSnap = useRef<{ snap: WorldSnapshot; at: number } | null>(null);
  const getState = useCallback((): TownState => {
    const clock: TownClock = world.advance(Date.now());
    let snapshot: WorldSnapshot = world.snapshot();
    if (stress > 0) {
      const now = performance.now();
      // Rebuilt rarely (the copies keep walking their routes in between), so the harness itself adds no per-frame work.
      if (!stressSnap.current || now - stressSnap.current.at > 15000) stressSnap.current = { snap: { ...snapshot, residents: [...snapshot.residents, ...stressResidents(snapshot.residents, stress)] }, at: now };
      const extra = stressSnap.current.snap.residents.slice(snapshot.residents.length);
      if (stressSnap.current.snap.residents[0] !== snapshot.residents[0] || stressSnap.current.snap.tick !== snapshot.tick) {
        stressSnap.current.snap = { ...snapshot, residents: snapshot.residents.concat(extra) };
      }
      snapshot = stressSnap.current.snap;
    }
    return { snapshot, clock };
  }, [world, stress]);

  const [selected, setSelected] = useState<EntityRef | null>(parseRef(q.get('select')));
  const [entered, setEntered] = useState<string | null>(null);
  const [request, setRequest] = useState<TownCameraRequest | null>(null);
  const [status, setStatus] = useState<{ cam: TownCam | null; level: TownLevel }>({ cam: null, level: 'town' });
  const reqId = useRef(0);
  const ask = (r: Omit<TownCameraRequest, 'id'>) => setRequest({ ...r, id: ++reqId.current });

  // The bookmark from ?cam= and ?rot=, once the canvas is ready.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const cam = q.get('cam') ?? 'town';
    const motion = 'cut' as const;
    // One request per frame or so: the renderer acts on the latest request it sees.
    const turns = num('rot', 0);
    for (let i = 0; i < turns; i++) setTimeout(() => ask({ kind: 'rotate', dir: 1, motion }), 60 * i);
    setTimeout(() => {
      if (cam.startsWith('district:')) ask({ kind: 'focus', ref: { kind: 'district', id: cam.slice(9) }, motion });
      else if (cam.startsWith('street:')) {
        const [x, y, zoom] = cam.slice(7).split(',').map(Number);
        ask({ kind: 'cam', cam: { x: x ?? 48, z: y ?? 40, zoom: zoom || innerWidth / 28 }, motion });
      } else if (cam.startsWith('focus:')) ask({ kind: 'focus', ref: parseRef(cam.slice(6)), motion });
      else if (cam.startsWith('interior:')) {
        const id = cam.slice(9);
        const b = id === 'hq' ? world.snapshot().agents.find((a) => a.agentId === FIXTURE_HQ_AGENT)?.buildingId ?? null : id;
        setEntered(b);
      } else ask({ kind: 'overview', motion });
    }, 60 * turns + 60);
  }, [ready]);

  const agentHouse = useCallback(
    (agentId: string): AgentHouseSource | null => {
      if (!house || agentId !== FIXTURE_HQ_AGENT) return null;
      const s = house.store.getState();
      return { world: house.world, getFrame: s.getFrame, subscribeEffects: s.subscribeEffects as (fn: (e: readonly AnyEvent[]) => void) => () => void };
    },
    [house],
  );
  useEffect(() => (house ? house.store.getState().mountWorld() : undefined), [house]);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <TownCanvas
        town={town}
        getState={getState}
        selected={selected}
        follow={q.get('follow') === '1' ? selected : null}
        entered={entered}
        cameraRequest={request}
        onSelect={setSelected}
        onEnter={(id) => setEntered(id)}
        onCamChange={(cam, level) => setStatus({ cam, level })}
        quality={(q.get('quality') as 'auto' | 'high' | 'low') ?? 'auto'}
        reducedMotion={q.get('reduced') === '1'}
        seed={num('seed', 42)}
        agentHouse={agentHouse}
        onReady={() => setReady(true)}
        obstacles={(w) => [{ l: 0, t: 0, r: Math.min(w, 520), b: 52 }]}
      />
      <div style={bar}>
        <span style={chip}>Fixture · engine running in this page</span>
        <span style={{ opacity: 0.8 }}>{status.level}</span>
        {stress > 0 && <span style={chip}>Synthetic stress test: +{stress} walkers</span>}
        <button style={btn} onClick={() => ask({ kind: 'overview' })}>Town</button>
        <button style={btn} onClick={() => ask({ kind: 'level', level: 'street' })}>Street</button>
        <button style={btn} onClick={() => ask({ kind: 'rotate', dir: 1 })}>Rotate</button>
        <button style={btn} onClick={() => setEntered(entered ? null : 'bld_corner_cafe')}>{entered ? 'Back to town' : 'Enter café'}</button>
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  position: 'fixed',
  left: 12,
  top: 10,
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  font: '12px/1.3 ui-sans-serif, system-ui, sans-serif',
  color: 'var(--rl-text)',
};
const chip: React.CSSProperties = { padding: '4px 8px', borderRadius: 999, background: 'var(--rl-glass)', boxShadow: '0 0 0 1px var(--rl-glass-line)' };
const btn: React.CSSProperties = { ...chip, border: 0, color: 'var(--rl-text)', cursor: 'pointer', font: 'inherit' };

/**
 * ?live=<runtime url>: render a real runtime's world instead (GET /api/world/town, then the SSE stream:
 * snapshot, event batches folded with the sim's applyEvent, the 1 Hz clock). Read only.
 */
function LiveHarness({ base }: { base: string }) {
  const [town, setTown] = useState<CompiledTown | null>(null);
  const state = useRef<{ snapshot: WorldSnapshot | null; clock: TownClock | null }>({ snapshot: null, clock: null });
  const [status, setStatus] = useState('connecting');
  useEffect(() => {
    let es: EventSource | null = null;
    let compiled: CompiledTown | null = null;
    void fetch(`${base}/api/world/town`)
      .then((r) => r.json())
      .then((t: { town: unknown; interiors: Record<string, unknown> }) => {
        compiled = loadTown(t.town, t.interiors);
        setTown(compiled);
        es = new EventSource(`${base}/api/world/stream`);
        es.addEventListener('snapshot', (m) => {
          const snap = JSON.parse((m as MessageEvent<string>).data) as WorldSnapshot;
          state.current.snapshot = snap;
          state.current.clock = { tick: snap.tick, speed: snap.speed, receivedAt: Date.now() };
          setStatus(`live · seq ${snap.seq}`);
        });
        es.addEventListener('message', (m) => {
          const { events } = JSON.parse((m as MessageEvent<string>).data) as { events: WorldEvent[] };
          let s = state.current.snapshot;
          for (const e of events) if (s && e.seq > s.seq) s = applyEvent(s, e, compiled!);
        });
        es.addEventListener('clock', (m) => {
          const c = JSON.parse((m as MessageEvent<string>).data) as { tick: number; speed: number };
          state.current.clock = { tick: c.tick, speed: c.speed, receivedAt: Date.now() };
        });
        es.onerror = () => setStatus('reconnecting');
      })
      .catch((err: unknown) => setStatus(`error: ${String(err)}`));
    return () => es?.close();
  }, [base]);
  const getState = useCallback((): TownState => ({ snapshot: state.current.snapshot, clock: state.current.clock }), []);
  const [selected, setSelected] = useState<EntityRef | null>(null);
  if (!town) return <div style={bar}>{status}</div>;
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <TownCanvas
        town={town}
        getState={getState}
        selected={selected}
        follow={null}
        entered={null}
        cameraRequest={null}
        onSelect={setSelected}
        quality={(q.get('quality') as 'auto' | 'high' | 'low') ?? 'auto'}
        reducedMotion={q.get('reduced') === '1'}
        obstacles={(w) => [{ l: 0, t: 0, r: Math.min(w, 520), b: 52 }]}
      />
      <div style={bar}>
        <span style={chip}>Runtime {base} · {status}</span>
      </div>
    </div>
  );
}

const live = q.get('live');
if (live) {
  createRoot(document.getElementById('root')!).render(<LiveHarness base={live.replace(/\/+$/, '')} />);
} else {
  void Promise.all([loadCommons(), loadHouse()]).then(([town, house]) => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Harness town={town} house={house} />
      </StrictMode>,
    );
  });
}
