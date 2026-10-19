/**
 * The town file (`runloop.town` v1) and interior files, as zod schemas.
 * Plan of record: docs/architecture/world-simulation.md §2 (Town file).
 *
 * Coordinates are grid cells [x, y]: x = column (west → east), y = row
 * (north → south). Rects are [x, y, w, h]. Every object is strict, so a
 * misspelt key in authored data fails to parse.
 *
 * Ground, from bottom to top (later wins; compileTown and rasterize follow this):
 *  1. grass everywhere;
 *  2. areas: park and garden, then plaza and path, then water;
 *  3. a 1-cell sidewalk along each listed side of every road;
 *  4. roads (asphalt);
 *  5. crossings (crosswalk) over roads;
 *  6. lots (a lot never touches a road, sidewalk or crossing);
 *  7. building footprints; the door cell is a door;
 *  8. front walks: from each door, straight out in the facing direction,
 *     path cells until the first walkable cell (the walk stays inside the lot);
 *  9. landmarks (they block walking).
 * Walkable: sidewalk, crosswalk, plaza, path, door. Agent lots are never
 * walkable for residents (P6). Decoration never changes walkability.
 *
 * Interiors are authored with the door on the bottom row (facing south). A
 * building with another `facing` rotates its interior (see frame.ts), so the
 * footprint is the interior's size, rotated.
 */
import * as z from 'zod';

// Kept equal to @runloop-world/events (RESIDENT_ACTIONS, NEED_IDS, OutfitStyle); the sim tests check it.
export const TOWN_ACTIONS = ['sleep', 'rest', 'eat', 'work', 'socialize', 'stroll'] as const;
export type TownAction = (typeof TOWN_ACTIONS)[number];
export const TownActionSchema = z.enum(TOWN_ACTIONS);
export const TOWN_NEEDS = ['hunger', 'energy', 'social'] as const;
export const TOWN_OUTFIT_STYLES = ['casual', 'apron', 'hoodie', 'labcoat', 'vest', 'backpack', 'blazer', 'overalls', 'cardigan'] as const;

export const CellSchema = z.tuple([z.int().min(0), z.int().min(0)]);
export type Cell = z.infer<typeof CellSchema>;
/** [x, y, w, h] */
export const RectSchema = z.tuple([z.int().min(0), z.int().min(0), z.int().min(1), z.int().min(1)]);
export type Rect = z.infer<typeof RectSchema>;
export const DirSchema = z.enum(['n', 'e', 's', 'w']);
export type Dir = z.infer<typeof DirSchema>;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** "HH:MM", 00:00–23:59 */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const localId = z.string().regex(/^[a-z0-9_]+$/);
const label = z.string().min(1).max(80);
/** Entity ids referenced by world events (same pattern as @runloop-world/events). */
const entityId = (prefix: 'dst' | 'lot' | 'bld' | 'spot' | 'org') => z.string().regex(new RegExp(`^${prefix}_[a-z0-9_]+$`));
/** Layout features that no event references. */
const featureId = (prefix: 'road' | 'xing' | 'area' | 'lmk') => z.string().regex(new RegExp(`^${prefix}_[a-z0-9_]+$`));

export const DistrictKindSchema = z.enum(['civic', 'residential', 'market', 'engineering', 'research']);
export const DistrictSchema = z.strictObject({
  id: entityId('dst'),
  label,
  kind: DistrictKindSchema,
  /** Non-overlapping rects (camera framing, labels, decoration and ground tint). */
  rects: z.array(RectSchema).min(1),
  ground: hex,
});
export type District = z.infer<typeof DistrictSchema>;

export const RoadSchema = z.strictObject({
  id: featureId('road'),
  name: label,
  kind: z.enum(['ring', 'avenue', 'street', 'lane']),
  /** Asphalt cells. Roads are walkable only at crossings. */
  rect: RectSchema,
  /** Sides that get a 1-cell sidewalk along the whole rect. */
  sidewalks: z.array(DirSchema),
});
export type Road = z.infer<typeof RoadSchema>;

/** Crosswalk cells over a road, joining the sidewalks on either side. */
export const CrossingSchema = z.strictObject({ id: featureId('xing'), rect: RectSchema });
export type Crossing = z.infer<typeof CrossingSchema>;

export const AreaSchema = z.strictObject({
  id: featureId('area'),
  /** plaza and path are walkable; park and garden are planted ground; water is a pond. */
  kind: z.enum(['plaza', 'path', 'park', 'garden', 'water']),
  rect: RectSchema,
  label: label.optional(),
});
export type Area = z.infer<typeof AreaSchema>;

