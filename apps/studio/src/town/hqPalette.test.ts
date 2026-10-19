import { describe, expect, it } from 'vitest';
import { zoneFloor } from '../scene/palette';
import { deltaE2000 } from './color';
import { hqDioramaPalette } from './townPalette';

describe("the agent headquarters' diorama is part of the town, not the HUD theme", () => {
  const p = hqDioramaPalette();
  it('uses fixed, matte town materials (no theme input, no glow in daylight)', () => {
    expect(p.glow).toBe(false);
    expect(hqDioramaPalette()).toEqual(p);
    // Neither the obsidian slab of the dark theme nor the white maquette of the light one.
    for (const c of [p.corridor, p.room, p.wall]) expect(deltaE2000(c, '#101114')).toBeGreaterThan(30);
    for (const c of [p.corridor, p.room]) expect(deltaE2000(c, '#ffffff')).toBeGreaterThan(12);
  });
  it('rooms keep their zone colours', () => {
    expect(deltaE2000(zoneFloor(p, '#5aa9f5'), p.room)).toBeGreaterThan(6);
    expect(deltaE2000(zoneFloor(p, '#e0946a'), zoneFloor(p, '#5aa9f5'))).toBeGreaterThan(12);
  });
});
