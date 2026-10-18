'use client';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { Station } from '@runloop-world/world-engine';
import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { Color, DoubleSide, FrontSide, Vector3, type Mesh, type MeshBasicMaterial, type Object3D } from 'three';
import { stationStatuses, useScene, type StationStatus } from './context';
import { useLabel } from './labels';
import { cellTop, stationColor, stationFront, toScene, yawFor } from './layout';
import { stateGlow, zoneAccent, zoneScreen, type ScenePalette } from './palette';
import { blobShadowTexture } from './textures';

/** Animated parts a station model registers so the live status can drive them. */
interface Rig {
  screens: MeshBasicMaterial[];
  /** Test rig lights: [running, failing, verified]. */
  gauges: MeshBasicMaterial[];
  arm: Object3D | null;
  forearm: Object3D | null;
  rocket: Object3D | null;
}

/** What a station's screens show, from Layer-1 state only. */
type ScreenState = 'idle' | 'occupied' | 'busy' | 'awaiting' | 'incident';

function screenState(st: StationStatus): ScreenState {
  if (st.openIncidents.length > 0) return 'incident';
  if (st.busy) return 'busy';
  if (st.awaiting) return 'awaiting';
  return st.occupant ? 'occupied' : 'idle';
}

/**
 * Screen colours: at rest a dim glass in the environment's tint (a little
 * brighter while someone stands at it); lime only while a call runs here;
 * failure and warning for outcomes. Only the state colours glow.
 */
function screenColors(p: ScenePalette, zone: string): Record<ScreenState, Color> {
  return {
    idle: new Color(zoneScreen(p, zone, 0)),
    occupied: new Color(zoneScreen(p, zone, 1)),
    busy: stateGlow(p, p.active, 1.5),
    awaiting: stateGlow(p, p.warning, 1.4),
    incident: stateGlow(p, p.failure, 1.5),
  };
}

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
  const { world, getFrame, reducedMotion, palette } = ctx;
  const [hover, setHover] = useState(false);
  const zone = stationColor(world, station);
  const accent = zoneAccent(palette, zone);
  const colors = useMemo(() => screenColors(palette, zone), [palette, zone]);
  const gaugeOn = useMemo(() => [stateGlow(palette, palette.active, 1.6), stateGlow(palette, palette.failure, 1.6), stateGlow(palette, palette.success, 1.5)], [palette]);
  const gaugeOff = useMemo(() => new Color(palette.screenOff), [palette]);
  const rig = useRef<Rig>({ screens: [], gauges: [], arm: null, forearm: null, rocket: null }).current;
  const runRing = useRef<Mesh>(null);
  const runMat = useRef<MeshBasicMaterial>(null);
  const [fx, fy] = stationFront(station);
  const top = cellTop(world, station.cell[0], station.cell[1]);
  const [x, , z] = toScene(world, station.cell[0], station.cell[1]);
  const labelAnchor = useMemo(() => new Vector3(x, top + 1.9, z), [x, top, z]);
  useLabel(`station:${station.id}`, selected || hover ? { kind: 'station', text: station.label, color: accent } : null, labelAnchor);
  const runColor = useMemo(() => stateGlow(palette, palette.active, 1.6), [palette]);

  useFrame(({ clock }) => {
    const frame = getFrame();
    const st = stationStatuses(ctx, frame.state).get(station.id);
    if (!st) return;
    const t = clock.elapsedTime;
    const state = screenState(st);
    const pulse = state === 'busy' && !reducedMotion ? 0.82 + 0.18 * Math.sin(t * 5) : 1;
    for (const m of rig.screens) m.color.copy(colors[state]).multiplyScalar(pulse);

    if (rig.gauges.length === 3) {
      const lit = [st.busy, st.openIncidents.length > 0, st.openIncidents.length === 0 && st.resolvedIncidents.length > 0];
      rig.gauges.forEach((m, i) => m.color.copy(lit[i] ? gaugeOn[i]! : gaugeOff));
    }
    // Machines move only while a call runs here.
    const animate = st.busy && !reducedMotion && !frame.state.world.paused;
    if (rig.arm) rig.arm.rotation.y = animate ? Math.sin(t * 1.7) * 0.7 : 0.4;
    if (rig.forearm) rig.forearm.rotation.z = animate ? -0.9 + Math.sin(t * 3.1) * 0.35 : -0.9;
    if (rig.rocket) {
      rig.rocket.position.y = 0.12 + (animate ? 0.04 + Math.sin(t * 9) * 0.015 : 0);
      rig.rocket.rotation.y = animate ? t * 0.8 : 0;
    }
    if (runRing.current) runRing.current.visible = st.busy;
    if (runMat.current && st.busy) runMat.current.color.copy(runColor).multiplyScalar(pulse);
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
          <meshBasicMaterial map={blobShadowTexture()} transparent opacity={palette.theme === 'light' ? 0.25 : 0.5} depthWrite={false} />
        </mesh>
        <StationModel kind={station.kind} accent={accent} rig={rig} />
      </group>
      {/* Floor pad outline in the zone's muted tint. */}
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
        <ringGeometry args={[0.6, 0.635, 4]} />
        <meshBasicMaterial color={accent} transparent opacity={0.9} />
      </mesh>
      {/* Running station: a lime ring (active execution only). */}
      <mesh ref={runRing} position={[0, 0.016, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]} visible={false}>
        <ringGeometry args={[0.66, 0.71, 4]} />
        <meshBasicMaterial ref={runMat} color={runColor} toneMapped={false} />
      </mesh>
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
          <ringGeometry args={[0.78, 0.83, 4]} />
          <meshBasicMaterial color={palette.ice} transparent opacity={0.95} />
        </mesh>
      )}
    </group>
  );
});