/** Fixed civic objects. They block walking. */
export const LandmarkSchema = z.strictObject({
  id: featureId('lmk'),
  kind: z.enum(['clock_tower', 'fountain', 'signal_board', 'statue', 'gazebo']),
  label,
  rect: RectSchema,
});
export type Landmark = z.infer<typeof LandmarkSchema>;

export const LotSchema = z
  .strictObject({
    id: entityId('lot'),
    districtId: entityId('dst'),
    rect: RectSchema,
    /** The side that faces the street; the building's door faces the same way. */
    frontage: DirSchema,
    /** agent: reserved for a real agent's headquarters (never pre-placed, never walkable). */
    use: z.enum(['building', 'agent']),
    /** Draw a low fence around the yard. */
    fence: z.boolean().optional(),
    /** Agent lots only: the id the agent's building gets when housed. */
    buildingId: entityId('bld').optional(),
  })
  .refine((l) => (l.use === 'agent') === (l.buildingId !== undefined), {
    message: 'agent lots need a buildingId, other lots must not have one',
    path: ['buildingId'],
  });
export type Lot = z.infer<typeof LotSchema>;

export const ArchetypeSchema = z.enum([
  'house',
  'flats',
  'cafe',
  'bakery',
  'diner',
  'tavern',
  'shop',
  'office',
  'workshop',
  'lab',
  'greenhouse',
  'library',
  'town_hall',
  'agent_hq',
]);
export type Archetype = z.infer<typeof ArchetypeSchema>;

/** Opening hours. `close` earlier than `open` wraps past midnight. */
export const HoursSchema = z.strictObject({ open: clockTime, close: clockTime });

export const BuildingSchema = z.strictObject({
  id: entityId('bld'),
  lotId: entityId('lot'),
  name: label,
  archetype: ArchetypeSchema,
  /** Inside its lot; equal to the interior's size rotated by `facing`. */
  footprint: RectSchema,
  facing: DirSchema,
  /** A footprint cell on the facing edge; the interior's D cell maps onto it. */
  door: CellSchema,
  /** Interior file id (worlds/<town>/interiors/<id>.json). */
  interior: localId,
  /** Each floor repeats the interior's furniture: capacity = uses × floors. The cutaway shows floor 0. */
  floors: z.int().min(1).max(4),
  /** null for homes. */
  orgId: entityId('org').nullable(),
  /** Who may enter: anyone, the building's workers, or the people who live there. */
  access: z.enum(['public', 'staff', 'residents']),
  /** null = always open (homes). */
  hours: HoursSchema.nullable(),
  sign: z.strictObject({ text: z.string().min(1).max(32), hue: hex }).optional(),
  palette: z.strictObject({ wall: hex, roof: hex, trim: hex }),
});
export type Building = z.infer<typeof BuildingSchema>;

/** An outdoor place. Each cell is one slot (`<spotId>#<i>`). */
export const SpotSchema = z.strictObject({
  id: entityId('spot'),
  label,
  kind: z.enum(['bench', 'plaza', 'fountain', 'lawn', 'pond', 'garden', 'stall', 'steps', 'patio', 'board']),
  districtId: entityId('dst'),
  pose: z.enum(['sit', 'stand']),
  /** Walkable cells. */
  cells: z.array(CellSchema).min(1),
  /** Actions the spot serves. */
  tags: z.array(TownActionSchema).min(1),
  /** null/absent = always open. */
  hours: HoursSchema.nullable().optional(),
});
export type Spot = z.infer<typeof SpotSchema>;

export const OrgSchema = z.strictObject({
  id: entityId('org'),
  name: label,
  /** home: the user's organisation, which owns agent buildings. */
  kind: z.enum(['home', 'civic', 'business', 'research', 'engineering']),
});
export type Org = z.infer<typeof OrgSchema>;

export const RoleSchema = z.strictObject({
  id: localId,
  label,
  outfit: z.enum(TOWN_OUTFIT_STYLES),
  schedule: localId,
  /** Relative weight in the population. */
  share: z.int().min(0),
  /** null = no workplace. `tag` limits work slots to furniture carrying it (e.g. barista). */
  work: z.strictObject({ buildings: z.array(entityId('bld')).min(1), tag: localId.optional() }).nullable(),
});
export type Role = z.infer<typeof RoleSchema>;

