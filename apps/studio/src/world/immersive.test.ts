import { describe, expect, it } from 'vitest';
import { formatCam, legacyRedirect, parseOverlay, parseWorldLink, writeOverlay, writeWorldLink } from './link';
import { createWorldStore, focusOf, MODE_PLACES } from './store';

const q = (s: string) => new URLSearchParams(s);

describe('camera links with azimuth and tilt (contract §2.4)', () => {
  it('keeps old 3-part links exactly and round-trips 5-part ones', () => {
    expect(parseWorldLink(q('cam=40.5,22,1.75')).cam).toEqual({ x: 40.5, z: 22, zoom: 1.75 });
    expect(parseWorldLink(q('cam=40.5,22,1.75')).cam).not.toHaveProperty('az');
    expect(parseWorldLink(q('cam=1,2,3,120,15')).cam).toEqual({ x: 1, z: 2, zoom: 3, az: 120, tilt: 15 });
    expect(parseWorldLink(q('cam=1,2,3,4,5,6')).cam).toBeNull();
    const p = q('');
    writeWorldLink(p, { mode: 'explore', focus: null, cam: { x: 1.234, z: 2, zoom: 3, az: 120.04, tilt: 15 } });
    expect(p.get('cam')).toBe('1.23,2,3,120.04,15');
    expect(parseWorldLink(p).cam).toEqual({ x: 1.23, z: 2, zoom: 3, az: 120.04, tilt: 15 });
  });

  it('writes az and tilt only when they differ from the defaults by more than 0.5°', () => {
    expect(formatCam({ x: 1, z: 2, zoom: 3 })).toBe('1,2,3');
    expect(formatCam({ x: 1, z: 2, zoom: 3, az: 45.3, tilt: 37.2 })).toBe('1,2,3');
    expect(formatCam({ x: 1, z: 2, zoom: 3, az: 45, tilt: 20 })).toBe('1,2,3,45,20');
    expect(formatCam({ x: 1, z: 2, zoom: 3, az: 135 })).toBe('1,2,3,135,37');
  });
});

describe('overlay links (contract §4.2)', () => {
  it('parses known overlays only and writes or removes the parameter', () => {
    expect(parseOverlay(q('overlay=trace'))).toBe('trace');
    expect(parseOverlay(q('overlay=nope'))).toBeNull();
    const p = q('a=1');
    writeOverlay(p, 'compare');
    expect(p.toString()).toBe('a=1&overlay=compare');
    writeOverlay(p, 'none');
    expect(p.toString()).toBe('a=1');
  });

  it('a sheet link stays on the town; a plain run link still redirects', () => {
    expect(legacyRedirect('/', q('overlay=trace&run=r1&event=4'))).toBeNull();
    expect(legacyRedirect('/', q('run=r1&event=4'))).toBe('/world?run=r1&event=4');
  });
});

function store() {
  return createWorldStore();
}

describe('modes, sheets and places', () => {
  it('Intelligence opens the World Log and frames the Commons Library; Explore gives the town back', () => {
    const s = store();
    s.getState().setMode('intelligence');
    expect(s.getState().overlay).toBe('log');
    expect(s.getState().camera).toMatchObject({ kind: 'focus', ref: MODE_PLACES.intelligence });
    s.getState().setMode('explore');
    expect(s.getState().overlay).toBe('none');
  });

  it('Lab opens compare at the Lattice Lab; Agents frames the Agent District and closes cards and sheets', () => {
    const s = store();
    s.getState().setMode('lab');
    expect(s.getState().overlay).toBe('compare');
    expect(s.getState().camera?.ref).toEqual({ kind: 'building', id: 'bld_lattice_lab' });
    s.getState().focusEntity({ kind: 'resident', id: 'res_0001' });
    s.getState().setMode('agents');
    expect(s.getState().overlay).toBe('none');
    expect(s.getState().panelStack).toEqual([]);
    expect(s.getState().camera?.ref).toEqual({ kind: 'district', id: 'dst_agent_district' });
  });

  it('a deep link sets the mode without moving the camera', () => {
    const s = store();
    s.getState().setMode('agents', { camera: false });
    expect(s.getState().camera).toBeNull();
  });

  it('opening a mode sheet sets its mode; closing it returns to Explore; other sheets keep the mode', () => {
    const s = store();
    s.getState().setOverlay('compare');
    expect(s.getState().mode).toBe('lab');
    s.getState().setOverlay('none');
    expect(s.getState().mode).toBe('explore');
    s.getState().setMode('agents', { camera: false });
    s.getState().setOverlay('trace');
    expect(s.getState().mode).toBe('agents');
    s.getState().setOverlay('none');
    expect(s.getState().mode).toBe('agents');
  });

  it('showInLog opens the log sheet at an event', () => {
    const s = store();
    s.getState().showInLog({ seq: 42 });
    expect(s.getState()).toMatchObject({ mode: 'intelligence', overlay: 'log', logFocus: { seq: 42, actor: null } });
  });
});

