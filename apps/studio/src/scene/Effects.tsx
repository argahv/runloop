'use client';
import { useFrame } from '@react-three/fiber';
import type { Incident } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent } from '@runloop-world/events';
import { bfs, type Cell } from '@runloop-world/world-engine';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdditiveBlending, Color, Vector3, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import { poseAt, stationStatuses, useScene, type SceneCtx } from './context';
import { useLabel } from './labels';
import { cellTop, heightAt, hubRing, incidentStationId, pathPoints, toScene } from './layout';
import { PALETTE, glow } from './palette';
import { pointAlong, polylineLength, ribbonGeometry } from './textures';
import type { SceneFrame } from './types';

type P3 = [number, number, number];

type Fx =
  | { id: number; kind: 'packet'; pts: P3[]; color: string }
  | { id: number; kind: 'burst'; pos: P3; ok: boolean }
  | { id: number; kind: 'artifact'; pos: P3; color: string };

let nextId = 1;

const ARTIFACT_COLOR: Record<string, string> = {
  file: PALETTE.cyan,
  diff: PALETTE.purple,
  test_report: PALETTE.amber,
  log: '#94a3b8',
};

/**
 * Transient Layer-3 effects for events that just became visible (message
 * packets, tool success/error bursts, artifact pops) plus persistent incident
 * beacons derived from Layer-1 incidents.
 */
export function Effects() {
  const ctx = useScene();
  const [items, setItems] = useState<Fx[]>([]);

  useEffect(
    () =>
      ctx.subscribeEffects((events) => {
        const frame = ctx.getFrame();
        const add: Fx[] = [];
        for (const e of events) add.push(...effectsFor(e, frame, ctx));
        if (add.length) setItems((prev) => [...prev, ...add].slice(-24));
      }),
    [ctx],
  );

  const done = useCallback((id: number) => setItems((prev) => prev.filter((f) => f.id !== id)), []);

  return (
    <group>
      {items.map((f) =>
        f.kind === 'packet' ? (
          <Packet key={f.id} fx={f} onDone={done} />
        ) : f.kind === 'burst' ? (
          <Burst key={f.id} fx={f} onDone={done} />
        ) : (
          <ArtifactPop key={f.id} fx={f} onDone={done} />
        ),
      )}
      <IncidentBeacons />
    </group>
  );
}

/** Where an agent's work shows: above its station if it holds one, else above its head. */
function anchorFor(ctx: SceneCtx, frame: SceneFrame, agentId: string | null | undefined): P3 | null {
  if (!agentId) return null;
  const c = frame.state.world.characters[agentId];
  if (!c) return null;
  const station = c.stationId ? ctx.world.stationsById[c.stationId] : undefined;
  if (station) {
    const [x, , z] = toScene(ctx.world, station.cell[0], station.cell[1]);
    // High enough to clear the badge of a character standing in front of the station.
    return [x, cellTop(ctx.world, station.cell[0], station.cell[1]) + 2.6, z];
  }
  const pose = poseAt(ctx.world, frame, agentId);
  if (!pose) return null;
  const [x, , z] = toScene(ctx.world, pose.x, pose.y);
  return [x, heightAt(ctx.world, pose.x, pose.y) + 2.9, z];
}

