'use client';
import { useFrame } from '@react-three/fiber';
import type { Incident } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent } from '@runloop-world/events';
import { bfs, type Cell } from '@runloop-world/world-engine';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdditiveBlending, Color, NormalBlending, Vector3, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import { poseAt, stationStatuses, useScene, type SceneCtx } from './context';
import { useLabel } from './labels';
import { cellTop, heightAt, hubRing, incidentStationId, pathPoints, toScene } from './layout';
import { identityHex, stateGlow } from './palette';
import { pointAlong, polylineLength, ribbonGeometry } from './textures';
import type { SceneFrame } from './types';

type P3 = [number, number, number];

/** `born` is performance.now() when the effect was queued; its age is wall-clock time since then. */
type Fx =
  | { id: number; born: number; kind: 'packet'; pts: P3[]; color: string }
  | { id: number; born: number; kind: 'burst'; pos: P3; ok: boolean }
  | { id: number; born: number; kind: 'artifact'; pos: P3; color: string };

let nextId = 1;

/**
 * Seconds since the effect was queued. Measured on the wall clock (not from
 * its first frame), so effects queued while frames were paused (background
 * tab) expire instead of all playing at once when frames resume.
 */
const ageOf = (fx: Fx) => (performance.now() - fx.born) / 1000;

/**
 * Transient Layer-3 effects for events that just became visible (message
 * packets along the real path between sender and receiver, tool outcome
 * pulses, artifact pops) plus persistent incident beacons derived from
 * Layer-1 incidents. Each one marks a recorded event; none is decorative.
 */