describe('Add to World in the town (contract §4.3)', () => {
  it('with the 3D town: lot picking, the camera flies to the Agent District, nothing selected', () => {
    const s = store();
    s.getState().setStage('3d');
    s.getState().focusEntity({ kind: 'resident', id: 'res_0001' });
    s.getState().openAddToWorld('sess_1');
    expect(s.getState()).toMatchObject({ overlay: 'add', lotPick: { selected: null, fromSessionId: 'sess_1' }, addToWorld: null, panelStack: [] });
    expect(s.getState().camera).toMatchObject({ kind: 'focus', ref: { kind: 'district', id: 'dst_agent_district' } });
    s.getState().pickLot('lot_agent_2');
    expect(s.getState().lotPick?.selected).toBe('lot_agent_2');
    s.getState().cancelLotPick();
    expect(s.getState()).toMatchObject({ overlay: 'none', lotPick: null });
  });

  it('without 3D (2D map, another page): the dialog with its lot list', () => {
    const s = store();
    s.getState().setStage('map');
    s.getState().openAddToWorld();
    expect(s.getState()).toMatchObject({ overlay: 'none', lotPick: null, addToWorld: { fromSessionId: null } });
    s.getState().setStage(null);
    s.getState().closeAddToWorld();
    s.getState().setOverlay('add');
    expect(s.getState().addToWorld).toEqual({ fromSessionId: null });
  });

  it('closing the lot-pick overlay clears the pick', () => {
    const s = store();
    s.getState().setStage('3d');
    s.getState().setOverlay('add');
    expect(s.getState().lotPick).not.toBeNull();
    s.getState().setOverlay('none');
    expect(s.getState().lotPick).toBeNull();
  });
});

describe('entity card and HUD state', () => {
  it('a card opens compact unless asked to expand; the same entity keeps its state; Back collapses', () => {
    const s = store();
    s.getState().focusEntity({ kind: 'resident', id: 'res_0001' }, { expand: true });
    expect(s.getState().cardExpanded).toBe(true);
    s.getState().focusEntity({ kind: 'resident', id: 'res_0001' });
    expect(s.getState().cardExpanded).toBe(true);
    s.getState().focusEntity({ kind: 'building', id: 'bld_corner_cafe' });
    expect(s.getState().cardExpanded).toBe(false);
    expect(focusOf(s.getState())).toEqual({ kind: 'building', id: 'bld_corner_cafe' });
    s.getState().setCardExpanded(true);
    s.getState().back();
    expect(s.getState().cardExpanded).toBe(false);
  });

  it('HUD flags change only when they change (no needless renders)', () => {
    const s = store();
    const hud = s.getState().hud;
    s.getState().setInteracting(false);
    s.getState().setHudHidden(false);
    expect(s.getState().hud).toBe(hud);
    s.getState().setHudHidden(true);
    expect(s.getState().hud).toEqual({ hidden: true, interacting: false });
  });

  it('camera requests carry their extra fields and cut under reduced motion', () => {
    const s = createWorldStore({ reducedMotion: true });
    s.getState().requestCamera('goto', null, 'quick', { point: { x: 3, z: 4 } });
    expect(s.getState().camera).toMatchObject({ kind: 'goto', motion: 'cut', point: { x: 3, z: 4 } });
    s.getState().requestCamera('rotate', null, 'quick', { deg: -45 });
    expect(s.getState().camera).toMatchObject({ kind: 'rotate', deg: -45 });
  });
});