function effectsFor(e: AnyEvent, frame: SceneFrame, ctx: SceneCtx): Fx[] {
  if (isUnknownEvent(e)) return [];
  const exec = frame.state.exec;
  switch (e.type) {
    case 'tool.call_completed':
    case 'tool.call_failed': {
      const call = exec.toolCalls[e.payload.callId];
      const pos = anchorFor(ctx, frame, call?.agentId);
      const ok = e.type === 'tool.call_completed' && e.payload.status === 'success';
      return pos ? [{ id: nextId++, kind: 'burst', pos, ok }] : [];
    }
    case 'artifact.created': {
      const by = e.payload.producedByCallId ? exec.toolCalls[e.payload.producedByCallId]?.agentId : e.actorId;
      const pos = anchorFor(ctx, frame, by);
      if (!pos) return [];
      return [{ id: nextId++, kind: 'artifact', pos: [pos[0], pos[1] - 0.35, pos[2]], color: ARTIFACT_COLOR[e.payload.kind] ?? PALETTE.cyan }];
    }
    case 'agent.message_sent': {
      const { world } = ctx;
      const from = poseAt(world, frame, e.payload.fromAgentId);
      const start: Cell | undefined = from ? from.cell : hubRing(world)[0];
      if (!start) return [];
      const color = world.presetsById[frame.state.world.characters[e.payload.fromAgentId]?.presetId ?? '']?.color ?? PALETTE.cyan;
      const targets =
        e.payload.to === 'all'
          ? frame.state.world.characterOrder.filter((id) => id !== e.payload.fromAgentId)
          : [e.payload.to];
      const out: Fx[] = [];
      for (const id of targets) {
        const to = poseAt(world, frame, id);
        if (!to) continue;
        const cells = bfs(world, start, to.cell) ?? [start, to.cell];
        out.push({ id: nextId++, kind: 'packet', pts: pathPoints(world, cells, 1.05), color });
      }
      return out;
    }
    default:
      return [];
  }
}

const SPEED = 7; // cells per second

/** A glowing packet that travels the BFS path, leaving a fading trail (static line under reduced motion). */
function Packet({ fx, onDone }: { fx: Extract<Fx, { kind: 'packet' }>; onDone: (id: number) => void }) {
  const { reducedMotion } = useScene();
  const len = useMemo(() => polylineLength(fx.pts), [fx.pts]);
  const trail = useMemo(() => ribbonGeometry(fx.pts, 0.1, { uPerUnit: 1 / Math.max(len, 0.001), extend: true }), [fx.pts, len]);
  useEffect(() => () => trail.dispose(), [trail]);
  const head = useRef<Group>(null);
  const trailMat = useRef<MeshBasicMaterial>(null);
  const start = useRef<number | null>(null);
  const travel = Math.min(3, Math.max(0.6, len / SPEED));
  const total = reducedMotion ? 1.6 : travel + 0.6;
  const v = useMemo(() => new Vector3(), []);
  const c = useMemo(() => glow(fx.color, 2.4), [fx.color]);

  useFrame(({ clock }) => {
    start.current ??= clock.elapsedTime;
    const age = clock.elapsedTime - start.current;
    if (age > total) {
      onDone(fx.id);
      return;
    }
    if (reducedMotion) {
      if (head.current) head.current.visible = false;
      return;
    }
    const s = Math.min(1, age / travel) * len;
    pointAlong(fx.pts, s, v);
    if (head.current) {
      head.current.position.copy(v);
      head.current.visible = age <= travel;
    }
    if (trailMat.current) trailMat.current.opacity = age <= travel ? 0.65 : 0.65 * (1 - (age - travel) / 0.6);
  });

  return (
    <group>
      <mesh geometry={trail}>
        <meshBasicMaterial ref={trailMat} color={c} transparent opacity={0.65} depthWrite={false} toneMapped={false} blending={AdditiveBlending} />
      </mesh>
      <group ref={head} position={fx.pts[0]}>
        <mesh>
          <octahedronGeometry args={[0.17, 0]} />
          <meshBasicMaterial color={c} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.32, 16, 16]} />
          <meshBasicMaterial color={c} transparent opacity={0.25} depthWrite={false} toneMapped={false} blending={AdditiveBlending} />
        </mesh>
      </group>
    </group>
  );
}

