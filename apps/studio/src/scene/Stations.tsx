'use client';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { Station } from '@runloop-world/world-engine';
import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { Color, DoubleSide, FrontSide, Vector3, type Group, type MeshBasicMaterial, type Object3D } from 'three';
import { stationStatuses, useScene } from './context';
import { useLabel } from './labels';
import { cellTop, stationColor, stationFront, toScene, yawFor } from './layout';
import { PALETTE, glow } from './palette';
import { blobShadowTexture } from './textures';

/** Animated parts a station model registers so the live status can drive them. */
interface Rig {
  screens: MeshBasicMaterial[];
  /** Test rig gauge lights: [ok, busy, error]. */
  gauges: MeshBasicMaterial[];
  arm: Object3D | null;
  forearm: Object3D | null;
  rocket: Object3D | null;
}

const ERR = new Color(PALETTE.err);
const GAUGE = [glow(PALETTE.ok, 2), glow(PALETTE.warn, 2), glow(PALETTE.err, 2.2)];
const tmp = new Color();

export function Stations({
  selectedStationId,
  onSelectStation,
}: {
  selectedStationId: string | null;
  onSelectStation: (id: string | null) => void;
}) {
  const { world } = useScene();
  return (
    <group>
      {world.def.stations.map((s) => (
        <StationNode key={s.id} station={s} selected={s.id === selectedStationId} onSelect={onSelectStation} />
      ))}
    </group>
  );
}

const StationNode = memo(function StationNode({
  station,
  selected,
  onSelect,
}: {
  station: Station;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const ctx = useScene();
  const { world, getFrame, reducedMotion } = ctx;
  const [hover, setHover] = useState(false);
  const color = stationColor(world, station);
  const zoneColor = useMemo(() => new Color(color), [color]);
  const padColor = useMemo(() => glow(color, 1.1), [color]);
  const rig = useRef<Rig>({ screens: [], gauges: [], arm: null, forearm: null, rocket: null }).current;
  const ring = useRef<Group>(null);
  const [fx, fy] = stationFront(station);
  const top = cellTop(world, station.cell[0], station.cell[1]);
  const [x, , z] = toScene(world, station.cell[0], station.cell[1]);
  const labelAnchor = useMemo(() => new Vector3(x, top + 2.4, z), [x, top, z]);
  useLabel(`station:${station.id}`, selected || hover ? { kind: 'station', text: station.label, color } : null, labelAnchor);

  useFrame(({ clock }) => {
    const frame = getFrame();
    const st = stationStatuses(ctx, frame.state).get(station.id);
    if (!st) return;
    const t = clock.elapsedTime;
    const occupied = st.occupant !== null;
    const open = st.openIncidents.length > 0;
    let k = occupied ? 1.6 : 0.95;
    if (st.busy) k = reducedMotion ? 2 : 1.3 + 0.9 * (0.5 + 0.5 * Math.sin(t * 11));
    tmp.copy(zoneColor);
    if (open) tmp.lerp(ERR, 0.75);
    for (const m of rig.screens) m.color.copy(tmp).multiplyScalar(k);

    if (rig.gauges.length === 3) {
      const lit = [occupied && !open && !st.busy, st.busy, open];
      rig.gauges.forEach((m, i) => {
        const blink = i === 1 && st.busy && !reducedMotion ? 0.5 + 0.5 * Math.sin(t * 14) : 1;
        m.color.copy(GAUGE[i]!).multiplyScalar(lit[i] ? blink : 0.12);
      });
    }
    const animate = occupied && !reducedMotion && !frame.state.world.paused;
    if (rig.arm) rig.arm.rotation.y = animate ? Math.sin(t * 1.7) * 0.7 : 0.4;
    if (rig.forearm) rig.forearm.rotation.z = animate ? -0.9 + Math.sin(t * 3.1) * 0.35 : -0.9;
    if (rig.rocket) {
      rig.rocket.position.y = 0.12 + (st.busy && !reducedMotion ? 0.06 + Math.sin(t * 9) * 0.02 : 0);
      rig.rocket.rotation.y = animate ? t * 0.8 : 0;
    }
    if (ring.current && !reducedMotion) ring.current.scale.setScalar(1 + 0.04 * Math.sin(t * 4));
  });

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(station.id);
  };

  return (
    <group position={[x, top, z]}>
      <group
        rotation={[0, yawFor(fx, fy), 0]}
        onClick={select}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHover(false);
          document.body.style.cursor = '';
        }}
      >
        <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1.25, 1.25]} />
          <meshBasicMaterial map={blobShadowTexture()} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        <StationModel kind={station.kind} color={color} rig={rig} />
      </group>
      {/* Floor pad outline in the zone colour. */}
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
        <ringGeometry args={[0.6, 0.64, 4]} />
        <meshBasicMaterial color={padColor} toneMapped={false} transparent opacity={0.85} />
      </mesh>
      {selected && (
        <group ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
          <mesh>
            <ringGeometry args={[0.72, 0.8, 4]} />
            <meshBasicMaterial color={glow('#f8fafc', 1.6)} toneMapped={false} transparent opacity={0.95} />
          </mesh>
        </group>
      )}
    </group>
  );
});