/* ── Models (front = +z, origin on the floor at the cell centre) ─────────── */

function Metal({ tone = 'metal', rough = 0.45 }: { tone?: 'metal' | 'metalDark' | 'metalLight'; rough?: number }) {
  const { palette } = useScene();
  return <meshStandardMaterial color={palette[tone]} roughness={rough} metalness={0.35} />;
}

/** A screen whose colour carries the station's state (registered with the rig). */
function Screen({ rig, children, double }: { rig: Rig; children: ReactNode; double?: boolean }) {
  return (
    <mesh>
      {children}
      <meshBasicMaterial
        side={double ? DoubleSide : FrontSide}
        ref={(m) => {
          if (m && !rig.screens.includes(m)) rig.screens.push(m);
        }}
        toneMapped={false}
      />
    </mesh>
  );
}

function Glass() {
  const { palette } = useScene();
  return <meshStandardMaterial color={palette.screenOff} roughness={0.25} metalness={0.2} />;
}

function StationModel({ kind, accent, rig }: { kind: Station['kind']; accent: string; rig: Rig }) {
  switch (kind) {
    case 'library':
      return <Terminal rig={rig} />;
    case 'build':
      return <Workbench accent={accent} rig={rig} />;
    case 'test':
      return <TestRig rig={rig} />;
    case 'gate':
      return <Gate rig={rig} />;
    case 'ops':
      return <LaunchPad accent={accent} rig={rig} />;
  }
}

/** A thin status strip on a model's back face, so machines facing away from the camera still show their state. */
function BackStrip({ rig, y, z, w }: { rig: Rig; y: number; z: number; w: number }) {
  return (
    <group position={[0, y, z]} rotation={[0, Math.PI, 0]}>
      <Screen rig={rig}>
        <planeGeometry args={[w, 0.05]} />
      </Screen>
    </group>
  );
}

