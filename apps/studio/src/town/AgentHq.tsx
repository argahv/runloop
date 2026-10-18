'use client';
import { useFrame } from '@react-three/fiber';
import type { AgentPresence } from '@runloop-world/events';
import type { Lot } from '@runloop-world/town';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { MeshBasicMaterial, MeshLambertMaterial, Vector3, type Group, type Mesh } from 'three';
import { DARK_TOKENS } from '../scene/palette';
import { mixHex } from './color';
import { cellY, yawOf } from './coords';
import { AgentHouse } from './AgentHouse';
import { AgentRobot, ROBOT_TOWN_HEIGHT } from './AgentRobot';
import { isDimmedHq, isLitHq, robotStateOf, type RobotState } from './status';
import { useTown } from './context';
import { GeoBuilder } from './geometry/builder';
import { rectFrame, type LocalFrame } from './geometry/frame';
import { AGENT_HQ_COLORS as HQ } from './townPalette';

export interface HqLayout {
  frame: LocalFrame;
  /** The robot stands on the forecourt by the door, facing the street. */
  robot: Vector3;
  robotYaw: number;
  beacon: Vector3;
  /** Top of the building (labels, camera). */
  top: number;
}

const MAIN = { u0: -4.6, u1: 4.6, v0: -3.9, v1: 1.9, h: 2.5 };
const UPPER = { u0: -2.6, u1: 3.4, v0: -3.6, v1: -0.2, h: 1.35 };

export function hqLayout(town: ReturnType<typeof useTown>['town'], lot: Lot): HqLayout {
  const f = rectFrame(town, lot.rect, lot.frontage);
  const y = cellY(town, lot.rect[0], lot.rect[1]);
  const [dx, dy] = { s: [0, 1], n: [0, -1], e: [1, 0], w: [-1, 0] }[lot.frontage] as [number, number];
  return {
    frame: f,
    robot: f.p(1.35, y, MAIN.v1 + 1.25),
    robotYaw: yawOf(dx, dy),
    beacon: f.p(0.4, y + MAIN.h + UPPER.h + 0.2, (UPPER.v0 + UPPER.v1) / 2),
    top: y + MAIN.h + UPPER.h + 0.6,
  };
}