/* ── Models (front = +z, origin on the floor at the cell centre) ─────────── */

function Metal({ color = PALETTE.metal, rough = 0.45 }: { color?: string; rough?: number }) {
  return <meshStandardMaterial color={color} roughness={rough} metalness={0.55} />;
}

function Screen({ rig, color, children, double }: { rig: Rig; color: string; children: ReactNode; double?: boolean }) {
  return (
    <mesh>
      {children}
      <meshBasicMaterial
        side={double ? DoubleSide : FrontSide}
        ref={(m) => {
          if (m && !rig.screens.includes(m)) rig.screens.push(m);
        }}
        color={glow(color, 1.2)}
        toneMapped={false}
      />
    </mesh>
  );
}

function StationModel({ kind, color, rig }: { kind: Station['kind']; color: string; rig: Rig }) {
  switch (kind) {
    case 'library':
      return <Terminal color={color} rig={rig} />;
    case 'build':
      return <Workbench color={color} rig={rig} />;
    case 'test':
      return <TestRig color={color} rig={rig} />;
    case 'gate':
      return <Gate color={color} rig={rig} />;
    case 'ops':
      return <LaunchPad color={color} rig={rig} />;
  }
}

/** A thin glowing strip on a model's back face, so machines facing away from the camera still read as live. */
function BackStrip({ rig, color, y, z, w }: { rig: Rig; color: string; y: number; z: number; w: number }) {
  return (
    <group position={[0, y, z]} rotation={[0, Math.PI, 0]}>
      <Screen rig={rig} color={color}>
        <planeGeometry args={[w, 0.05]} />
      </Screen>
    </group>
  );
}

