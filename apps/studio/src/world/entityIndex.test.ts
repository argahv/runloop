import { formatEntityRef } from '@runloop-world/events';
import { foldEvents } from '@runloop-world/sim';
import { describe, expect, it } from 'vitest';
import { buildEntityIndex, directoryTree, entityName, searchEntities, treeRefs } from './entityIndex';
import { commonsTown, DOCS_DESK, ENGINEERING_HOUSE, fixtureEvents, fixtureSnapshot } from './test-utils';

describe('entity index and directory', () => {
  it("the directory's ids equal the snapshot's ids (every resident and agent exactly once)", () => {
    const town = commonsTown();
    for (const snap of [fixtureSnapshot(), foldEvents(fixtureEvents(), town)]) {
      const refs = treeRefs(directoryTree(snap, town, snap.tick));
      const residents = refs.filter((r) => r.startsWith('resident:')).sort();
      expect(residents).toEqual(snap.residents.map((r) => `resident:${r.id}`).sort());
      expect(new Set(residents).size).toBe(residents.length);
      const agents = refs.filter((r) => r.startsWith('agent:')).sort();
      expect(agents).toEqual(snap.agents.map((a) => `agent:${a.agentId}`).sort());
      const buildings = refs.filter((r) => r.startsWith('building:')).sort();
      expect(buildings).toEqual(snap.buildings.map((b) => `building:${b.id}`).sort());
    }
  });

  it('puts residents inside their building and walkers under the district they cross', () => {
    const town = commonsTown();
    const snap = fixtureSnapshot();
    const tree = directoryTree(snap, town, snap.tick);
    const inside = snap.residents.find((r) => !r.motion && r.place.kind === 'building')!;
    const building = tree.flatMap((d) => d.children).find((n) => n.ref?.id === (inside.place as { buildingId: string }).buildingId)!;
    expect(building.children.map((c) => c.ref?.id)).toContain(inside.id);
    const walkers = snap.residents.filter((r) => r.motion).length;
    const moving = tree.flatMap((d) => d.children).filter((n) => n.key.startsWith('walking:'));
    expect(moving.reduce((n, g) => n + g.children.length, 0) + (tree.find((n) => n.key === 'walking:streets')?.children.length ?? 0)).toBe(walkers);
  });

  it('indexes residents, agents, buildings, places and districts, and finds them by name', () => {
    const town = commonsTown();
    const snap = fixtureSnapshot();
    const index = buildEntityIndex(snap, town);
    const ids = new Set(index.map((e) => formatEntityRef(e.ref)));
    expect(ids.size).toBe(index.length);
    for (const r of snap.residents) expect(ids.has(`resident:${r.id}`)).toBe(true);
    expect(ids.has(`agent:${ENGINEERING_HOUSE}`)).toBe(true);
    expect(searchEntities(index, 'engineering house')[0]!.ref).toEqual({ kind: 'agent', id: ENGINEERING_HOUSE });
    expect(searchEntities(index, 'corner')[0]!.ref).toEqual({ kind: 'building', id: 'bld_corner_cafe' });
    const someone = snap.residents[7]!;
    expect(searchEntities(index, someone.name.split(' ')[0]!).map((e) => e.ref.id)).toContain(someone.id);
    expect(searchEntities(index, '', 20)).toHaveLength(20);
  });

  it('names entities from the data, never inventing one', () => {
    const town = commonsTown();
    const snap = fixtureSnapshot();
    expect(entityName({ kind: 'agent', id: DOCS_DESK }, snap, town)).toBe('Docs Desk');
    expect(entityName({ kind: 'building', id: 'bld_agent_hq_1' }, snap, town)).toBe('Engineering House');
    expect(entityName({ kind: 'building', id: 'bld_corner_cafe' }, snap, town)).toBe('Corner Café');
    expect(entityName({ kind: 'resident', id: 'res_9999' }, snap, town)).toBe('res_9999');
  });
});
