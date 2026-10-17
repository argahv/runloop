'use client';
import { useFrame } from '@react-three/fiber';
import type { RunExecStatus } from '@runloop-world/core';
import type { Zone } from '@runloop-world/world-engine';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Object3D, Vector3, type InstancedMesh, type MeshBasicMaterial } from 'three';
import { useScene } from './context';
import { useLabel } from './labels';
import { BACK_WALL_H, CURB_H, FLOOR_Y, ROOM_Y, cellNoise, classifyWalls, floorTiles, isWall, toScene, zoneSignCell } from './layout';
import { desaturate, mixHex, stateGlow, zoneAccent, zoneCap, zoneFloor, type ScenePalette } from './palette';

const tmp = new Object3D();
const tmpColor = new Color();

/**
 * The diorama: an obsidian base slab, graphite floor tiles, rooms raised as
 * quietly tinted platforms, cutaway walls in slate, and the Atrium core whose
 * ring shows the run's status. Nothing here glows except that ring.
 */
export const Board = memo(function Board() {
  const { world, palette } = useScene();
  const w = world.width + 1.6;
  const d = world.height + 1.6;
  return (
    <group>
      <mesh position={[0, -0.36, 0]}>
        <boxGeometry args={[w, 0.7, d]} />
        <meshLambertMaterial color={palette.slabSide} />
      </mesh>
      <mesh position={[0, -0.004, 0]}>
        <boxGeometry args={[w - 0.04, 0.01, d - 0.04]} />
        <meshLambertMaterial color={palette.slabTop} />
      </mesh>
      <Edge w={w} d={d} palette={palette} />
      <Tiles />
      <RoomPlatforms />
      <Walls />
      <HubCore />
      <ZoneSigns />
    </group>
  );
});

/** A hairline lip around the slab: tonal, not emissive. */
function Edge({ w, d, palette }: { w: number; d: number; palette: ScenePalette }) {
  const t = 0.05;
  const bars: [number, number, number, number][] = [
    [0, -d / 2, w, t],
    [0, d / 2, w, t],
    [-w / 2, 0, t, d],
    [w / 2, 0, t, d],
  ];
  return (
    <group position={[0, 0.006, 0]}>
      {bars.map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, 0, z]}>
          <boxGeometry args={[sx, 0.02, sz]} />
          <meshLambertMaterial color={palette.slabEdge} />
        </mesh>
      ))}
    </group>
  );
}

