/**
 * Shop signs: every sign's text drawn once into a canvas atlas, and one quad
 * per sign on its façade (one draw call). Browser only (canvas).
 */
import { CanvasTexture, Color, LinearFilter, SRGBColorSpace, Vector3 } from 'three';
import { mixHex } from '../color';
import { GLOW_KIND, GeoBuilder } from './builder';
import type { SignPlacement } from './buildings';

const ROW_H = 96;
const ATLAS_W = 1024;

export function buildSigns(signs: readonly SignPlacement[]): { geometry: GeoBuilder; texture: CanvasTexture } | null {
  if (signs.length === 0 || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ROW_H * signs.length;
  const g = canvas.getContext('2d')!;
  const gb = new GeoBuilder({ uv: true });
  const font = (px: number) => `600 ${px}px Geist, "Geist Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  signs.forEach((s, i) => {
    const aspect = s.w / s.h;
    const pw = Math.min(ATLAS_W, Math.round(ROW_H * aspect));
    const y0 = i * ROW_H;
    // Board: the sign's hue with a cream border and cream lettering.
    g.fillStyle = mixHex(s.hue, '#000000', 0.25);
    roundRect(g, 0, y0, pw, ROW_H, 18);
    g.fill();
    g.fillStyle = s.hue;
    roundRect(g, 6, y0 + 6, pw - 12, ROW_H - 12, 14);
    g.fill();
    g.strokeStyle = 'rgba(255,248,232,0.85)';
    g.lineWidth = 3;
    roundRect(g, 13, y0 + 13, pw - 26, ROW_H - 26, 10);
    g.stroke();
    let px = 50;
    g.font = font(px);
    while (px > 20 && g.measureText(s.text).width > pw - 56) g.font = font((px -= 2));
    g.fillStyle = '#fff8e8';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.text, pw / 2, y0 + ROW_H / 2 + 2);

    const u1 = pw / ATLAS_W;
    const v0 = 1 - (i + 1) / signs.length;
    const v1 = 1 - i / signs.length;
    const right = new Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw)).multiplyScalar(s.w / 2);
    const up = new Vector3(0, s.h / 2, 0);
    const n = new Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw)).multiplyScalar(0.012);
    const c = s.center.clone().add(n);
    const a = c.clone().sub(right).sub(up);
    const b = c.clone().add(right).sub(up);
    const d = c.clone().add(right).add(up);
    const e = c.clone().sub(right).add(up);
    gb.quad(a, b, d, e, new Color('#ffffff'), { glow: GLOW_KIND.sign, bld: s.bld }, [
      [0, v0],
      [u1, v0],
      [u1, v1],
      [0, v1],
    ]);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.anisotropy = 4;
  return { geometry: gb, texture };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