/** Library: a tall terminal with a big screen and a keyboard ledge. */
function Terminal({ rig }: { rig: Rig }) {
  return (
    <group position={[0, 0, -0.1]}>
      <mesh position={[0, 0.04, 0]}>
        <boxGeometry args={[0.82, 0.08, 0.6]} />
        <Metal tone="metalDark" />
      </mesh>
      <mesh position={[0, 0.74, -0.04]}>
        <boxGeometry args={[0.72, 1.32, 0.42]} />
        <Metal />
      </mesh>
      <mesh position={[0, 1.42, -0.04]}>
        <boxGeometry args={[0.76, 0.05, 0.46]} />
        <Metal tone="metalLight" />
      </mesh>
      <BackStrip rig={rig} y={1.2} z={-0.252} w={0.5} />
      <group position={[0, 0.98, 0.175]}>
        <mesh position={[0, 0, -0.005]}>
          <boxGeometry args={[0.62, 0.66, 0.02]} />
          <Glass />
        </mesh>
        <group position={[0, 0, 0.008]}>
          <Screen rig={rig}>
            <planeGeometry args={[0.56, 0.6]} />
          </Screen>
        </group>
      </group>
      <mesh position={[0, 0.56, 0.26]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.6, 0.05, 0.22]} />
        <Metal tone="metalLight" />
      </mesh>
    </group>
  );
}

/** Build: a workbench with a monitor and a robotic arm. */
function Workbench({ accent, rig }: { accent: string; rig: Rig }) {
  return (
    <group position={[0, 0, -0.05]}>
      <mesh position={[0, 0.52, 0]}>
        <boxGeometry args={[0.9, 0.06, 0.64]} />
        <Metal tone="metalLight" />
      </mesh>
      {[
        [-0.38, -0.25],
        [0.38, -0.25],
        [-0.38, 0.25],
        [0.38, 0.25],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx!, 0.24, lz!]}>
          <boxGeometry args={[0.06, 0.48, 0.06]} />
          <Metal tone="metalDark" />
        </mesh>
      ))}
      <mesh position={[0, 0.16, 0]}>
        <boxGeometry args={[0.8, 0.04, 0.52]} />
        <Metal tone="metalDark" />
      </mesh>
      {/* Monitor */}
      <mesh position={[-0.12, 0.66, -0.2]}>
        <boxGeometry args={[0.05, 0.2, 0.05]} />
        <Metal tone="metalDark" />
      </mesh>
      <mesh position={[-0.12, 0.88, -0.22]}>
        <boxGeometry args={[0.52, 0.34, 0.05]} />
        <Metal />
      </mesh>
      <group position={[-0.12, 0, 0]}>
        <BackStrip rig={rig} y={0.88} z={-0.247} w={0.32} />
      </group>
      <group position={[-0.12, 0.88, -0.193]}>
        <Screen rig={rig}>
          <planeGeometry args={[0.46, 0.28]} />
        </Screen>
      </group>
      {/* Part on the bench */}
      <mesh position={[-0.05, 0.6, 0.12]} rotation={[0, 0.5, 0]}>
        <boxGeometry args={[0.13, 0.13, 0.13]} />
        <Metal tone="metalLight" rough={0.3} />
      </mesh>
      {/* Robotic arm */}
      <group position={[0.3, 0.55, 0.02]}>
        <mesh position={[0, 0.04, 0]}>
          <cylinderGeometry args={[0.09, 0.11, 0.08, 16]} />
          <Metal tone="metalDark" />
        </mesh>
        <group ref={(o) => void (rig.arm = o)} position={[0, 0.08, 0]}>
          <group rotation={[0, 0, 0.35]}>
            <mesh position={[0, 0.17, 0]}>
              <boxGeometry args={[0.06, 0.34, 0.06]} />
              <meshStandardMaterial color={accent} roughness={0.45} metalness={0.3} />
            </mesh>
            <group ref={(o) => void (rig.forearm = o)} position={[0, 0.34, 0]} rotation={[0, 0, -0.9]}>
              <mesh>
                <sphereGeometry args={[0.045, 12, 12]} />
                <Metal tone="metalDark" />
              </mesh>
              <mesh position={[0, 0.13, 0]}>
                <boxGeometry args={[0.05, 0.26, 0.05]} />
                <meshStandardMaterial color={accent} roughness={0.45} metalness={0.3} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