export const ScheduleBlockSchema = z.strictObject({
  id: localId,
  label,
  from: clockTime,
  /** Exclusive; may wrap past midnight. */
  to: clockTime,
  /** Score bonus per action during the block (the `sched` part). */
  bias: z.partialRecord(TownActionSchema, z.int()),
});
export type ScheduleBlock = z.infer<typeof ScheduleBlockSchema>;
/** Blocks tile the whole day, in order, without gaps. */
export const ScheduleSchema = z.strictObject({ id: localId, label, blocks: z.array(ScheduleBlockSchema).min(1) });
export type Schedule = z.infer<typeof ScheduleSchema>;

export const NeedSchema = z.strictObject({
  id: z.enum(TOWN_NEEDS),
  label,
  /** Points (0–100) at which the resident wakes to decide. */
  threshold: z.int().min(1).max(100),
  /** Initial urgency range in points, drawn per resident. */
  start: z.tuple([z.int().min(0).max(100), z.int().min(0).max(100)]),
});

const needTriple = z.tuple([z.int(), z.int(), z.int()]);
const perAction = <T extends z.ZodType>(t: T) =>
  z.strictObject({ sleep: t, rest: t, eat: t, work: t, socialize: t, stroll: t });

/** Utility weights (plan §3: Σw·u²/100 + sched + trait − k·travelMin + hash32 % jitter). */
export const WeightsSchema = z.strictObject({
  /** w per need. */
  need: z.strictObject({ hunger: z.int().min(0), energy: z.int().min(0), social: z.int().min(0) }),
  /** k: score lost per minute of walking. */
  travelPerMinute: z.int().min(0),
  jitter: z.int().min(1),
  /** The trait part is trait/100 × this, for the action's trait axis. */
  trait: z.int().min(0),
  /** Bonus for staying with the current action and place. */
  stay: z.int().min(0),
  /** Food places considered besides home (the nearest open ones with a free slot). */
  foodChoices: z.int().min(0).max(5),
  /** Trait axis (0 sociable, 1 diligent, 2 outdoorsy) that favours each action. */
  traitOf: z.partialRecord(TownActionSchema, z.union([z.literal(0), z.literal(1), z.literal(2)])),
  /** Needs an action relieves (whose urgency drives its need part). */
  satisfies: perAction(z.array(z.enum(TOWN_NEEDS))),
  /** Milli-points per sim minute [hunger, energy, social] while doing an action, or walking. */
  rates: perAction(needTriple).extend({ walk: needTriple }),
  /** [min, max] minutes an action lasts before the resident decides again. */
  durations: perAction(z.tuple([z.int().min(1), z.int().min(1)])),
});
export type Weights = z.infer<typeof WeightsSchema>;

/** Colours residents are dressed in (drawn deterministically per resident). */
export const LookSchema = z.strictObject({
  skin: z.array(hex).min(1),
  hair: z.array(hex).min(1),
  bottoms: z.array(hex).min(1),
  tops: z.partialRecord(z.enum(TOWN_OUTFIT_STYLES), z.array(hex).min(1)),
});

export const DecoKindSchema = z.enum([
  'tree_round',
  'tree_cone',
  'tree_blossom',
  'bush',
  'flowerbed',
  'lamp',
  'planter',
  'hydrant',
  'bike_rack',
  'mailbox',
  'parasol',
  'crate',
  'signpost',
  'reeds',
]);
export type DecoKind = z.infer<typeof DecoKindSchema>;

export const DecorationSchema = z.strictObject({
  /** Poisson-disc scatter: `density` items per 100 eligible cells, at least `minSpacing` cells apart. */
  rules: z.array(
    z.strictObject({
      kind: DecoKindSchema,
      /**
       * Ground it may stand on (yard = lot cells outside footprints and walks, never an agent lot;
       * sidewalk_edge / plaza_edge = an unwalkable cell beside a sidewalk / plaza; water_edge = water beside
       * the bank). Decoration from rules is never on a walkable cell (decorate.ts).
       */
      on: z.array(z.enum(['grass', 'park', 'garden', 'yard', 'plaza_edge', 'sidewalk_edge', 'water_edge'])).min(1),
      district: entityId('dst').optional(),
      density: z.int().min(0).max(100),
      minSpacing: z.int().min(1).max(12),
    }),
  ),
  fixed: z.array(
    z.strictObject({
      kind: DecoKindSchema,
      cell: CellSchema,
      yaw: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    }),
  ),
});