/** Success: an expanding green ring with a check mark. Error: a red double pulse with an X. */
function Burst({ fx, onDone }: { fx: Extract<Fx, { kind: 'burst' }>; onDone: (id: number) => void }) {
  const { reducedMotion } = useScene();
  const group = useRef<Group>(null);
  const ringA = useRef<Mesh>(null);
  const ringB = useRef<Mesh>(null);
  const mats = useRef<MeshBasicMaterial[]>([]);
  const start = useRef<number | null>(null);
  const color = useMemo(() => glow(fx.ok ? PALETTE.ok : PALETTE.err, 2.4), [fx.ok]);
  const total = fx.ok ? 1.3 : 1.6;

  useFrame(({ clock }) => {
    start.current ??= clock.elapsedTime;
    const age = clock.elapsedTime - start.current;
    if (age > total) {
      onDone(fx.id);
      return;
    }
    if (reducedMotion) return;
    const p = age / total;
    if (group.current) group.current.position.y = fx.pos[1] + p * 0.35;
    const pulse = (q: number) => 0.4 + q * 1.4;
    ringA.current?.scale.setScalar(pulse(Math.min(1, age / 0.7)));
    if (ringB.current) {
      const q = Math.max(0, Math.min(1, (age - 0.35) / 0.7));
      ringB.current.scale.setScalar(pulse(q));
      ringB.current.visible = !fx.ok && age > 0.35;
    }
    for (const m of mats.current) m.opacity = 1 - p * p;
  });

  const mat = (i: number) => (m: MeshBasicMaterial | null) => {
    if (m) mats.current[i] = m;
  };
  return (
    <group ref={group} position={fx.pos}>
      <mesh ref={ringA} rotation={[-Math.PI / 2, 0, 0]} scale={reducedMotion ? 1.2 : 0.4}>
        <ringGeometry args={[0.32, 0.38, 40]} />
        <meshBasicMaterial ref={mat(0)} color={color} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={ringB} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.32, 0.38, 40]} />
        <meshBasicMaterial ref={mat(1)} color={color} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {/* Glyph: check or X, as two bars (billboarded loosely by facing the iso camera). */}
      <group rotation={[0, Math.PI / 4, 0]} position={[0, 0.3, 0]}>
        {fx.ok ? (
          <>
            <mesh position={[-0.1, -0.03, 0]} rotation={[0, 0, -Math.PI / 4]}>
              <boxGeometry args={[0.22, 0.08, 0.04]} />
              <meshBasicMaterial ref={mat(2)} color={color} transparent depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh position={[0.08, 0.05, 0]} rotation={[0, 0, Math.PI / 3.6]}>
              <boxGeometry args={[0.38, 0.08, 0.04]} />
              <meshBasicMaterial ref={mat(3)} color={color} transparent depthWrite={false} toneMapped={false} />
            </mesh>
          </>
        ) : (
          [1, -1].map((r, i) => (
            <mesh key={r} rotation={[0, 0, (r * Math.PI) / 4]}>
              <boxGeometry args={[0.4, 0.08, 0.04]} />
              <meshBasicMaterial ref={mat(2 + i)} color={color} transparent depthWrite={false} toneMapped={false} />
            </mesh>
          ))
        )}
      </group>
    </group>
  );
}

