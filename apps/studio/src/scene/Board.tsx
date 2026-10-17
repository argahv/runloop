'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { Zone } from '@runloop-world/world-engine';
import { AdditiveBlending, Color, Object3D, Vector3, type InstancedMesh, type Mesh, type MeshBasicMaterial } from 'three';
import { useScene } from './context';
import { useLabel } from './labels';
import {
  BACK_WALL_H,
  CURB_H,
  FLOOR_Y,
  ROOM_Y,
  cellNoise,
  classifyWalls,
  floorTiles,
  isWall,
  toScene,
} from './layout';
import { PALETTE, glow, mix } from './palette';
import { glowTexture } from './textures';

const tmp = new Object3D();
const tmpColor = new Color();

/** The diorama: base slab with amber rim, floor tiles, raised rooms, cutaway walls and the hub core. */
export const Board = memo(function Board() {
  const { world } = useScene();
  const w = world.width + 1.6;
  const d = world.height + 1.6;
  return (
    <group>
      {/* Base slab, slightly larger than the grid, with a thin glowing amber rim. */}
      <mesh position={[0, -0.35, 0]}>
        <boxGeometry args={[w, 0.7, d]} />
        <meshLambertMaterial color={PALETTE.slabSide} />
      </mesh>
      <mesh position={[0, -0.004, 0]}>
        <boxGeometry args={[w - 0.12, 0.01, d - 0.12]} />
        <meshLambertMaterial color={PALETTE.slabTop} />
      </mesh>
      <Rim w={w} d={d} y={0.005} thickness={0.07} color={PALETTE.rim} intensity={2.2} />
      <Rim w={w + 0.04} d={d + 0.04} y={-0.62} thickness={0.04} color={PALETTE.purple} intensity={1.2} />
      <Tiles />
      <Studs w={w} d={d} />
      <RoomPlatforms />
      <Walls />
      <HubCore />
      <ZoneLabels />
    </group>
  );
});

