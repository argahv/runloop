'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo } from 'react';
import { BufferGeometry, MeshBasicMaterial } from 'three';
import { DARK_TOKENS } from '../scene/palette';
import { cellY, sceneX, sceneZ } from './coords';
import { useTown } from './context';
import { GeoBuilder } from './geometry/builder';
import type { LotPick } from './types';

/** A lot's outline (a frame of four thin strips over a wider dark one) and a faint fill, a little above its ground. */
function lotGeometry(town: ReturnType<typeof useTown>['town'], rect: readonly [number, number, number, number]): { frame: BufferGeometry; under: BufferGeometry; fill: BufferGeometry } {
  const f = { width: town.width, height: town.height };
  const [x, y, w, h] = rect;
  const x0 = sceneX(f, x) - 0.5 + 0.15;
  const x1 = sceneX(f, x + w - 1) + 0.5 - 0.15;
  const z0 = sceneZ(f, y) - 0.5 + 0.15;
  const z1 = sceneZ(f, y + h - 1) + 0.5 - 0.15;
  const yy = cellY(town, x, y) + 0.03;
  const ring = (inset: number, t: number, top: number) => {
    const g = new GeoBuilder();
    const a0 = x0 + inset;
    const a1 = x1 - inset;
    const b0 = z0 + inset;
    const b1 = z1 - inset;
    g.box((a0 + a1) / 2, top, b0 + t / 2, a1 - a0, 0.04, t, '#ffffff');
    g.box((a0 + a1) / 2, top, b1 - t / 2, a1 - a0, 0.04, t, '#ffffff');
    g.box(a0 + t / 2, top, (b0 + b1) / 2, t, 0.04, b1 - b0 - 2 * t, '#ffffff');
    g.box(a1 - t / 2, top, (b0 + b1) / 2, t, 0.04, b1 - b0 - 2 * t, '#ffffff');
    return g.build()!;
  };
  const fi = new GeoBuilder();
  fi.box((x0 + x1) / 2, yy, (z0 + z1) / 2, x1 - x0 - 0.6, 0.02, z1 - z0 - 0.6, '#ffffff');
  // A graphite under-stroke keeps the ice outline legible on pale ground by day.
  return { under: ring(0, 0.5, yy + 0.005), frame: ring(0.12, 0.26, yy + 0.012), fill: fi.build()! };
}

/**
 * Lot picking for Add to World (contract §4.3): free lots glow with an ice
 * outline over a graphite under-stroke that breathes gently (static under
 * reduced motion), the hovered one brighter, the picked one lime (the active state). Taken lots are not
 * outlined; their labels name their agent.
 */
export const LotMarkers = memo(function LotMarkers({ pick, hovered }: { pick: LotPick; hovered: { current: string | null } }) {
  const { town, frame, live } = useTown();
  const lots = useMemo(
    () =>
      pick.lots
        .filter((l) => l.state === 'free')
        .map((l) => {
          const lot = town.lotById.get(l.id);
          if (!lot) return null;
          const geo = lotGeometry(town, lot.rect);
          const frameMat = new MeshBasicMaterial({ color: DARK_TOKENS.ice, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
          const underMat = new MeshBasicMaterial({ color: DARK_TOKENS.graphite, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
          const fillMat = new MeshBasicMaterial({ color: DARK_TOKENS.graphite, transparent: true, opacity: 0.14, depthWrite: false, toneMapped: false });
          return { id: l.id, geo, frameMat, underMat, fillMat };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [pick.lots, town],
  );
  useEffect(
    () => () => {
      for (const l of lots) {
        l.geo.frame.dispose();
        l.geo.under.dispose();
        l.geo.fill.dispose();
        l.frameMat.dispose();
        l.underMat.dispose();
        l.fillMat.dispose();
      }
    },
    [lots],
  );
  useFrame(() => {
    const pulse = live.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(frame.t * 2.4);
    for (const l of lots) {
      const sel = pick.selected === l.id;
      const hov = hovered.current === l.id;
      l.frameMat.color.set(sel ? DARK_TOKENS.lime : DARK_TOKENS.ice);
      l.frameMat.opacity = sel ? 1 : hov ? 1 : 0.85 * pulse;
      l.fillMat.color.set(sel ? DARK_TOKENS.lime : DARK_TOKENS.graphite);
      l.fillMat.opacity = sel ? 0.2 : hov ? 0.22 : 0.08 + 0.08 * pulse;
    }
  });
  return (
    <group renderOrder={4}>
      {lots.map((l) => (
        <group key={l.id}>
          <mesh geometry={l.geo.fill} material={l.fillMat} renderOrder={4} />
          <mesh geometry={l.geo.under} material={l.underMat} renderOrder={5} />
          <mesh geometry={l.geo.frame} material={l.frameMat} renderOrder={6} />
        </group>
      ))}
    </group>
  );
});