/** Test: a rig with a status screen, three status lights and sample tubes. */
function TestRig({ rig }: { rig: Rig }) {
  return (
    <group position={[0, 0, -0.04]}>
      <mesh position={[0, 0.26, 0]}>
        <boxGeometry args={[0.86, 0.52, 0.6]} />
        <Metal />
      </mesh>
      <mesh position={[0, 0.54, 0]}>
        <boxGeometry args={[0.9, 0.04, 0.64]} />
        <Metal tone="metalLight" />
      </mesh>
      <mesh position={[0, 0.9, -0.26]}>
        <boxGeometry args={[0.84, 0.68, 0.08]} />
        <Metal tone="metalDark" />
      </mesh>
      <BackStrip rig={rig} y={1.1} z={-0.302} w={0.62} />
      <group position={[0, 0.94, -0.218]}>
        <Screen rig={rig}>
          <planeGeometry args={[0.66, 0.4]} />
        </Screen>
      </group>
      {[-0.22, 0, 0.22].map((gx, i) => (
        <mesh key={i} position={[gx, 0.32, 0.305]}>
          <circleGeometry args={[0.05, 20]} />
          <meshBasicMaterial
            ref={(m) => {
              if (m && !rig.gauges.includes(m)) rig.gauges[i] = m;
            }}
            toneMapped={false}
          />
        </mesh>
      ))}
      {[-0.25, 0.25].map((tx) => (
        <group key={tx} position={[tx, 0.56, 0.12]}>
          <mesh position={[0, 0.13, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.26, 12]} />
            <Glass />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Gate: an arch whose inner frame shows the approval state. */
function Gate({ rig }: { rig: Rig }) {
  return (
    <group>
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[0.96, 0.06, 0.52]} />
        <Metal tone="metalDark" />
      </mesh>
      {[-0.4, 0.4].map((px) => (
        <mesh key={px} position={[px, 0.72, 0]}>
          <boxGeometry args={[0.16, 1.38, 0.32]} />
          <Metal />
        </mesh>
      ))}
      <mesh position={[0, 1.48, 0]}>
        <boxGeometry args={[0.98, 0.16, 0.34]} />
        <Metal tone="metalLight" />
      </mesh>
      <group position={[0, 0, 0.17]}>
        {[
          [-0.31, 0.72, 0.03, 1.28],
          [0.31, 0.72, 0.03, 1.28],
          [0, 1.375, 0.65, 0.03],
        ].map(([sx, sy, w, h], i) => (
          <group key={i} position={[sx!, sy!, 0]}>
            <Screen rig={rig} double>
              <planeGeometry args={[w!, h!]} />
            </Screen>
          </group>
        ))}
      </group>
    </group>
  );
}

/** Ops: a round launch pad with a small rocket and a console. */
function LaunchPad({ accent, rig }: { accent: string; rig: Rig }) {
  const { palette } = useScene();
  return (
    <group>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.44, 0.48, 0.1, 32]} />
        <Metal tone="metalDark" />
      </mesh>
      <mesh position={[0, 0.102, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.32, 0.36, 40]} />
        <meshBasicMaterial color={accent} />
      </mesh>
      <group ref={(o) => void (rig.rocket = o)} position={[0, 0.12, -0.02]}>
        <mesh position={[0, 0.24, 0]}>
          <cylinderGeometry args={[0.1, 0.11, 0.42, 16]} />
          <meshStandardMaterial color={palette.robotShell} roughness={0.35} metalness={0.15} />
        </mesh>
        <mesh position={[0, 0.53, 0]}>
          <coneGeometry args={[0.1, 0.18, 16]} />
          <meshStandardMaterial color={accent} roughness={0.4} metalness={0.25} />
        </mesh>
        {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a) => (
          <mesh key={a} position={[Math.sin(a) * 0.11, 0.07, Math.cos(a) * 0.11]} rotation={[0, a, 0]}>
            <boxGeometry args={[0.02, 0.14, 0.1]} />
            <meshStandardMaterial color={accent} roughness={0.45} />
          </mesh>
        ))}
      </group>
      <group position={[0.36, 0, 0.3]} rotation={[0, -0.6, 0]}>
        <mesh position={[0, 0.26, 0]}>
          <boxGeometry args={[0.22, 0.52, 0.12]} />
          <Metal />
        </mesh>
        <group position={[0, 0.4, 0.062]}>
          <Screen rig={rig}>
            <planeGeometry args={[0.16, 0.16]} />
          </Screen>
        </group>
      </group>
    </group>
  );
}