/** The headquarters shell: a graphite pavilion with a glass front, an upper volume and an identity-hue band. */
function buildHq(town: ReturnType<typeof useTown>['town'], lot: Lot, hue: string): { shell: GeoBuilder; glass: GeoBuilder } {
  const f = rectFrame(town, lot.rect, lot.frontage);
  const y = cellY(town, lot.rect[0], lot.rect[1]);
  const shell = new GeoBuilder();
  const glass = new GeoBuilder();
  const box = (g: GeoBuilder, u0: number, u1: number, v0: number, v1: number, y0: number, h: number, c: string) =>
    g.box(f.x((u0 + u1) / 2, (v0 + v1) / 2), y0, f.z((u0 + u1) / 2, (v0 + v1) / 2), u1 - u0, h, v1 - v0, c, {}, f.yaw);
  // Forecourt path and planters.
  box(shell, -0.8, 0.8, MAIN.v1, f.d / 2 - 0.1, y, 0.02, mixHex(HQ.forecourt, '#ffffff', 0.25));
  for (const s of [-1, 1]) {
    box(shell, s * 3.2 - 0.5, s * 3.2 + 0.5, MAIN.v1 + 0.8, MAIN.v1 + 1.6, y, 0.4, HQ.shellLight);
    shell.blob(f.x(s * 3.2, MAIN.v1 + 1.2), y + 0.62, f.z(s * 3.2, MAIN.v1 + 1.2), 0.42, 0.32, 0.36, '#6a9957', 0);
  }
  // Main volume, its glass front and side ribbons.
  box(shell, MAIN.u0 - 0.1, MAIN.u1 + 0.1, MAIN.v0 - 0.1, MAIN.v1 + 0.1, y, 0.18, HQ.trim);
  box(shell, MAIN.u0, MAIN.u1, MAIN.v0, MAIN.v1, y + 0.18, MAIN.h - 0.18, HQ.shell);
  for (let i = 0; i < 5; i++) {
    const u = MAIN.u0 + 0.7 + i * 1.95;
    if (Math.abs(u - 0) < 0.6) continue;
    box(glass, u - 0.7, u + 0.7, MAIN.v1, MAIN.v1 + 0.05, y + 0.4, 1.55, HQ.glass);
  }
  box(glass, -0.55, 0.55, MAIN.v1, MAIN.v1 + 0.06, y + 0.18, 1.3, HQ.glass);
  for (const s of [-1, 1]) for (let k = 0; k < 2; k++) box(glass, s > 0 ? MAIN.u1 : MAIN.u0 - 0.05, s > 0 ? MAIN.u1 + 0.05 : MAIN.u0, MAIN.v0 + 0.8 + k * 2.4, MAIN.v0 + 2.6 + k * 2.4, y + 0.9, 0.9, HQ.glass);
  // Canopy and the identity band along the top of the façade.
  box(shell, -1.4, 1.4, MAIN.v1, MAIN.v1 + 1.0, y + 1.55, 0.08, HQ.roof);
  for (const s of [-1, 1]) box(shell, s * 1.3 - 0.04, s * 1.3 + 0.04, MAIN.v1 + 0.88, MAIN.v1 + 0.96, y, 1.55, HQ.trim);
  box(shell, MAIN.u0, MAIN.u1, MAIN.v1 - 0.02, MAIN.v1 + 0.04, y + MAIN.h - 0.32, 0.16, hue);
  // Roofs: a pale membrane inside a dark parapet.
  const roof = (u0: number, u1: number, v0: number, v1: number, y0: number) => {
    box(shell, u0, u1, v0, v1, y0, 0.06, HQ.roof);
    const t = 0.12;
    box(shell, u0 - 0.04, u1 + 0.04, v1 - t, v1 + 0.04, y0, 0.2, HQ.trim);
    box(shell, u0 - 0.04, u1 + 0.04, v0 - 0.04, v0 + t, y0, 0.2, HQ.trim);
    box(shell, u0 - 0.04, u0 + t, v0, v1, y0, 0.2, HQ.trim);
    box(shell, u1 - t, u1 + 0.04, v0, v1, y0, 0.2, HQ.trim);
  };
  roof(MAIN.u0, MAIN.u1, MAIN.v0, MAIN.v1, y + MAIN.h);
  // Upper volume with a glass band and the beacon plinth.
  box(shell, UPPER.u0, UPPER.u1, UPPER.v0, UPPER.v1, y + MAIN.h + 0.06, UPPER.h + 0.06, HQ.shellLight);
  box(glass, UPPER.u0 + 0.3, UPPER.u1 - 0.3, UPPER.v1, UPPER.v1 + 0.05, y + MAIN.h + 0.5, 0.55, HQ.glass);
  roof(UPPER.u0, UPPER.u1, UPPER.v0, UPPER.v1, y + MAIN.h + 0.12 + UPPER.h);
  box(shell, 0.0, 0.8, (UPPER.v0 + UPPER.v1) / 2 - 0.4, (UPPER.v0 + UPPER.v1) / 2 + 0.4, y + MAIN.h + 0.22 + UPPER.h, 0.12, HQ.pad);
  // Rooftop units on the main roof.
  box(shell, -4.0, -3.0, -3.4, -2.4, y + MAIN.h + 0.12, 0.4, '#5a5f69');
  box(shell, 3.7, 4.3, 0.4, 1.4, y + MAIN.h + 0.12, 0.3, '#5a5f69');
  return { shell, glass };
}

/** The beacon's colour per state: lime only while the agent works; nothing glows when it is off. */
const BEACON: Record<RobotState, string> = {
  working: DARK_TOKENS.lime,
  waiting: DARK_TOKENS.warning,
  awaiting_approval: DARK_TOKENS.warning,
  failed: DARK_TOKENS.failure,
  idle: DARK_TOKENS.ice,
  off: '#5d626c',
};