/** Library: a tall terminal with a big screen and a keyboard ledge. */
function Terminal({ color, rig }: { color: string; rig: Rig }) {
  return (
    <group position={[0, 0, -0.1]}>
      <mesh position={[0, 0.04, 0]}>
        <boxGeometry args={[0.82, 0.08, 0.6]} />
        <Metal color={PALETTE.metalDark} />
      </mesh>
      <mesh position={[0, 0.74, -0.04]}>
        <boxGeometry args={[0.72, 1.32, 0.42]} />
        <Metal />
      </mesh>
      <mesh position={[0, 1.42, -0.04]}>
        <boxGeometry args={[0.76, 0.06, 0.46]} />
        <Metal color={PALETTE.metalLight} />
      </mesh>
      <BackStrip rig={rig} color={color} y={1.2} z={-0.252} w={0.5} />
      <BackStrip rig={rig} color={color} y={1.1} z={-0.252} w={0.5} />
      <group position={[0, 0.98, 0.175]}>
        <mesh position={[0, 0, -0.005]}>
          <boxGeometry args={[0.62, 0.66, 0.02]} />
          <meshStandardMaterial color="#05080f" roughness={0.3} />
        </mesh>
        <group position={[0, 0, 0.008]}>
          <Screen rig={rig} color={color}>
            <planeGeometry args={[0.56, 0.6]} />
          </Screen>
        </group>
      </group>
      <mesh position={[0, 0.56, 0.26]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.6, 0.05, 0.22]} />
        <Metal color={PALETTE.metalLight} />
      </mesh>
      {[-0.2, 0, 0.2].map((dx, i) => (
        <mesh key={i} position={[dx, 0.25, 0.175]}>
          <boxGeometry args={[0.12, 0.03, 0.01]} />
          <meshBasicMaterial color={glow(i === 1 ? PALETTE.amber : color, 1.4)} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Build: a workbench with a monitor and a robotic arm. */
function Workbench({ color, rig }: { color: string; rig: Rig }) {
  return (
    <group position={[0, 0, -0.05]}>
      <mesh position={[0, 0.52, 0]}>
        <boxGeometry args={[0.9, 0.08, 0.64]} />
        <Metal color={PALETTE.metalLight} />
      </mesh>
      {[
        [-0.38, -0.25],
        [0.38, -0.25],
        [-0.38, 0.25],
        [0.38, 0.25],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx!, 0.24, lz!]}>
          <boxGeometry args={[0.07, 0.48, 0.07]} />
          <Metal color={PALETTE.metalDark} />
        </mesh>
      ))}
      <mesh position={[0, 0.16, 0]}>
        <boxGeometry args={[0.8, 0.04, 0.52]} />
        <Metal color={PALETTE.metalDark} />
      </mesh>
      {/* Monitor */}
      <mesh position={[-0.12, 0.66, -0.2]}>
        <boxGeometry args={[0.06, 0.2, 0.06]} />
        <Metal color={PALETTE.metalDark} />
      </mesh>
      <mesh position={[-0.12, 0.88, -0.22]}>
        <boxGeometry args={[0.52, 0.34, 0.05]} />
        <Metal />
      </mesh>
      <group position={[-0.12, 0, 0]}>
        <BackStrip rig={rig} color={color} y={0.88} z={-0.247} w={0.32} />
      </group>
      <group position={[-0.12, 0.88, -0.193]}>
        <Screen rig={rig} color={color}>
          <planeGeometry args={[0.46, 0.28]} />
        </Screen>
      </group>
      {/* Part on the bench */}
      <mesh position={[-0.05, 0.62, 0.12]} rotation={[0, 0.5, 0]}>
        <boxGeometry args={[0.13, 0.13, 0.13]} />
        <meshStandardMaterial color={PALETTE.metalLight} emissive={color} emissiveIntensity={0.6} roughness={0.3} />
      </mesh>
      {/* Robotic arm */}
      <group position={[0.3, 0.56, 0.02]}>
        <mesh position={[0, 0.04, 0]}>
          <cylinderGeometry args={[0.09, 0.11, 0.08, 16]} />
          <Metal color={PALETTE.metalDark} />
        </mesh>
        <group ref={(o) => void (rig.arm = o)} position={[0, 0.08, 0]}>
          <group rotation={[0, 0, 0.35]}>
            <mesh position={[0, 0.17, 0]}>
              <boxGeometry args={[0.06, 0.34, 0.06]} />
              <meshStandardMaterial color={PALETTE.amber} roughness={0.4} metalness={0.4} />
            </mesh>
            <group ref={(o) => void (rig.forearm = o)} position={[0, 0.34, 0]} rotation={[0, 0, -0.9]}>
              <mesh>
                <sphereGeometry args={[0.045, 12, 12]} />
                <Metal color={PALETTE.metalDark} />
              </mesh>
              <mesh position={[0, 0.13, 0]}>
                <boxGeometry args={[0.05, 0.26, 0.05]} />
                <meshStandardMaterial color={PALETTE.amber} roughness={0.4} metalness={0.4} />
              </mesh>
              <mesh position={[0, 0.27, 0]}>
                <sphereGeometry args={[0.035, 10, 10]} />
                <meshBasicMaterial color={glow(color, 2)} toneMapped={false} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

/** Test: a rig with a status screen, gauge lights and sample tubes. */
function TestRig({ color, rig }: { color: string; rig: Rig }) {
  return (
    <group position={[0, 0, -0.04]}>
      <mesh position={[0, 0.26, 0]}>
        <boxGeometry args={[0.86, 0.52, 0.6]} />
        <Metal />
      </mesh>
      <mesh position={[0, 0.54, 0]}>
        <boxGeometry args={[0.9, 0.05, 0.64]} />
        <Metal color={PALETTE.metalLight} />
      </mesh>
      <mesh position={[0, 0.9, -0.26]}>
        <boxGeometry args={[0.84, 0.68, 0.08]} />
        <Metal color={PALETTE.metalDark} />
      </mesh>
      <BackStrip rig={rig} color={color} y={1.1} z={-0.302} w={0.62} />
      <BackStrip rig={rig} color={color} y={0.98} z={-0.302} w={0.62} />
      <group position={[0, 0.94, -0.218]}>
        <Screen rig={rig} color={color}>
          <planeGeometry args={[0.66, 0.4]} />
        </Screen>
      </group>
      {[-0.22, 0, 0.22].map((gx, i) => (
        <mesh key={i} position={[gx, 0.32, 0.305]}>
          <circleGeometry args={[0.055, 20]} />
          <meshBasicMaterial
            ref={(m) => {
              if (m && !rig.gauges.includes(m)) rig.gauges[i] = m;
            }}
            color={GAUGE[i]}
            toneMapped={false}
          />
        </mesh>
      ))}
      {[-0.25, 0.25].map((tx, i) => (
        <group key={i} position={[tx, 0.57, 0.12]}>
          <mesh position={[0, 0.13, 0]}>
            <cylinderGeometry args={[0.055, 0.055, 0.26, 12]} />
            <meshStandardMaterial color="#cbd5e1" transparent opacity={0.35} roughness={0.1} />
          </mesh>
          <mesh position={[0, 0.07, 0]}>
            <cylinderGeometry args={[0.045, 0.045, 0.13, 12]} />
            <meshBasicMaterial color={glow(i ? PALETTE.cyan : color, 1.5)} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Gate: an arch with a glowing inner frame. */
function Gate({ color, rig }: { color: string; rig: Rig }) {
  return (
    <group>
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[0.96, 0.06, 0.52]} />
        <Metal color={PALETTE.metalDark} />
      </mesh>
      {[-0.4, 0.4].map((px) => (
        <mesh key={px} position={[px, 0.72, 0]}>
          <boxGeometry args={[0.16, 1.38, 0.32]} />
          <Metal />
        </mesh>
      ))}
      <mesh position={[0, 1.48, 0]}>
        <boxGeometry args={[0.98, 0.18, 0.34]} />
        <Metal color={PALETTE.metalLight} />
      </mesh>
      <group position={[0, 0, 0.17]}>
        {[
          [-0.31, 0.72, 0.03, 1.28],
          [0.31, 0.72, 0.03, 1.28],
          [0, 1.375, 0.65, 0.03],
        ].map(([sx, sy, w, h], i) => (
          <group key={i} position={[sx!, sy!, 0]}>
            <Screen rig={rig} color={color} double>
              <planeGeometry args={[w!, h!]} />
            </Screen>
          </group>
        ))}
        <group position={[0, 1.48, 0.002]}>
          <Screen rig={rig} color={color}>
            <planeGeometry args={[0.5, 0.08]} />
          </Screen>
        </group>
      </group>
      <mesh position={[0, 0.065, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.6, 0.4]} />
        <meshBasicMaterial color={glow(color, 0.9)} toneMapped={false} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

/** Ops: a round launch pad with a small rocket and a console. */
function LaunchPad({ color, rig }: { color: string; rig: Rig }) {
  return (
    <group>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.44, 0.48, 0.1, 32]} />
        <Metal color={PALETTE.metalDark} />
      </mesh>
      <mesh position={[0, 0.105, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.36, 0.022, 8, 40]} />
        <meshBasicMaterial color={glow(color, 2)} toneMapped={false} />
      </mesh>
      <group ref={(o) => void (rig.rocket = o)} position={[0, 0.12, -0.02]}>
        <mesh position={[0, 0.24, 0]}>
          <cylinderGeometry args={[0.1, 0.11, 0.42, 16]} />
          <meshStandardMaterial color={PALETTE.robotShell} roughness={0.3} metalness={0.2} />
        </mesh>
        <mesh position={[0, 0.53, 0]}>
          <coneGeometry args={[0.1, 0.18, 16]} />
          <meshStandardMaterial color={color} roughness={0.35} metalness={0.3} />
        </mesh>
        <mesh position={[0, 0.3, 0.1]}>
          <circleGeometry args={[0.035, 12]} />
          <meshBasicMaterial color={glow(PALETTE.cyan, 1.8)} toneMapped={false} />
        </mesh>
        {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a) => (
          <mesh key={a} position={[Math.sin(a) * 0.11, 0.07, Math.cos(a) * 0.11]} rotation={[0, a, 0]}>
            <boxGeometry args={[0.02, 0.14, 0.1]} />
            <meshStandardMaterial color={color} roughness={0.4} />
          </mesh>
        ))}
      </group>
      <group position={[0.36, 0, 0.3]} rotation={[0, -0.6, 0]}>
        <mesh position={[0, 0.26, 0]}>
          <boxGeometry args={[0.22, 0.52, 0.12]} />
          <Metal />
        </mesh>
        <group position={[0, 0.4, 0.062]}>
          <Screen rig={rig} color={color}>
            <planeGeometry args={[0.16, 0.16]} />
          </Screen>
        </group>
      </group>
    </group>
  );
}