/** Every floor cell as one instanced tile with a barely visible per-tile shade. */
function Tiles() {
  const { world, palette } = useScene();
  const tiles = useMemo(() => floorTiles(world), [world]);
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const floors = new Map<string, string>();
    for (const z of world.def.zones) floors.set(z.id, zoneFloor(palette, z.color));
    const shade = palette.theme === 'light' ? palette.tokens.slateHi : palette.tokens.slate;
    tiles.forEach((t, i) => {
      const [x, , z] = toScene(world, t.cell[0], t.cell[1]);
      const room = t.zone && t.zone.kind !== 'hub';
      const h = room ? 0.05 : t.top;
      tmp.position.set(x, t.top - h / 2, z);
      tmp.scale.set(0.95, h, 0.95);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      const n = cellNoise(t.cell[0], t.cell[1]);
      const base = room ? floors.get(t.zone!.id)! : palette.corridor;
      tmpColor.set(mixHex(base, shade, n * 0.22));
      mesh.setColorAt(i, tmpColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [tiles, world, palette]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, tiles.length]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshLambertMaterial />
    </instancedMesh>
  );
}

/** Each room is a slightly raised platform under its tiles. */
function RoomPlatforms() {
  const { world, palette } = useScene();
  const rooms = world.def.zones.filter((z) => z.kind !== 'hub');
  return (
    <group>
      {rooms.map((z) => {
        const [rx, ry, rw, rh] = z.rect;
        const [cx, , cz] = toScene(world, rx + (rw - 1) / 2, ry + (rh - 1) / 2);
        return (
          <mesh key={z.id} position={[cx, (ROOM_Y - 0.05) / 2, cz]}>
            <boxGeometry args={[rw, ROOM_Y - 0.05, rh]} />
            <meshLambertMaterial color={mixHex(palette.slabTop, zoneFloor(palette, z.color), 0.5)} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * Walls: back (north/west) room walls are tall, front (south/east) walls are
 * low curbs so the inside stays visible. A thin cap in the room's muted tint
 * runs along the tops, and back walls carry dark glass panels.
 */
function Walls() {
  const { world, palette } = useScene();
  const walls = useMemo(() => classifyWalls(world), [world]);
  const blocks = useRef<InstancedMesh>(null);
  const caps = useRef<InstancedMesh>(null);
  const panels = useRef<InstancedMesh>(null);

  const panelInst = useMemo(() => {
    const out: { pos: [number, number, number]; rotY: number; color: string; wide: boolean }[] = [];
    for (const wc of walls) {
      if (wc.kind !== 'back' || !wc.zone) continue;
      const [gx, gy] = wc.cell;
      const [x, , z] = toScene(world, gx, gy);
      const [rx, ry, rw, rh] = wc.zone.rect;
      for (const [dx, dy] of [
        [0, 1],
        [1, 0],
      ] as const) {
        const nx = gx + dx;
        const ny = gy + dy;
        const inside = nx > rx && ny > ry && nx < rx + rw - 1 && ny < ry + rh - 1;
        if (!inside || isWall(world, nx, ny)) continue;
        const along = dx ? gy : gx;
        if (along % 2 !== 0) continue;
        out.push({ pos: [x + dx * 0.505, ROOM_Y + 0.8, z + dy * 0.505], rotY: dx ? Math.PI / 2 : 0, color: wc.zone.color, wide: along % 4 === 0 });
      }
    }
    return out;
  }, [walls, world]);

  useLayoutEffect(() => {
    const b = blocks.current;
    const c = caps.current;
    if (b && c) {
      walls.forEach((wc, i) => {
        const [x, , z] = toScene(world, wc.cell[0], wc.cell[1]);
        const h = wc.kind === 'back' ? ROOM_Y + BACK_WALL_H : ROOM_Y + CURB_H;
        tmp.rotation.set(0, 0, 0);
        tmp.position.set(x, h / 2, z);
        tmp.scale.set(1, h, 1);
        tmp.updateMatrix();
        b.setMatrixAt(i, tmp.matrix);
        const n = cellNoise(wc.cell[0] + 7, wc.cell[1] + 3);
        tmpColor.set(mixHex(wc.kind === 'back' ? palette.wall : palette.curb, palette.tokens.slateHi, n * 0.25));
        b.setColorAt(i, tmpColor);
        tmp.position.set(x, h + 0.02, z);
        tmp.scale.set(1.002, 0.04, 1.002);
        tmp.updateMatrix();
        c.setMatrixAt(i, tmp.matrix);
        tmpColor.set(wc.zone ? zoneCap(palette, wc.zone.color) : palette.wallCap);
        c.setColorAt(i, tmpColor);
      });
      for (const m of [b, c]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
      }
    }
    const p = panels.current;
    if (p) {
      panelInst.forEach((pi, i) => {
        tmp.position.set(...pi.pos);
        tmp.rotation.set(0, pi.rotY, 0);
        tmp.scale.set(pi.wide ? 0.78 : 0.5, pi.wide ? 0.42 : 0.62, 1);
        tmp.updateMatrix();
        p.setMatrixAt(i, tmp.matrix);
        tmpColor.set(mixHex(palette.screenOff, desaturate(pi.color, 0.4), pi.wide ? 0.14 : 0.08));
        p.setColorAt(i, tmpColor);
      });
      p.instanceMatrix.needsUpdate = true;
      if (p.instanceColor) p.instanceColor.needsUpdate = true;
      p.computeBoundingSphere();
    }
  }, [walls, world, palette, panelInst]);

  return (
    <group>
      <instancedMesh ref={blocks} args={[undefined, undefined, walls.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={caps} args={[undefined, undefined, walls.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial />
      </instancedMesh>
      {panelInst.length > 0 && (
        <instancedMesh ref={panels} args={[undefined, undefined, panelInst.length]} frustumCulled={false}>
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial roughness={0.25} metalness={0.2} />
        </instancedMesh>
      )}
    </group>
  );
}

/** Run status → colour of the Atrium ring. Lime only while the run executes. */
function ringColor(p: ScenePalette, status: RunExecStatus): { color: string; glow: boolean } {
  switch (status) {
    case 'running':
      return { color: p.active, glow: true };
    case 'succeeded':
      return { color: p.success, glow: true };
    case 'failed':
      return { color: p.failure, glow: true };
    case 'paused':
    case 'stopped':
    case 'interrupted':
      return { color: p.warning, glow: false };
    default:
      return { color: p.muted, glow: false };
  }
}

/**
 * The Atrium: a low pedestal on the core cells with a dark monolith. Its ring
 * is the only state on the board itself: the run's status (lime while it runs).
 */
function HubCore() {
  const { world, palette, getFrame, reducedMotion } = useScene();
  const hub = world.def.hub;
  const [x, , z] = toScene(world, hub.center[0], hub.center[1]);
  const xs = hub.core.map((c) => c[0]);
  const ys = hub.core.map((c) => c[1]);
  const span = hub.core.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 1 : 1.5;
  const r = span * 0.46;
  const ring = useRef<MeshBasicMaterial>(null);
  const status = useRef<RunExecStatus | null>(null);
  const base = useRef(new Color());

  useFrame(({ clock }) => {
    const m = ring.current;
    if (!m) return;
    const s = getFrame().state.exec.run.status;
    if (s !== status.current) {
      status.current = s;
      const c = ringColor(palette, s);
      base.current.copy(c.glow ? stateGlow(palette, c.color, 1.5) : new Color(c.color));
    }
    // A slow, quiet breath while the run executes (a state, not decoration); still under reduced motion.
    const k = s === 'running' && !reducedMotion ? 0.85 + 0.15 * Math.sin(clock.elapsedTime * 1.6) : 1;
    m.color.copy(base.current).multiplyScalar(k);
  });

  const top = palette.metal;
  return (
    <group position={[x, FLOOR_Y, z]}>
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[r * 1.18, r * 1.26, 0.2, 48]} />
        <meshStandardMaterial color={palette.metalDark} roughness={0.55} metalness={0.35} />
      </mesh>
      <mesh position={[0, 0.215, 0]}>
        <cylinderGeometry args={[r * 1.02, r * 1.1, 0.04, 48]} />
        <meshStandardMaterial color={top} roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, 0.236, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[r * 0.9, r * 0.98, 64]} />
        <meshBasicMaterial ref={ring} toneMapped={false} />
      </mesh>
      {/* Monolith: a quiet obsidian column with a lighter cap. */}
      <mesh position={[0, 0.78, 0]}>
        <boxGeometry args={[r * 0.62, 1.08, r * 0.62]} />
        <meshStandardMaterial color={palette.theme === 'light' ? palette.metalDark : palette.tokens.obsidian} roughness={0.3} metalness={0.5} />
      </mesh>
      <mesh position={[0, 1.335, 0]}>
        <boxGeometry args={[r * 0.66, 0.03, r * 0.66]} />
        <meshStandardMaterial color={palette.metalLight} roughness={0.35} metalness={0.5} />
      </mesh>
    </group>
  );
}

/** Environment names from the world definition, as signs at each room's outer corner. */
function ZoneSigns() {
  const { world } = useScene();
  return (
    <>
      {world.def.zones.map((z) => (
        <ZoneSign key={z.id} zone={z} />
      ))}
    </>
  );
}

function ZoneSign({ zone }: { zone: Zone }) {
  const { world, palette } = useScene();
  const anchor = useMemo(() => {
    const [gx, gy] = zoneSignCell(world, zone);
    if (zone.kind === 'hub') return new Vector3(...toScene(world, gx, gy, FLOOR_Y));
    // On top of the corner wall: tall at the back (north/west) corners, a curb at the front.
    const [rx, ry] = zone.rect;
    const back = Math.round(gx + 0.5) === rx || Math.round(gy + 0.5) === ry;
    return new Vector3(...toScene(world, gx, gy, ROOM_Y + (back ? BACK_WALL_H : CURB_H) + 0.05));
  }, [world, zone]);
  useLabel(`zone:${zone.id}`, { kind: 'zone', text: zone.label, color: zoneAccent(palette, zone.color) }, anchor);
  return null;
}