const Hq = memo(function Hq({ agent, lot, selected, entered, quiet }: { agent: AgentPresence; lot: Lot; selected: boolean; entered: boolean; quiet: boolean }) {
  const { town, live, frame, agentPos, uniforms } = useTown();
  const layout = useMemo(() => hqLayout(town, lot), [town, lot]);
  const geo = useMemo(() => {
    const b = buildHq(town, lot, agent.hue);
    return { shell: b.shell.build()!, glass: b.glass.build()! };
  }, [town, lot, agent.hue]);
  const waiting = isDimmedHq(agent);
  const state = robotStateOf(agent);
  const lit = isLitHq(agent);
  const mats = useMemo(
    () => ({
      shell: new MeshLambertMaterial({ vertexColors: true }),
      glass: new MeshLambertMaterial({ vertexColors: true }),
      beacon: new MeshBasicMaterial({ toneMapped: false, transparent: true }),
    }),
    [],
  );
  useEffect(() => () => void (geo.shell.dispose(), geo.glass.dispose()), [geo]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  useEffect(() => {
    // Waiting for its first event: the building stands dimmed, an unpainted model of itself (not yet a real presence).
    mats.shell.color.set(waiting ? '#d4d8de' : '#ffffff');
    mats.shell.vertexColors = !waiting;
    mats.shell.needsUpdate = true;
    mats.glass.color.set(waiting ? '#b9c0ca' : '#ffffff');
    mats.glass.vertexColors = !waiting;
    mats.glass.needsUpdate = true;
    mats.beacon.color.set(BEACON[state]).multiplyScalar(state === 'off' ? 1 : 1.4);
  }, [mats, waiting, state]);
  const beacon = useRef<Mesh>(null);
  // Flying in, the pavilion lifts 6 units and fades in 450 ms (the diorama shows beneath); leaving, it settles back.
  const shellGroup = useRef<Group>(null);
  const lift = useRef(entered ? 1 : 0);
  const [shellShown, setShellShown] = useState(!entered);
  useEffect(() => {
    if (!entered) setShellShown(true);
  }, [entered]);
  useFrame((_, dt) => {
    const goal = entered ? 1 : 0;
    if (lift.current !== goal) {
      const step = live.reducedMotion ? 1 : Math.min(dt, 0.1) / 0.45;
      lift.current = goal > lift.current ? Math.min(goal, lift.current + step) : Math.max(goal, lift.current - step);
      const k = lift.current;
      const fading = k > 0 && k < 1;
      for (const m of [mats.shell, mats.glass]) {
        if (m.transparent !== fading) {
          m.transparent = fading;
          m.needsUpdate = true;
        }
        m.opacity = 1 - k;
      }
      if (shellGroup.current) shellGroup.current.position.y = 6 * k * k * (3 - 2 * k);
      if (k >= 1 && shellShown) setShellShown(false);
    }
    agentPos.set(agent.agentId, layout.robot);
    // Lit glass when a session is open (live or idle), warmer at night; dark when offline.
    const night = uniforms.uNight.value;
    mats.glass.emissive.set(lit ? '#ffd18a' : '#000000').multiplyScalar(lit ? 0.12 + 0.5 * night : 0);
    if (beacon.current) {
      const pulse = state === 'working' && !live.reducedMotion ? 0.85 + 0.15 * Math.sin(frame.t * 3) : 1;
      mats.beacon.opacity = (waiting ? 0.5 : 0.95) * pulse;
    }
  });
  return (
    <group>
      {shellShown && (
        <group ref={shellGroup}>
          <mesh geometry={geo.shell} material={mats.shell} castShadow receiveShadow />
          <mesh geometry={geo.glass} material={mats.glass} />
          {!entered && (
            <mesh ref={beacon} position={layout.beacon} rotation={[-Math.PI / 2, 0, 0]} material={mats.beacon}>
              <torusGeometry args={[0.42, 0.07, 8, waiting ? 8 : 32]} />
            </mesh>
          )}
        </group>
      )}
      {!entered && (
        <>
          {!quiet && (
            <group position={layout.robot} rotation={[0, layout.robotYaw, 0]}>
              <AgentRobot hue={agent.hue} state={state} selected={selected} reducedMotion={live.reducedMotion} dim={state === 'off'} />
            </group>
          )}
        </>
      )}
      {entered && <AgentHouse agentId={agent.agentId} lot={lot} frame={layout.frame} />}
    </group>
  );
});

/** Every housed agent's headquarters on its lot (at most one per agent lot). */
export const AgentHqs = memo(function AgentHqs({ entered, selectedAgentId }: { entered: string | null; selectedAgentId: string | null }) {
  const { town, frame } = useTown();
  const [agents, setAgents] = useState<readonly AgentPresence[]>([]);
  const key = useRef('');
  useFrame(() => {
    const list = frame.snapshot?.agents ?? [];
    const k = list.map((a) => `${a.agentId}|${a.lotId}|${a.hue}|${a.health}|${a.attention}|${a.execState}|${a.displayName}`).join(';');
    if (k !== key.current) {
      key.current = k;
      setAgents(list.map((a) => ({ ...a })));
    }
  });
  return (
    <group>
      {agents.slice(0, 12).map((a) => {
        const lot = town.lotById.get(a.lotId);
        if (!lot) return null;
        // While one headquarters is open, the others keep their buildings but not their robots (the town is dimmed around it).
        const hqOpen = agents.some((x) => x.buildingId === entered);
        return <Hq key={a.agentId} agent={a} lot={lot} selected={a.agentId === selectedAgentId} entered={entered === a.buildingId} quiet={hqOpen && entered !== a.buildingId} />;
      })}
    </group>
  );
});

/** Robot head height for labels. */
export const ROBOT_LABEL_Y = ROBOT_TOWN_HEIGHT + 0.12;
