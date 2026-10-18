'use client';
import { useThree } from '@react-three/fiber';
import type { EntityRef } from '@runloop-world/events';
import { useEffect, useMemo } from 'react';
import { Box3, Raycaster, Vector2, Vector3 } from 'three';
import { hqLayout } from './AgentHq';
import { ROBOT_TOWN_HEIGHT } from './AgentRobot';
import { sceneX, sceneZ } from './coords';
import { useTown } from './context';
import { WALL_INSET, buildingShape } from './geometry/buildings';
import { RESIDENT_HEIGHT } from './rig/residentRig';

export type PickFn = (canvasX: number, canvasY: number) => EntityRef | null;

const v = new Vector3();

/**
 * Picking without per-object raycasts: residents and robots by their
 * projected position (small things stay clickable), buildings and agent
 * headquarters by a ray against their boxes. Installs `pick` into `target`.
 */
export function Picker({ target }: { target: { current: PickFn | null } }) {
  const ctx = useTown();
  const { town, frame } = ctx;
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const boxes = useMemo(() => {
    const f = { width: town.width, height: town.height };
    return town.buildings.map((b) => {
      const [x, y, w, h] = b.def.footprint;
      const top = buildingShape(b).top;
      const min = new Vector3(sceneX(f, x) - 0.5 + WALL_INSET, 0, sceneZ(f, y) - 0.5 + WALL_INSET);
      const max = new Vector3(sceneX(f, x + w - 1) + 0.5 - WALL_INSET, top, sceneZ(f, y + h - 1) + 0.5 - WALL_INSET);
      return { id: b.def.id, box: new Box3(min, max) };
    });
  }, [town]);
  const ray = useMemo(() => new Raycaster(), []);
  useEffect(() => {
    const ndc = new Vector2();
    const project = (x: number, y: number, z: number) => {
      v.set(x, y, z).project(camera);
      return { sx: ((v.x + 1) / 2) * size.width, sy: ((1 - v.y) / 2) * size.height };
    };
    target.current = (px, py) => {
      camera.updateMatrixWorld();
      const unit = frame.zoom * Math.cos((37 * Math.PI) / 180);
      // Residents: the nearest drawn body within reach of the pointer.
      const snap = frame.snapshot;
      let best: EntityRef | null = null;
      let bestD = Infinity;
      const n = snap?.residents.length ?? 0;
      const reach = Math.max(10, RESIDENT_HEIGHT * unit * 0.5);
      for (let i = 0; i < n; i++) {
        if (!ctx.residentVisible[i]) continue;
        const { sx, sy } = project(ctx.residentPos[i * 3]!, ctx.residentPos[i * 3 + 1]! + 0.45, ctx.residentPos[i * 3 + 2]!);
        const d = Math.hypot(sx - px, sy - py);
        if (d < reach && d < bestD) {
          bestD = d;
          best = { kind: 'resident', id: snap!.residents[i]!.id };
        }
      }
      // Agents: their robots.
      const hqOpen = (snap?.agents ?? []).some((a) => a.buildingId === frame.entered);
      for (const [id, p] of ctx.agentPos) {
        if (hqOpen) continue;
        const { sx, sy } = project(p.x, p.y + 0.55, p.z);
        const d = Math.hypot(sx - px, sy - py);
        if (d < Math.max(14, ROBOT_TOWN_HEIGHT * unit * 0.6) && d < bestD) {
          bestD = d;
          best = { kind: 'agent', id };
        }
      }
      if (best) return best;
      // Buildings and agent headquarters: the nearest box the ray hits.
      ndc.set((px / size.width) * 2 - 1, -(py / size.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      let hit: EntityRef | null = null;
      let hitD = Infinity;
      for (const b of boxes) {
        if (b.id === frame.entered) continue;
        const p = ray.ray.intersectBox(b.box, v);
        if (p) {
          const d = p.distanceTo(ray.ray.origin);
          if (d < hitD) {
            hitD = d;
            hit = { kind: 'building', id: b.id };
          }
        }
      }
      for (const a of snap?.agents ?? []) {
        const lot = town.lotById.get(a.lotId);
        if (!lot || a.buildingId === frame.entered) continue;
        const l = hqLayout(town, lot);
        const [x, y, w, h] = lot.rect;
        const f = { width: town.width, height: town.height };
        const box = new Box3(new Vector3(sceneX(f, x) - 0.5, 0, sceneZ(f, y) - 0.5), new Vector3(sceneX(f, x + w - 1) + 0.5, l.top, sceneZ(f, y + h - 1) + 0.5));
        const p = ray.ray.intersectBox(box, v);
        if (p) {
          const d = p.distanceTo(ray.ray.origin);
          if (d < hitD) {
            hitD = d;
            hit = { kind: 'building', id: a.buildingId };
          }
        }
      }
      return hit;
    };
    return () => {
      target.current = null;
    };
  }, [camera, size.width, size.height, boxes, ctx, frame, town, ray, target]);
  return null;
}