export function Effects({ selectedSeq }: { selectedSeq: number | null }) {
  const ctx = useScene();
  const [items, setItems] = useState<Fx[]>([]);

  useEffect(
    () =>
      ctx.subscribeEffects((events) => {
        // Nobody sees transient effects in a hidden tab; persistent markers show the outcome.
        if (document.hidden) return;
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
      <IncidentBeacons selectedSeq={selectedSeq} />
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
      const call = exec.toolCalls.get(e.payload.callId);
      const pos = anchorFor(ctx, frame, call?.agentId);
      const ok = e.type === 'tool.call_completed' && e.payload.status === 'success';
      return pos ? [{ id: nextId++, born: performance.now(), kind: 'burst', pos, ok }] : [];
    }
    case 'artifact.created': {
      const by = e.payload.producedByCallId ? exec.toolCalls.get(e.payload.producedByCallId)?.agentId : e.actorId;
      const pos = anchorFor(ctx, frame, by);
      if (!pos) return [];
      return [
        {
          id: nextId++,
          born: performance.now(),
          kind: 'artifact',
          pos: [pos[0], pos[1] - 0.35, pos[2]],
          color: ctx.palette.ice,
        },
      ];
    }
    case 'agent.message_sent': {
      const color = identityHex(ctx.palette, frame.state.exec, e.payload.fromAgentId);
      return messageRoutes(ctx.world, frame, e.payload.fromAgentId, e.payload.to).map((cells) => ({
        id: nextId++,
        born: performance.now(),
        kind: 'packet' as const,
        pts: pathPoints(ctx.world, cells, 1.05),
        color,
      }));
    }
    default:
      return [];
  }
}

/**
 * The walkable routes a recorded message travels: from the sender (or the
 * Atrium, for a sender without a robot) to each receiving robot.
 */
export function messageRoutes(world: SceneCtx['world'], frame: SceneFrame, fromAgentId: string, to: string): Cell[][] {
  const from = poseAt(world, frame, fromAgentId);
  const start: Cell | undefined = from ? from.cell : hubRing(world)[0];
  if (!start) return [];
  const targets = to === 'all' ? frame.state.world.characterOrder.filter((id) => id !== fromAgentId) : [to];
  const out: Cell[][] = [];
  for (const id of targets) {
    const dest = poseAt(world, frame, id);
    if (dest) out.push(bfs(world, start, dest.cell) ?? [start, dest.cell]);
  }
  return out;
}

const SPEED = 7; // cells per second

/** A glowing packet that travels the BFS path, leaving a fading trail (static line under reduced motion). */
function Packet({ fx, onDone }: { fx: Extract<Fx, { kind: 'packet' }>; onDone: (id: number) => void }) {
  const { reducedMotion, palette } = useScene();
  const len = useMemo(() => polylineLength(fx.pts), [fx.pts]);
  const trail = useMemo(() => ribbonGeometry(fx.pts, 0.06, { uPerUnit: 1 / Math.max(len, 0.001), extend: true }), [fx.pts, len]);
  useEffect(() => () => trail.dispose(), [trail]);
  const root = useRef<Group>(null);
  const head = useRef<Group>(null);
  const trailMat = useRef<MeshBasicMaterial>(null);
  const travel = Math.min(3, Math.max(0.6, len / SPEED));
  const total = reducedMotion ? 1.6 : travel + 0.6;
  const v = useMemo(() => new Vector3(), []);
  const c = useMemo(() => stateGlow(palette, fx.color, 1.6), [fx.color, palette]);
  const blending = palette.glow ? AdditiveBlending : NormalBlending;

  useFrame(() => {
    const age = ageOf(fx);
    if (age > total) {
      if (root.current) root.current.visible = false;
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
    if (trailMat.current) trailMat.current.opacity = age <= travel ? 0.5 : 0.5 * (1 - (age - travel) / 0.6);
  });

  return (
    <group ref={root}>
      <mesh geometry={trail}>
        <meshBasicMaterial ref={trailMat} color={c} transparent opacity={0.5} depthWrite={false} toneMapped={false} blending={blending} />
      </mesh>
      <group ref={head} position={fx.pts[0]}>
        <mesh>
          <octahedronGeometry args={[0.14, 0]} />
          <meshBasicMaterial color={c} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/** A restrained outcome pulse: success is one ring with a check, an error a double ring with an X. */
function Burst({ fx, onDone }: { fx: Extract<Fx, { kind: 'burst' }>; onDone: (id: number) => void }) {
  const { reducedMotion, palette } = useScene();
  const group = useRef<Group>(null);
  const ringA = useRef<Mesh>(null);
  const ringB = useRef<Mesh>(null);
  const mats = useRef<MeshBasicMaterial[]>([]);
  const color = useMemo(() => stateGlow(palette, fx.ok ? palette.success : palette.failure, 1.6), [fx.ok, palette]);
  const total = fx.ok ? 1.1 : 1.6;

  useFrame(() => {
    const age = ageOf(fx);
    if (age > total) {
      if (group.current) group.current.visible = false;
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

/** A small cube pops out above the station when an artifact is recorded, then fades. */
function ArtifactPop({ fx, onDone }: { fx: Extract<Fx, { kind: 'artifact' }>; onDone: (id: number) => void }) {
  const { reducedMotion, palette } = useScene();
  const g = useRef<Group>(null);
  const mat = useRef<MeshBasicMaterial>(null);
  const color = useMemo(() => stateGlow(palette, fx.color, 1.2), [fx.color, palette]);
  const total = 2.4;

  useFrame(() => {
    const age = ageOf(fx);
    if (age > total) {
      if (g.current) g.current.visible = false;
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
        <boxGeometry args={[0.18, 0.18, 0.18]} />
        <meshBasicMaterial ref={mat} color={color} transparent toneMapped={false} />
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

/** Persistent markers for exec.incidents at the station where they happened (muted once resolved). */
function IncidentBeacons({ selectedSeq }: { selectedSeq: number | null }) {
  const ctx = useScene();
  const [beacons, setBeacons] = useState<Beacon[]>([]);
  const sig = useRef('');

  useFrame(() => {
    const frame = ctx.getFrame();
    const incs = frame.state.exec.incidents;
    let s = '';
    for (const i of incs) s += `${i.eventId}:${i.resolvedSeq === null ? 0 : 1};`;
    if (s === sig.current) return;
    sig.current = s;
    // Statuses are cached per RunState; computing them also remembers each incident's station.
    stationStatuses(ctx, frame.state);
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
        <BeaconMarker key={b.inc.eventId} beacon={b} selected={b.inc.seq === selectedSeq} />
      ))}
    </group>
  );
}

export const INCIDENT_LABEL: Record<Incident['kind'], string> = {
  tool_error: 'Tool error',
  tool_failed: 'Tool failed',
  task_failed: 'Task failed',
  run_failed: 'Run failed',
};

/**
 * An incident marker: a thin line up from the station to a small gem with a
 * chip naming the failure. Clicking either opens the failing event (the path
 * from the world to the investigation). Resolved incidents shrink and mute.
 */
function BeaconMarker({ beacon, selected }: { beacon: Beacon; selected: boolean }) {
  const { world, reducedMotion, palette, selectEvent } = useScene();
  const station = world.stationsById[beacon.stationId]!;
  const zone = world.zonesById[station.zoneId]?.label ?? null;
  const inc = beacon.inc;
  const open = inc.resolvedSeq === null;
  const [x, , z] = toScene(world, station.cell[0], station.cell[1]);
  const base = cellTop(world, station.cell[0], station.cell[1]);
  const y = base + 2.7 + beacon.index * 0.55;
  const color = useMemo(() => (open ? stateGlow(palette, palette.failure, 1.5) : new Color(palette.muted)), [open, palette]);
  const gem = useRef<Group>(null);
  const anchor = useMemo(() => new Vector3(x, y + 0.3, z), [x, y, z]);
  useLabel(
    `incident:${inc.eventId}`,
    {
      kind: 'incident',
      open,
      seq: inc.seq,
      selected,
      title: inc.resolution === 'later_success' ? `${inc.message} (a later call of the same kind succeeded; inferred)` : inc.message,
      short: open ? INCIDENT_LABEL[inc.kind] : 'Resolved',
      // The full label names the environment: its sign may give way to this label and the station's.
      // Traced runs: "resolved" is Runloop's inference from a later success, and says so.
      text: open
        ? `${zone ? `${zone} · ` : ''}${INCIDENT_LABEL[inc.kind]} · ${clip(inc.message, 32)}`
        : `${inc.resolution === 'later_success' ? 'Resolved (inferred)' : 'Resolved'} · ${INCIDENT_LABEL[inc.kind]}`,
    },
    anchor,
  );

  useFrame(({ clock }) => {
    if (!gem.current || reducedMotion || !open) return;
    gem.current.rotation.y = clock.elapsedTime * 0.9;
  });

  const onClick = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    selectEvent(inc.seq, { seek: false });
  };

  return (
    <group position={[x, 0, z]}>
      {open && (
        <>
          <mesh position={[0, base + (y - base) / 2, 0]}>
            <cylinderGeometry args={[0.018, 0.018, y - base, 6, 1, true]} />
            <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, base + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.62, 0.67, 48]} />
            <meshBasicMaterial color={color} transparent opacity={0.9} toneMapped={false} />
          </mesh>
        </>
      )}
      <group position={[0, y, 0]} onClick={onClick}>
        <group ref={gem}>
          <mesh scale={(open ? 1 : 0.6) * (selected ? 1.3 : 1)}>
            <octahedronGeometry args={[0.17, 0]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        </group>
        {selected && (
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.3, 0.34, 32]} />
            <meshBasicMaterial color={palette.ice} transparent opacity={0.9} />
          </mesh>
        )}
      </group>
    </group>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
