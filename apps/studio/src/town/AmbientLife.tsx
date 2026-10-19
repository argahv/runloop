'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Color, DoubleSide, InstancedMesh, Matrix4, MeshBasicMaterial, MeshLambertMaterial, Quaternion, Vector3, type Object3D } from 'three';
import { useTown } from './context';
import { timed } from './perf';
import { CAR_COLORS, LAND_COLORS, birdGeometry, carGeometry, carLightsGeometry, roadY } from './geometry/surroundMeshes';
import { birdPose, carPose, terrainHeight, type SurroundLayout } from './geometry/surroundings';
import { walkY } from './coords';

const m = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const pos = new Vector3();
const scl = new Vector3(1, 1, 1);
const car = { x: 0, z: 0, yaw: 0, y: 0 };
const bird = { x: 0, y: 0, z: 0, yaw: 0, flap: 0 };

/**
 * Decorative ambient life (contract §3): a few cars on the roads out, Westway
 * and Brook Road (headlights at night), and small flocks of birds over the
 * fields, the forest and the park by day. Closed form in ambient time, which
 * stands still while the world is paused; hidden under reduced motion; never
 * pickable; never within 12 cells of an agent lot (surroundings.test.ts).
 * Nothing here is simulated or real activity: it is scenery.
 */
export const AmbientLife = memo(function AmbientLife({ layout, lite }: { layout: SurroundLayout; lite: boolean }) {
  const { town, frame, surround } = useTown();
  // Each route's road height at its points, once (on the town's roads the datum, out of town the land and the bridges).
  const routes = useMemo(
    () =>
      layout.cars
        .map((r) => ({
          r,
          n: lite ? r.liteCars : r.cars,
          ys: r.pts.map((p) => (Math.abs(p.x) < layout.hx && Math.abs(p.z) < layout.hz ? walkY(town, p.x + (town.width - 1) / 2, p.z + (town.height - 1) / 2) : roadY(layout, p.x, p.z))),
        }))
        .filter((x) => x.n > 0),
    [layout, lite, town],
  );
  const total = routes.reduce((a, x) => a + x.n, 0);
  const flocks = useMemo(() => (lite ? [] : layout.flocks.map((f) => ({ f, ground: terrainHeight(layout, f.cx, f.cz) }))), [layout, lite]);
  const birds = flocks.reduce((a, x) => a + x.f.birds, 0);
  const geo = useMemo(
    () => ({
      car: carGeometry(),
      lights: carLightsGeometry(),
      bird: birdGeometry(),
    }),
    [],
  );
  const mats = useMemo(
    () => ({
      car: new MeshLambertMaterial({ vertexColors: true }),
      lights: new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        toneMapped: false,
        depthWrite: false,
      }),
      bird: new MeshBasicMaterial({
        color: LAND_COLORS.bird,
        side: DoubleSide,
        transparent: true,
        opacity: 0.85,
      }),
    }),
    [],
  );
  const cars = useRef<InstancedMesh>(null);
  const lights = useRef<InstancedMesh>(null);
  const flock = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const c = new Color();
    const mesh = cars.current;
    if (!mesh) return;
    for (let i = 0; i < total; i++) mesh.setColorAt(i, c.set(CAR_COLORS[i % CAR_COLORS.length]!));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [total]);

  useEffect(() => {
    const objs: Object3D[] = [cars.current, lights.current, flock.current].filter((o): o is InstancedMesh => !!o);
    for (const o of objs) surround.add(o);
    return () => {
      for (const o of objs) surround.delete(o);
    };
  }, [surround, total, birds]);

  useEffect(
    () => () => {
      for (const g of Object.values(geo)) g.dispose();
      for (const x of Object.values(mats)) x.dispose();
    },
    [geo, mats],
  );

  useFrame(
    timed(() => {
      const t = frame.ambientT;
      const night = frame.sky?.night ?? 0;
      const cm = cars.current;
      const lm = lights.current;
      if (cm && lm) {
        let i = 0;
        for (const { r, n, ys } of routes) {
          for (let k = 0; k < n; k++, i++) {
            carPose(r, k, t, car, ys);
            q.setFromAxisAngle(up, car.yaw);
            m.compose(pos.set(car.x, car.y, car.z), q, scl.set(1, 1, 1));
            cm.setMatrixAt(i, m);
            lm.setMatrixAt(i, m);
          }
        }
        cm.instanceMatrix.needsUpdate = true;
        lm.instanceMatrix.needsUpdate = true;
        mats.lights.opacity = Math.min(1, Math.max(0, (night - 0.3) / 0.4));
        lm.visible = mats.lights.opacity > 0.01;
      }
      const bm = flock.current;
      if (bm) {
        // Birds fly by day only.
        const day = 1 - Math.min(1, Math.max(0, (night - 0.2) / 0.4));
        bm.visible = day > 0.02;
        mats.bird.opacity = 0.85 * day;
        let i = 0;
        for (const { f, ground } of flocks) {
          for (let k = 0; k < f.birds; k++, i++) {
            birdPose(f, k, t, bird);
            q.setFromAxisAngle(up, bird.yaw);
            m.compose(pos.set(bird.x, bird.y + ground, bird.z), q, scl.set(1.6, 1.6 * (0.25 + 1.1 * bird.flap), 1.6));
            bm.setMatrixAt(i, m);
          }
        }
        bm.instanceMatrix.needsUpdate = true;
      }
    }),
  );

  return (
    <>
      {total > 0 && (
        <>
          <instancedMesh ref={cars} args={[geo.car, mats.car, total]} frustumCulled={false} />
          <instancedMesh ref={lights} args={[geo.lights, mats.lights, total]} frustumCulled={false} renderOrder={3} />
        </>
      )}
      {birds > 0 && <instancedMesh ref={flock} args={[geo.bird, mats.bird, birds]} frustumCulled={false} />}
    </>
  );
});
