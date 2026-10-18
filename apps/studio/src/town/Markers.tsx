'use client';
import { useFrame } from '@react-three/fiber';
import { decorate, minuteOfDay } from '@runloop-world/town';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, BoxGeometry, CanvasTexture, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, PlaneGeometry, type Mesh } from 'three';
import { cellY, sceneX, sceneZ } from './coords';
import { useTown } from './context';
import { CLOCK } from './geometry/deco';
import { LANDMARK_COLORS } from './townPalette';

const o = new Object3D();

/** The Commons Clock shows the world's time: two hands on each of its four faces (one instanced draw). */
export const ClockHands = memo(function ClockHands() {
  const { town, frame } = useTown();
  const ref = useRef<InstancedMesh>(null);
  const geo = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const mat = useMemo(() => new MeshLambertMaterial({ color: LANDMARK_COLORS.clockHand }), []);
  const tower = town.def.landmarks.find((l) => l.kind === 'clock_tower');
  const last = useRef(-1);
  useFrame(() => {
    const m = ref.current;
    if (!m || !tower) return;
    const minute = Math.floor(minuteOfDay(Math.floor(frame.tick)));
    if (minute === last.current) return;
    last.current = minute;
    const [lx, ly, lw, lh] = tower.rect;
    const f = { width: town.width, height: town.height };
    const cx = sceneX(f, lx + (lw - 1) / 2);
    const cz = sceneZ(f, ly + (lh - 1) / 2);
    const cy = 0.1 + CLOCK.faceY - CLOCK.faceR;
    const hourA = ((minute % 720) / 720) * Math.PI * 2;
    const minA = ((minute % 60) / 60) * Math.PI * 2;
    let i = 0;
    for (const [dx, dz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ] as const) {
      const yaw = Math.atan2(dx, dz);
      for (const [a, len, w] of [
        [hourA, 0.3, 0.07],
        [minA, 0.44, 0.045],
      ] as const) {
        o.position.set(cx + dx * (CLOCK.halfWidth + 0.035), cy, cz + dz * (CLOCK.halfWidth + 0.035));
        o.rotation.set(0, yaw, 0);
        o.rotateZ(-a);
        o.translateY(len / 2);
        o.scale.set(w, len, 0.02);
        o.updateMatrix();
        m.setMatrixAt(i++, o.matrix);
      }
    }
    m.instanceMatrix.needsUpdate = true;
  });
  if (!tower) return null;
  return <instancedMesh ref={ref} args={[geo, mat, 8]} frustumCulled={false} />;
});

/** A ring under the selected resident (and a fainter one under the hovered one). Agents ring themselves. */
export const SelectionRings = memo(function SelectionRings() {
  const ctx = useTown();
  const sel = useRef<Mesh>(null);
  const hov = useRef<Mesh>(null);
  const selMat = useMemo(() => new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false }), []);
  const hovMat = useMemo(() => new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }), []);
  useLayoutEffect(() => () => void (selMat.dispose(), hovMat.dispose()), [selMat, hovMat]);
  useFrame(({ clock }) => {
    const place = (mesh: Mesh | null, ref: typeof ctx.live.selected) => {
      if (!mesh) return;
      mesh.visible = false;
      if (ref?.kind !== 'resident') return;
      const i = ctx.frame.snapshot?.residents.findIndex((r) => r.id === ref.id) ?? -1;
      if (i < 0 || !ctx.residentVisible[i]) return;
      mesh.visible = true;
      mesh.position.set(ctx.residentPos[i * 3]!, ctx.residentPos[i * 3 + 1]! + 0.02, ctx.residentPos[i * 3 + 2]!);
      mesh.rotation.z = ctx.live.reducedMotion ? 0 : clock.elapsedTime * 0.6;
    };
    place(sel.current, ctx.live.selected);
    const h = ctx.live.hovered;
    place(hov.current, h && (!ctx.live.selected || h.id !== ctx.live.selected.id) ? h : null);
  });
  return (
    <>
      <mesh ref={sel} rotation={[-Math.PI / 2, 0, 0]} material={selMat} renderOrder={5} visible={false}>
        <ringGeometry args={[0.36, 0.43, 6]} />
      </mesh>
      <mesh ref={hov} rotation={[-Math.PI / 2, 0, 0]} material={hovMat} renderOrder={5} visible={false}>
        <ringGeometry args={[0.34, 0.39, 24]} />
      </mesh>
    </>
  );
});

let pool: CanvasTexture | null = null;
/** A soft warm disc (the light a street lamp throws on the ground). */
function lampPoolTexture(): CanvasTexture {
  if (pool) return pool;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,214,150,0.9)');
  grad.addColorStop(0.45, 'rgba(255,200,130,0.35)');
  grad.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  pool = new CanvasTexture(c);
  return pool;
}

/** Street lamps light pools on the pavement from dusk to dawn (the lamps are state: the town's clock). */
export const LampPools = memo(function LampPools({ seed }: { seed: number }) {
  const { town, uniforms } = useTown();
  const ref = useRef<InstancedMesh>(null);
  const lamps = useMemo(() => decorate(town, seed).filter((d) => d.kind === 'lamp'), [town, seed]);
  const geo = useMemo(() => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const mat = useMemo(() => new MeshBasicMaterial({ map: lampPoolTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }), []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const f = { width: town.width, height: town.height };
    lamps.forEach((l, i) => {
      o.position.set(sceneX(f, l.cell[0]), cellY(town, l.cell[0], l.cell[1]) + 0.02, sceneZ(f, l.cell[1]));
      o.rotation.set(0, 0, 0);
      o.scale.set(4.2, 1, 4.2);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  }, [lamps, town]);
  useLayoutEffect(() => () => void (geo.dispose(), mat.dispose()), [geo, mat]);
  useFrame(() => {
    const k = Math.min(1, Math.max(0, (uniforms.uNight.value - 0.3) / 0.4));
    mat.opacity = 0.55 * k * (1 - 0.6 * uniforms.uDim.value);
    if (ref.current) ref.current.visible = k > 0.01;
  });
  if (!lamps.length) return null;
  return <instancedMesh ref={ref} args={[geo, mat, lamps.length]} frustumCulled={false} renderOrder={2} />;
});