/** A small glowing cube pops out above the station, spins, and fades. */
function ArtifactPop({ fx, onDone }: { fx: Extract<Fx, { kind: 'artifact' }>; onDone: (id: number) => void }) {
  const { reducedMotion } = useScene();
  const g = useRef<Group>(null);
  const mat = useRef<MeshBasicMaterial>(null);
  const start = useRef<number | null>(null);
  const color = useMemo(() => glow(fx.color, 2.2), [fx.color]);
  const total = 2.4;

  useFrame(({ clock }) => {
    start.current ??= clock.elapsedTime;
    const age = clock.elapsedTime - start.current;
    if (age > total) {
      onDone(fx.id);
      return;
    }
    if (reducedMotion || !g.current) return;
    const pop = age < 0.35 ? easeOutBack(age / 0.35) : 1;
    g.current.scale.setScalar(Math.max(0.001, pop));
    g.current.position.y = fx.pos[1] + Math.min(1, age / total) * 0.5;
    g.current.rotation.y = age * 2.2;
    g.current.rotation.x = age * 1.3;
    if (mat.current) mat.current.opacity = age > total - 0.6 ? (total - age) / 0.6 : 1;
  });

  return (
    <group ref={g} position={fx.pos}>
      <mesh>
        <boxGeometry args={[0.2, 0.2, 0.2]} />
        <meshBasicMaterial ref={mat} color={color} transparent toneMapped={false} />
      </mesh>
      <mesh>
        <boxGeometry args={[0.3, 0.3, 0.3]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} depthWrite={false} toneMapped={false} blending={AdditiveBlending} />
      </mesh>
    </group>
  );
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/* ── Incident beacons ──────────────────────────────────────────────────── */

interface Beacon {
  inc: Incident;
  stationId: string;
  index: number;
}

/** Persistent markers for exec.incidents at the station where they happened (grey once resolved). */
function IncidentBeacons() {
  const ctx = useScene();
  const [beacons, setBeacons] = useState<Beacon[]>([]);
  const sig = useRef('');

  useFrame(() => {
    const frame = ctx.getFrame();
    // Cheap check first: statuses are cached per RunState.
    stationStatuses(ctx, frame.state);
    const incs = frame.state.exec.incidents;
    let s = '';
    for (const i of incs) s += `${i.eventId}:${i.resolvedSeq === null ? 0 : 1};`;
    if (s === sig.current) return;
    sig.current = s;
    const perStation = new Map<string, number>();
    const next: Beacon[] = [];
    for (const inc of incs) {
      if (inc.kind === 'run_failed') continue;
      const stationId = incidentStationId(ctx.world, frame.state, inc, ctx.incidentStations);
      if (!stationId) continue;
      const index = perStation.get(stationId) ?? 0;
      perStation.set(stationId, index + 1);
      next.push({ inc, stationId, index });
    }
    setBeacons(next);
  });

  return (
    <group>
      {beacons.map((b) => (
        <BeaconMarker key={b.inc.eventId} beacon={b} />
      ))}
    </group>
  );
}

const INCIDENT_LABEL: Record<Incident['kind'], string> = {
  tool_error: 'Tool error',
  tool_failed: 'Tool failed',
  task_failed: 'Task failed',
  run_failed: 'Run failed',
};

function BeaconMarker({ beacon }: { beacon: Beacon }) {
  const { world, reducedMotion } = useScene();
  const station = world.stationsById[beacon.stationId]!;
  const open = beacon.inc.resolvedSeq === null;
  const [x, , z] = toScene(world, station.cell[0], station.cell[1]);
  const base = cellTop(world, station.cell[0], station.cell[1]);
  const y = base + 2.95 + beacon.index * 0.6;
  const color = useMemo(() => (open ? glow(PALETTE.err, 2.4) : new Color(PALETTE.resolved)), [open]);
  const gem = useRef<Group>(null);
  const beam = useRef<MeshBasicMaterial>(null);
  const anchor = useMemo(() => new Vector3(x, y + 0.75, z), [x, y, z]);
  const inc = beacon.inc;
  useLabel(
    `incident:${inc.eventId}`,
    {
      kind: 'incident',
      open,
      title: inc.message,
      text: open ? `${INCIDENT_LABEL[inc.kind]} · ${clip(inc.message, 26)}` : `Resolved · ${INCIDENT_LABEL[inc.kind]}`,
    },
    anchor,
  );

  useFrame(({ clock }) => {
    if (!gem.current || reducedMotion || !open) return;
    const t = clock.elapsedTime;
    gem.current.rotation.y = t * 1.4;
    gem.current.position.y = Math.sin(t * 2.2) * 0.05;
    if (beam.current) beam.current.opacity = 0.22 + 0.12 * Math.sin(t * 5);
  });

  return (
    <group position={[x, 0, z]}>
      {open && (
        <>
          <mesh position={[0, base + (y - base) / 2, 0]}>
            <cylinderGeometry args={[0.05, 0.12, y - base, 12, 1, true]} />
            <meshBasicMaterial ref={beam} color={color} transparent opacity={0.28} depthWrite={false} toneMapped={false} blending={AdditiveBlending} />
          </mesh>
          <mesh position={[0, base + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.6, 0.68, 40]} />
            <meshBasicMaterial color={color} transparent opacity={0.9} toneMapped={false} />
          </mesh>
        </>
      )}
      <group position={[0, y, 0]}>
        <group ref={gem}>
          <mesh scale={open ? 1 : 0.7}>
            <octahedronGeometry args={[0.2, 0]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