export const TownDefinitionSchema = z.strictObject({
  format: z.literal('runloop.town'),
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: label,
  description: z.string().max(2000).optional(),
  /** [width, height] in cells. */
  size: z.tuple([z.int().min(8).max(512), z.int().min(8).max(512)]),
  walkCellsPerMinute: z.int().min(1).max(10),
  /** Time of day a new world starts at. */
  startTime: clockTime,
  /** default: residents in a new world; max: what homes hold. */
  population: z.strictObject({ default: z.int().min(1), max: z.int().min(1) }),
  districts: z.array(DistrictSchema).min(1),
  roads: z.array(RoadSchema),
  crossings: z.array(CrossingSchema),
  areas: z.array(AreaSchema),
  landmarks: z.array(LandmarkSchema),
  lots: z.array(LotSchema).min(1),
  buildings: z.array(BuildingSchema).min(1),
  spots: z.array(SpotSchema),
  orgs: z.array(OrgSchema).min(1),
  roles: z.array(RoleSchema).min(1),
  schedules: z.array(ScheduleSchema).min(1),
  /** Exactly [hunger, energy, social], in that order. */
  needs: z.tuple([NeedSchema, NeedSchema, NeedSchema]),
  names: z.strictObject({ first: z.array(z.string().min(1)).min(10), last: z.array(z.string().min(1)).min(10) }),
  weights: WeightsSchema,
  look: LookSchema,
  decoration: DecorationSchema,
  /** The interior every agent headquarters uses (a `world` interior). */
  agentHq: z.strictObject({ interior: localId }),
});
export type TownDefinition = z.infer<typeof TownDefinitionSchema>;

// ── Interiors ────────────────────────────────────────────────────────

export const FurnitureKindSchema = z.enum([
  'bed',
  'double_bed',
  'sofa',
  'armchair',
  'table',
  'desk',
  'counter',
  'stove',
  'oven',
  'espresso',
  'fridge',
  'shelf',
  'bookcase',
  'workbench',
  'lab_bench',
  'whiteboard',
  'server_rack',
  'plant_bed',
  'booth',
  'bar',
  'display',
  'register',
  'piano',
  'lectern',
  'plant',
]);
export type FurnitureKind = z.infer<typeof FurnitureKindSchema>;

export const FurnitureUseSchema = z.strictObject({
  /** Where the body is: a floor cell beside the furniture, or on it (bed, sofa, bench). */
  cell: CellSchema,
  pose: z.enum(['sit', 'stand', 'sleep']),
  facing: DirSchema.optional(),
});

export const FurnitureSchema = z.strictObject({
  id: localId,
  kind: FurnitureKindSchema,
  /** Floor cells it covers. */
  cells: z.array(CellSchema).min(1),
  /** Each use is one slot: `<id>#<index>@<floor>`. */
  uses: z.array(FurnitureUseSchema),
  /** Actions it serves (sleep, eat, work…) plus role tags (barista, librarian…). */
  tags: z.array(localId),
});
export type Furniture = z.infer<typeof FurnitureSchema>;

/** '#' wall, 'w' wall with a window, '.' floor, 'D' the door (exactly one, on the bottom row). */
export const GridInteriorSchema = z.strictObject({
  id: localId,
  kind: z.literal('grid'),
  label,
  archetype: ArchetypeSchema,
  grid: z.array(z.string().regex(/^[#w.D]+$/)).min(3),
  furniture: z.array(FurnitureSchema),
  /** Named areas for labels (optional). */
  rooms: z.array(z.strictObject({ id: localId, label, rect: RectSchema })).optional(),
});
export type GridInterior = z.infer<typeof GridInteriorSchema>;

/** An interior that mounts an existing world definition (the agent HQ: research-campus at 0.5 scale). */
export const WorldInteriorSchema = z.strictObject({
  id: localId,
  kind: z.literal('world'),
  label,
  archetype: z.literal('agent_hq'),
  /** worlds/<world>/world.json */
  world: z.string().regex(/^[a-z0-9-]+$/),
  /** Town cells per world cell. */
  scale: z.number().positive().max(1),
  /** Footprint in town cells = world grid size × scale. */
  size: z.tuple([z.int().min(1), z.int().min(1)]),
});
export type WorldInterior = z.infer<typeof WorldInteriorSchema>;

export const InteriorDefinitionSchema = z.discriminatedUnion('kind', [GridInteriorSchema, WorldInteriorSchema]);
export type InteriorDefinition = z.infer<typeof InteriorDefinitionSchema>;

/** Parse a town file; throws a readable error listing the first problems. */
export function parseTownDefinition(raw: unknown): TownDefinition {
  const r = TownDefinitionSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid town file: ${summarize(r.error.issues)}`);
  return r.data;
}

export function parseInteriorDefinition(raw: unknown): InteriorDefinition {
  const r = InteriorDefinitionSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid interior: ${summarize(r.error.issues)}`);
  return r.data;
}

function summarize(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
