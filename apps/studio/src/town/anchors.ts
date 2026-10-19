/**
 * Where an entity is anchored on screen (the HUD's cards, TownApi.projectEntity):
 * a resident's or robot's head, a building's roof, a lot's, district's or
 * spot's centre. World space; null when it has no place yet.
 */
import type { EntityRef } from '@runloop-world/events';
import { ROBOT_LABEL_Y, hqLayout } from './AgentHq';
import { cellY, sceneX, sceneZ } from './coords';
import type { TownCtx } from './context';
import { buildingShape } from './geometry/buildings';

export function entityAnchor(ctx: TownCtx, ref: EntityRef): [number, number, number] | null {
  const { town, frame } = ctx;
  const f = { width: town.width, height: town.height };
  const snap = frame.snapshot;
  switch (ref.kind) {
    case 'resident': {
      const i = snap?.residents.findIndex((r) => r.id === ref.id) ?? -1;
      if (i < 0) return null;
      if (ctx.residentVisible[i]) return [ctx.residentPos[i * 3]!, ctx.residentPos[i * 3 + 1]! + 1.15, ctx.residentPos[i * 3 + 2]!];
      const r = snap!.residents[i]!;
      return r.place.kind === 'building' ? entityAnchor(ctx, { kind: 'building', id: r.place.buildingId }) : null;
    }
    case 'agent': {
      const p = ctx.agentPos.get(ref.id);
      return p ? [p.x, p.y + ROBOT_LABEL_Y, p.z] : null;
    }
    case 'building': {
      const b = town.buildingById.get(ref.id);
      if (b) {
        const [x, y, w, h] = b.def.footprint;
        return [sceneX(f, x + (w - 1) / 2), buildingShape(b).top + 0.2, sceneZ(f, y + (h - 1) / 2)];
      }
      const agent = snap?.agents.find((a) => a.buildingId === ref.id);
      const lot = agent ? town.lotById.get(agent.lotId) : town.agentLots.find((l) => l.buildingId === ref.id);
      if (!lot) return null;
      const [x, y, w, h] = lot.rect;
      return [sceneX(f, x + (w - 1) / 2), hqLayout(town, lot).top, sceneZ(f, y + (h - 1) / 2)];
    }
    case 'lot': {
      const lot = town.lotById.get(ref.id);
      if (!lot) return null;
      const [x, y, w, h] = lot.rect;
      return [sceneX(f, x + (w - 1) / 2), cellY(town, x, y) + 0.6, sceneZ(f, y + (h - 1) / 2)];
    }
    case 'district': {
      const d = town.def.districts.find((x) => x.id === ref.id);
      if (!d) return null;
      const [x, y, w, h] = d.rects.reduce((a, r) => (r[2] * r[3] > a[2] * a[3] ? r : a));
      return [sceneX(f, x + (w - 1) / 2), 1.5, sceneZ(f, y + (h - 1) / 2)];
    }
    case 'spot': {
      const s = town.spotById.get(ref.id);
      if (!s || s.def.cells.length === 0) return null;
      let gx = 0;
      let gy = 0;
      for (const c of s.def.cells) {
        gx += c[0];
        gy += c[1];
      }
      gx /= s.def.cells.length;
      gy /= s.def.cells.length;
      return [sceneX(f, gx), 0.7, sceneZ(f, gy)];
    }
  }
  return null;
}

/** A world-space box: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type WorldBox = [number, number, number, number, number, number];

/**
 * The box an entity fills on screen, so a card can sit beside it instead of on
 * it: a building's or headquarters' footprint up to its roof, a lot's rect, a
 * resident or robot around its head. Districts and spots have none (their
 * card points at a centre). Null when it has no place yet.
 */
export function entityBox(ctx: TownCtx, ref: EntityRef): WorldBox | null {
  const { town } = ctx;
  const f = { width: town.width, height: town.height };
  const rect = (x: number, y: number, w: number, h: number, y0: number, y1: number): WorldBox => [sceneX(f, x) - 0.5, y0, sceneZ(f, y) - 0.5, sceneX(f, x + w - 1) + 0.5, y1, sceneZ(f, y + h - 1) + 0.5];
  switch (ref.kind) {
    case 'resident':
    case 'agent': {
      const a = entityAnchor(ctx, ref);
      if (!a) return null;
      const r = ref.kind === 'agent' ? 0.7 : 0.45;
      return [a[0] - r, a[1] - 1.2, a[2] - r, a[0] + r, a[1] + 0.2, a[2] + r];
    }
    case 'building': {
      const b = town.buildingById.get(ref.id);
      if (b) {
        const [x, y, w, h] = b.def.footprint;
        return rect(x, y, w, h, 0, buildingShape(b).top);
      }
      const agent = ctx.frame.snapshot?.agents.find((a) => a.buildingId === ref.id);
      const lot = agent ? town.lotById.get(agent.lotId) : town.agentLots.find((l) => l.buildingId === ref.id);
      if (!lot) return null;
      const [x, y, w, h] = lot.rect;
      return rect(x, y, w, h, 0, hqLayout(town, lot).top);
    }
    case 'lot': {
      const lot = town.lotById.get(ref.id);
      if (!lot) return null;
      const [x, y, w, h] = lot.rect;
      // A free lot is flat; a taken one carries its headquarters.
      const held = ctx.frame.snapshot?.agents.some((a) => a.lotId === ref.id);
      return rect(x, y, w, h, 0, held ? hqLayout(town, lot).top : 0.6);
    }
    default:
      return null;
  }
}
