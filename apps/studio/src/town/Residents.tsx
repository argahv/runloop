'use client';
import { useFrame } from '@react-three/fiber';
import type { ResidentState } from '@runloop-world/events';
import { memo, useEffect, useMemo, useRef } from 'react';
import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { sceneX, sceneZ, walkY } from './coords';
import { useTown } from './context';
import { residentPhase, type ResidentPose } from './place';
import { residentDotGeometry, residentGeometry, styleId } from './rig/residentGeometry';
import { createResidentMaterial, createResidentUniforms } from './rig/residentMaterial';
import { ANIM, walkGait } from './rig/residentRig';
import { interiorFloorY } from './Interior';

const MAX = 600;
const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpP = new Vector3();
const ONE = new Vector3(1, 1, 1);
const ZERO = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);
const pose: ResidentPose = { gx: 0, gy: 0, dx: 0, dy: 1, anim: 0, inside: null, floor: 0, walking: false };

/**
 * Every resident in one instanced mesh with a shader rig (T0/T1), or as
 * small blocks at far zoom (T2). Positions come from the engine's state only
 * (place.ts); residents inside a building are drawn only when its interior is
 * open. Yaw eases towards the heading so corners turn smoothly.
 */
export const Residents = memo(function Residents() {
  const ctx = useTown();
  const { town, places, frame, live } = ctx;
  const body = useMemo(() => residentGeometry(), []);
  const dots = useMemo(() => residentDotGeometry(), []);
  const uniforms = useMemo(() => createResidentUniforms(), []);
  const material = useMemo(() => createResidentMaterial(uniforms), [uniforms]);
  const attrs = useMemo(() => {
    const mk = (n: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(MAX * n), n);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    return { inst: mk(4), top: mk(3), bottom: mk(3), skin: mk(3), hair: mk(3), matrix: mk(16) };
  }, []);
  const fullRef = useRef<InstancedMesh>(null);
  const dotRef = useRef<InstancedMesh>(null);
  const yaw = useRef(new Float32Array(MAX));
  const yawSet = useRef(new Uint8Array(MAX));
  const roster = useRef<string>('');
  const lastStep = useRef(0);

  useEffect(
    () => () => {
      body.dispose();
      dots.dispose();
      material.dispose();
    },
    [body, dots, material],
  );

  // Share the instance buffers between the two LOD meshes.
  useEffect(() => {
    for (const m of [fullRef.current, dotRef.current]) {
      if (!m) continue;
      m.instanceMatrix = attrs.matrix;
      m.geometry.setAttribute('aInst', attrs.inst);
      m.geometry.setAttribute('aTop', attrs.top);
      m.geometry.setAttribute('aBottom', attrs.bottom);
      m.geometry.setAttribute('aSkin', attrs.skin);
      m.geometry.setAttribute('aHair', attrs.hair);
      m.frustumCulled = false;
    }
  }, [attrs]);

  useFrame((_, dt) => {
    const full = fullRef.current;
    const dot = dotRef.current;
    const snap = frame.snapshot;
    if (!full || !dot) return;
    const residents: readonly ResidentState[] = snap?.residents ?? [];
    const n = Math.min(MAX, residents.length);

    // Colours change only with the roster.
    const key = `${snap?.worldId}:${n}`;
    if (key !== roster.current) {
      roster.current = key;
      const c = new Color();
      for (let i = 0; i < n; i++) {
        const o = residents[i]!.outfit;
        c.set(o.top).toArray(attrs.top.array, i * 3);
        c.set(o.bottom).toArray(attrs.bottom.array, i * 3);
        c.set(o.skin).toArray(attrs.skin.array, i * 3);
        c.set(o.hair).toArray(attrs.hair.array, i * 3);
        attrs.inst.array[i * 4 + 1] = residentPhase(i);
        attrs.inst.array[i * 4 + 2] = styleId(o.style);
        yawSet.current[i] = 0;
      }
      for (const a of [attrs.top, attrs.bottom, attrs.skin, attrs.hair]) a.needsUpdate = true;
    }

    // Reduced motion: residents step at 2 Hz and hold still poses.
    const reduced = live.reducedMotion;
    if (reduced && frame.now - lastStep.current < 500) return;
    lastStep.current = frame.now;

    // Gait from the sim speed: cells per wall second = cells per minute × minutes per second.
    const gait = walkGait(places.cellsPerTick * frame.speed);
    if (!reduced) frame.walkPhase += gait.omega * Math.min(dt, 0.1);
    frame.walkAmp = gait.amp;
    uniforms.uTime.value = reduced ? 0 : frame.t;
    uniforms.uWalkPhase.value = reduced ? 0.6 : frame.walkPhase;
    uniforms.uWalkAmp.value = gait.amp;
    uniforms.uRig.value = frame.tier === 0 && !reduced ? 1 : 0;
    uniforms.uDim.value = ctx.uniforms.uDim.value;

    const f = { width: town.width, height: town.height };
    const turn = reduced ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 12);
    const inst = attrs.inst.array as Float32Array;
    const mat = attrs.matrix.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const r = residents[i]!;
      const p = pose;
      const has = places.poseInto(r, frame.tick, p);
      const shown = has && (p.inside === null || (p.inside === frame.entered && p.floor === 0));
      if (!shown) {
        ZERO.toArray(mat, i * 16);
        ctx.residentVisible[i] = 0;
        continue;
      }
      const x = sceneX(f, p.gx);
      const z = sceneZ(f, p.gy);
      const y = p.inside ? interiorFloorY() : walkY(town, p.gx, p.gy);
      const target = Math.atan2(p.dx, p.dy);
      if (!yawSet.current[i]) {
        yaw.current[i] = target;
        yawSet.current[i] = 1;
      } else {
        const d = Math.atan2(Math.sin(target - yaw.current[i]!), Math.cos(target - yaw.current[i]!));
        yaw.current[i] = yaw.current[i]! + d * (p.walking ? turn : 1);
      }
      tmpQ.setFromAxisAngle(UP, yaw.current[i]!);
      tmpM.compose(tmpP.set(x, y, z), tmpQ, ONE).toArray(mat, i * 16);
      inst[i * 4] = p.anim;
      inst[i * 4 + 3] = p.inside === null ? 1 : 0;
      ctx.residentPos[i * 3] = x;
      ctx.residentPos[i * 3 + 1] = y;
      ctx.residentPos[i * 3 + 2] = z;
      ctx.residentVisible[i] = p.anim === ANIM.sleep ? 2 : 1;
    }
    for (let i = n; i < full.count; i++) ZERO.toArray(mat, i * 16);
    attrs.matrix.needsUpdate = true;
    attrs.inst.needsUpdate = true;
    full.count = n;
    dot.count = n;
    full.visible = frame.tier < 2;
    dot.visible = frame.tier === 2;
  });

  return (
    <group>
      <instancedMesh ref={fullRef} args={[body, material, MAX]} frustumCulled={false} />
      <instancedMesh ref={dotRef} args={[dots, material, MAX]} frustumCulled={false} />
    </group>
  );
});
