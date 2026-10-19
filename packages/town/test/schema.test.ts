import { describe, expect, it } from 'vitest';
import {
  InteriorDefinitionSchema,
  TownDefinitionSchema,
  canonicalJson,
  compileTown,
  fnv1a64,
  interiorToTown,
  parseTownDefinition,
  rotateDir,
  rotatedSize,
  townContentHash,
  type Cell,
  type Dir,
} from '../src/index';
import { readCommons } from './load-commons';

describe('hash', () => {
  it('sorts keys at every level and drops undefined fields', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'é' }], u: undefined })).toBe('{"a":[{"c":"é","d":2}],"b":1}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });

  it('matches the published FNV-1a 64 test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('gives the same content hash whatever the key order, and a new one for any edit', () => {
    const { town, interiors } = readCommons();
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const reordered = reverseKeys(town);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(town));
    const h = townContentHash(town, interiors);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(townContentHash(reordered, interiors)).toBe(h);
    const edited = { ...(town as Record<string, unknown>), walkCellsPerMinute: 4 };
    expect(townContentHash(edited, interiors)).not.toBe(h);
  });
});

describe('interior frames', () => {
  const size: [number, number] = [8, 7];
  const door: Cell = [3, 6];

  it.each([
    ['s', [10, 20], [13, 26]],
    ['n', [10, 20], [14, 20]],
    ['e', [10, 20], [16, 24]],
    ['w', [10, 20], [10, 23]],
  ] as const)('puts the door on the %s edge', (facing, origin, want) => {
    const [w, h] = rotatedSize(size, facing);
    const d = interiorToTown(door, size, origin as Cell, facing);
    expect(d).toEqual(want);
    const onEdge = { s: d[1] === origin[1] + h - 1, n: d[1] === origin[1], e: d[0] === origin[0] + w - 1, w: d[0] === origin[0] }[facing];
    expect(onEdge).toBe(true);
  });

  it.each(['n', 'e', 's', 'w'] as const)('maps every cell of the interior into the footprint once (facing %s)', (facing) => {
    const [w, h] = rotatedSize(size, facing);
    const seen = new Set<string>();
    for (let y = 0; y < size[1]; y++)
      for (let x = 0; x < size[0]; x++) {
        const [tx, ty] = interiorToTown([x, y], size, [0, 0], facing);
        expect(tx >= 0 && ty >= 0 && tx < w && ty < h).toBe(true);
        seen.add(`${tx},${ty}`);
      }
    expect(seen.size).toBe(w * h);
  });

  it('rotates directions with the interior (a rotation, never a mirror)', () => {
    const dirs: Dir[] = ['n', 'e', 's', 'w'];
    for (const facing of dirs) {
      expect(rotateDir('s', facing)).toBe(facing);
      // Clockwise order is preserved.
      const turned = dirs.map((d) => rotateDir(d, facing));
      const start = dirs.indexOf(turned[0]!);
      expect(turned).toEqual(dirs.map((_, i) => dirs[(start + i) % 4]));
    }
  });
});

describe('schemas', () => {
  const { town, interiors } = readCommons();

  it('parses Runloop Commons and every interior', () => {
    expect(() => parseTownDefinition(town)).not.toThrow();
    for (const [id, raw] of Object.entries(interiors)) {
      const r = InteriorDefinitionSchema.safeParse(raw);
      expect(r.success, `${id}: ${r.error?.message}`).toBe(true);
    }
  });

  it.each([
    ['a misspelt key', (t: Record<string, unknown>) => ({ ...t, walkCellPerMinute: 3 })],
    ['a wrong format', (t: Record<string, unknown>) => ({ ...t, format: 'runloop.world' })],
    ['an entity id without its prefix', (t: Record<string, unknown>) => ({ ...t, orgs: [{ id: 'home', name: 'Home', kind: 'home' }] })],
    ['an agent lot without a building id', (t: Record<string, unknown>) => ({
      ...t,
      lots: [{ id: 'lot_x', districtId: 'dst_x', rect: [0, 0, 12, 10], frontage: 's', use: 'agent' }],
    })],
    ['a clock time of 24:00', (t: Record<string, unknown>) => ({ ...t, startTime: '24:00' })],
  ])('rejects %s', (_name, mutate) => {
    expect(TownDefinitionSchema.safeParse(mutate(town as Record<string, unknown>)).success).toBe(false);
  });

  it('rejects an interior grid with an unknown character', () => {
    const raw = { ...(interiors['house'] as Record<string, unknown>), grid: ['#####', '#.x.#', '##D##'] };
    expect(InteriorDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it('refuses to compile a town without its interiors, naming each missing one', () => {
    const def = parseTownDefinition(town);
    expect(() => compileTown(def, {})).toThrow(/bld_corner_cafe: unknown interior cafe/);
  });
});