function Rim({ w, d, y, thickness, color, intensity }: { w: number; d: number; y: number; thickness: number; color: string; intensity: number }) {
  const c = useMemo(() => glow(color, intensity), [color, intensity]);
  const t = thickness;
  const bars: [number, number, number, number][] = [
    [0, -d / 2, w, t],
    [0, d / 2, w, t],
    [-w / 2, 0, t, d],
    [w / 2, 0, t, d],
  ];
  return (
    <group position={[0, y, 0]}>
      {bars.map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, 0, z]}>
          <boxGeometry args={[sx, t * 0.6, sz]} />
          <meshBasicMaterial color={c} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Every floor cell as one instanced tile with a subtle per-tile shade. */
function Tiles() {
  const { world } = useScene();
  const tiles = useMemo(() => floorTiles(world), [world]);
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    tiles.forEach((t, i) => {
      const [x, , z] = toScene(world, t.cell[0], t.cell[1]);
      const h = t.zone && t.zone.kind !== 'hub' ? 0.05 : t.top;
      tmp.position.set(x, t.top - h / 2, z);
      tmp.scale.set(0.93, h, 0.93);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      const n = cellNoise(t.cell[0], t.cell[1]);
      if (t.zone && t.zone.kind !== 'hub') tmpColor.copy(mix(PALETTE.tile, t.zone.color, 0.1 + n * 0.05));
      else if (t.zone) tmpColor.copy(mix(PALETTE.corridorTile, t.zone.color, 0.06 + n * 0.04));
      else tmpColor.copy(mix(PALETTE.corridorTile, '#33415a', n * 0.35));
      mesh.setColorAt(i, tmpColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [tiles, world]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, tiles.length]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshLambertMaterial />
    </instancedMesh>
  );
}

/**
 * Small glowing floor studs: a dotted amber border on the slab margin and a
 * sparse scatter of cyan/purple lights in corridor tile corners.
 */
function Studs({ w, d }: { w: number; d: number }) {
  const { world } = useScene();
  const ref = useRef<InstancedMesh>(null);
  const studs = useMemo(() => {
    const out: { x: number; z: number; y: number; color: Color }[] = [];
    const amber = glow(PALETTE.amber, 1.6);
    const step = 1;
    for (let x = -w / 2 + 0.4; x <= w / 2 - 0.4 + 1e-6; x += step) {
      out.push({ x, z: -d / 2 + 0.4, y: 0.004, color: amber }, { x, z: d / 2 - 0.4, y: 0.004, color: amber });
    }
    for (let z = -d / 2 + 0.4 + step; z <= d / 2 - 0.4 - step + 1e-6; z += step) {
      out.push({ x: -w / 2 + 0.4, z, y: 0.004, color: amber }, { x: w / 2 - 0.4, z, y: 0.004, color: amber });
    }
    for (const t of floorTiles(world)) {
      if (t.zone) continue;
      const n = cellNoise(t.cell[0] * 3 + 1, t.cell[1] * 5 + 2);
      if (n > 0.14) continue;
      const [x, , z] = toScene(world, t.cell[0] + 0.5, t.cell[1] + 0.5);
      out.push({ x, z, y: t.top + 0.002, color: glow(n < 0.07 ? PALETTE.cyan : PALETTE.purple, 1.4) });
    }
    return out;
  }, [world, w, d]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    studs.forEach((s, i) => {
      tmp.position.set(s.x, s.y, s.z);
      tmp.rotation.set(-Math.PI / 2, 0, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      mesh.setColorAt(i, s.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [studs]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, studs.length]} frustumCulled={false}>
      <planeGeometry args={[0.09, 0.09]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/** Each room is a slightly raised, tinted platform with a soft pool of light in its colour. */
function RoomPlatforms() {
  const { world } = useScene();
  const rooms = world.def.zones.filter((z) => z.kind !== 'hub');
  const tex = glowTexture();
  return (
    <group>
      {rooms.map((z) => {
        const [rx, ry, rw, rh] = z.rect;
        const [cx, , cz] = toScene(world, rx + (rw - 1) / 2, ry + (rh - 1) / 2);
        return (
          <group key={z.id}>
            <mesh position={[cx, (ROOM_Y - 0.05) / 2, cz]}>
              <boxGeometry args={[rw, ROOM_Y - 0.05, rh]} />
              <meshLambertMaterial color={mix(PALETTE.slabTop, z.color, 0.12)} />
            </mesh>
            <mesh position={[cx, ROOM_Y + 0.006, cz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[rw * 0.95, rh * 0.95]} />
              <meshBasicMaterial
                map={tex}
                color={z.color}
                transparent
                opacity={0.22}
                blending={AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/**
 * Walls: back (north/west) room walls are tall, front (south/east) walls are
 * low curbs so the inside stays visible. A glowing line runs along every wall
 * top, and back walls carry glowing panels on their inner face.
 */
function Walls() {
  const { world } = useScene();
  const walls = useMemo(() => classifyWalls(world), [world]);
  const blocks = useRef<InstancedMesh>(null);
  const lines = useRef<InstancedMesh>(null);
  const panels = useRef<InstancedMesh>(null);

  const layout = useMemo(() => {
    const lineInst: { pos: [number, number, number]; scale: [number, number, number]; color: string }[] = [];
    const panelInst: { pos: [number, number, number]; rotY: number; color: string; wide: boolean }[] = [];
    for (const wc of walls) {
      const [gx, gy] = wc.cell;
      const top = wc.kind === 'back' ? ROOM_Y + BACK_WALL_H : ROOM_Y + CURB_H;
      const color = wc.zone?.color ?? PALETTE.amber;
      const [x, , z] = toScene(world, gx, gy);
      // Half-lines from the centre towards each neighbouring wall cell (joins into one outline).
      let joined = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (!isWall(world, gx + dx, gy + dy)) continue;
        joined = true;
        lineInst.push({
          pos: [x + dx * 0.25, top + 0.012, z + dy * 0.25],
          scale: [dx ? 0.56 : 0.06, 0.02, dy ? 0.56 : 0.06],
          color,
        });
      }
      if (!joined) lineInst.push({ pos: [x, top + 0.012, z], scale: [0.3, 0.02, 0.3], color });
      // Panels on the inner face of back walls (towards room cells that are not walls).
      if (wc.kind === 'back' && wc.zone) {
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
          panelInst.push({
            pos: [x + dx * 0.505, ROOM_Y + 0.78, z + dy * 0.505],
            rotY: dx ? Math.PI / 2 : 0,
            color,
            wide: along % 4 === 0,
          });
        }
      }
    }
    return { lineInst, panelInst };
  }, [walls, world]);

  useLayoutEffect(() => {
    const b = blocks.current;
    if (b) {
      walls.forEach((wc, i) => {
        const [x, , z] = toScene(world, wc.cell[0], wc.cell[1]);
        const h = wc.kind === 'back' ? ROOM_Y + BACK_WALL_H : ROOM_Y + CURB_H;
        tmp.position.set(x, h / 2, z);
        tmp.scale.set(1, h, 1);
        tmp.rotation.set(0, 0, 0);
        tmp.updateMatrix();
        b.setMatrixAt(i, tmp.matrix);
        const n = cellNoise(wc.cell[0] + 7, wc.cell[1] + 3);
        tmpColor.copy(mix(wc.kind === 'back' ? PALETTE.wall : PALETTE.curb, '#3a4a66', n * 0.25));
        b.setColorAt(i, tmpColor);
      });
      b.instanceMatrix.needsUpdate = true;
      if (b.instanceColor) b.instanceColor.needsUpdate = true;
      b.computeBoundingSphere();
    }
    const l = lines.current;
    if (l) {
      layout.lineInst.forEach((li, i) => {
        tmp.position.set(...li.pos);
        tmp.scale.set(...li.scale);
        tmp.rotation.set(0, 0, 0);
        tmp.updateMatrix();
        l.setMatrixAt(i, tmp.matrix);
        l.setColorAt(i, glow(li.color, 1.6));
      });
      l.instanceMatrix.needsUpdate = true;
      if (l.instanceColor) l.instanceColor.needsUpdate = true;
      l.computeBoundingSphere();
    }
    const p = panels.current;
    if (p) {
      layout.panelInst.forEach((pi, i) => {
        tmp.position.set(...pi.pos);
        tmp.rotation.set(0, pi.rotY, 0);
        tmp.scale.set(pi.wide ? 0.78 : 0.5, pi.wide ? 0.42 : 0.62, 1);
        tmp.updateMatrix();
        p.setMatrixAt(i, tmp.matrix);
        p.setColorAt(i, mix('#0b1220', pi.color, pi.wide ? 0.55 : 0.32));
      });
      p.instanceMatrix.needsUpdate = true;
      if (p.instanceColor) p.instanceColor.needsUpdate = true;
      p.computeBoundingSphere();
    }
  }, [walls, world, layout]);

  return (
    <group>
      <instancedMesh ref={blocks} args={[undefined, undefined, walls.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={lines} args={[undefined, undefined, layout.lineInst.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {layout.panelInst.length > 0 && (
        <instancedMesh ref={panels} args={[undefined, undefined, layout.panelInst.length]} frustumCulled={false}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      )}
    </group>
  );
}

/** The hub: a pedestal on the core cells with a pulsing ring and a glowing core column. */
function HubCore() {
  const { world, reducedMotion } = useScene();
  const hub = world.def.hub;
  const hubZone = world.def.zones.find((z) => z.kind === 'hub');
  const color = hubZone?.color ?? PALETTE.amber;
  const [x, , z] = toScene(world, hub.center[0], hub.center[1]);
  const xs = hub.core.map((c) => c[0]);
  const ys = hub.core.map((c) => c[1]);
  const span = hub.core.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 1 : 1.5;
  const r = span * 0.46;
  const ring = useRef<MeshBasicMaterial>(null);
  const floatRing = useRef<Mesh>(null);
  const core = useRef<MeshBasicMaterial>(null);
  const ringColor = useMemo(() => glow(color, 2), [color]);
  const coreColor = useMemo(() => glow(PALETTE.cyan, 1.6), []);
  const tex = glowTexture();

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.elapsedTime;
    const pulse = 0.75 + 0.25 * Math.sin(t * 2.2);
    ring.current?.color.copy(ringColor).multiplyScalar(pulse);
    core.current?.color.copy(coreColor).multiplyScalar(0.85 + 0.2 * Math.sin(t * 3.1));
    if (floatRing.current) {
      floatRing.current.rotation.z = t * 0.6;
      floatRing.current.position.y = 1.45 + Math.sin(t * 1.4) * 0.05;
    }
  });

  return (
    <group position={[x, FLOOR_Y, z]}>
      {/* Light pool + outer floor ring around the hub. */}
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[r * 5.2, r * 5.2]} />
        <meshBasicMaterial map={tex} color={color} transparent opacity={0.3} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[r * 2.05, r * 2.15, 64]} />
        <meshBasicMaterial color={glow(color, 1.4)} toneMapped={false} transparent opacity={0.8} />
      </mesh>
      {/* Pedestal */}
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[r * 1.12, r * 1.22, 0.24, 40]} />
        <meshStandardMaterial color={PALETTE.metalDark} roughness={0.45} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <cylinderGeometry args={[r * 0.95, r * 1.05, 0.06, 40]} />
        <meshStandardMaterial color={PALETTE.metalLight} roughness={0.35} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[r * 1.12, 0.035, 8, 64]} />
        <meshBasicMaterial ref={ring} color={ringColor} toneMapped={false} />
      </mesh>
      {/* Core column + crystal */}
      <mesh position={[0, 0.75, 0]}>
        <cylinderGeometry args={[r * 0.32, r * 0.4, 0.95, 24]} />
        <meshBasicMaterial ref={core} color={coreColor} toneMapped={false} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, 1.42, 0]}>
        <octahedronGeometry args={[r * 0.36, 0]} />
        <meshStandardMaterial color="#c4b5fd" emissive={PALETTE.purple} emissiveIntensity={1.6} roughness={0.2} metalness={0.3} />
      </mesh>
      <mesh ref={floatRing} position={[0, 1.45, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[r * 0.75, 0.025, 8, 48]} />
        <meshBasicMaterial color={glow(PALETTE.purple, 2)} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Room names as small signs above each room's back corner. */
function ZoneLabels() {
  const { world } = useScene();
  return (
    <>
      {world.def.zones
        .filter((z) => z.kind !== 'hub')
        .map((z) => (
          <ZoneLabel key={z.id} zone={z} />
        ))}
    </>
  );
}

function ZoneLabel({ zone }: { zone: Zone }) {
  const { world } = useScene();
  const anchor = useMemo(() => {
    const [rx, ry] = zone.rect;
    return new Vector3(...toScene(world, rx + 1.2, ry, ROOM_Y + BACK_WALL_H + 0.55));
  }, [world, zone]);
  useLabel(`zone:${zone.id}`, { kind: 'zone', text: zone.label, color: zone.color }, anchor);
  return null;
}
