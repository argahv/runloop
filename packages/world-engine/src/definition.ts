import { TaskKindSchema } from '@runloop-world/events';
import * as z from 'zod';

/** A grid cell as [x, y]: x = column (left→right), y = row (top→bottom). */
export const CellSchema = z.tuple([z.int().min(0), z.int().min(0)]);
export type Cell = z.infer<typeof CellSchema>;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const id = z.string().min(1);

export const ZoneKindSchema = z.enum(['research', 'build', 'test', 'deploy', 'hub']);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

export const StationKindSchema = z.enum(['library', 'build', 'test', 'gate', 'ops']);
export type StationKind = z.infer<typeof StationKindSchema>;

export const PropKindSchema = z.enum(['rack', 'console', 'crate', 'plant', 'lamp']);
export type PropKind = z.infer<typeof PropKindSchema>;

export const ZoneSchema = z.object({
  id,
  label: z.string(),
  kind: ZoneKindSchema,
  /** [x, y, width, height] in cells. Walls of a room are the '#' cells on its border. */
  rect: z.tuple([z.int().min(0), z.int().min(0), z.int().min(1), z.int().min(1)]),
  color: hex,
  /** A doorway cell, used for decorative path strips between the hub and the room. */
  door: CellSchema.optional(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const StationSchema = z.object({
  id,
  zoneId: id,
  kind: StationKindSchema,
  label: z.string(),
  /** Footprint cell (blocked for walking). */
  cell: CellSchema,
  /** Direction the working character faces the station from. */
  facing: z.enum(['n', 'e', 's', 'w']),
  /** Walkable cells where characters stand while working; capacity = slots.length. */
  slots: z.array(CellSchema).min(1),
  /** Walkable cell where extra characters wait when every slot is taken. */
  overflow: CellSchema,
});
export type Station = z.infer<typeof StationSchema>;

export const PropSchema = z.object({
  kind: PropKindSchema,
  /** Footprint cell (blocked for walking). */
  cell: CellSchema,
});
export type Prop = z.infer<typeof PropSchema>;

export const ActivityRuleSchema = z.object({
  when: z.object({
    taskKind: z.array(TaskKindSchema).optional(),
    /** Matches when the agent has a pending permission request. */
    permission: z.literal(true).optional(),
  }),
  stationKind: StationKindSchema,
});
export type ActivityRule = z.infer<typeof ActivityRuleSchema>;

export const CharacterPresetSchema = z.object({
  id,
  label: z.string(),
  color: hex,
  icon: z.string(),
  home: CellSchema,
});
export type CharacterPreset = z.infer<typeof CharacterPresetSchema>;

/**
 * A world definition: the map plus the rules that map execution activity to
 * places. Swapping this file changes where characters go without touching
 * the execution engine or the renderer.
 */
export const WorldDefinitionSchema = z.object({
  id,
  version: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  /** Fixed simulation rate (ticks per second). */
  tickHz: z.number().positive(),
  /** Ticks needed to walk one cell. */
  ticksPerCell: z.int().min(1),
  /** Rows of the map: '#' = wall (blocked), '.' = floor. All rows have equal length. */
  grid: z.array(z.string().regex(/^[#.]+$/)).min(1),
  zones: z.array(ZoneSchema).min(1),
  hub: z.object({
    /** Visual centre of the hub (may be fractional). */
    center: z.tuple([z.number(), z.number()]),
    /** Blocked cells occupied by the hub core. */
    core: z.array(CellSchema),
  }),
  stations: z.array(StationSchema).min(1),
  props: z.array(PropSchema).default([]),
  /** First matching rule wins; no match → the character goes home. */
  activityRules: z.array(ActivityRuleSchema),
  characterPresets: z.array(CharacterPresetSchema).min(1),
  /** Preset for embodied agents that name none (or an unknown one). */
  defaultPreset: id,
});
export type WorldDefinition = z.infer<typeof WorldDefinitionSchema>;

export function parseWorldDefinition(raw: unknown): WorldDefinition {
  return WorldDefinitionSchema.parse(raw);
}
