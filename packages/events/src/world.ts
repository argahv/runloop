/**
 * World simulation contracts (plan of record: docs/architecture/world-simulation.md §2).
 *
 * The town's commands, events, resident and agent state, and the snapshot
 * that Studio folds. Frozen in S0: a change needs a reviewed PR that also
 * updates packages/sim/test/fixtures.
 *
 * Units: a tick is one sim minute (integer). Needs are urgencies stored in
 * milli-points (0 = satisfied, 100 000 = urgent), so the closed form stays in
 * integer arithmetic and replay reproduces state exactly.
 */
import * as z from 'zod';
import type { ParseResult } from './parse';
import { RunOutcomeSchema, ToolCategorySchema } from './payloads';

// ── Clock ────────────────────────────────────────────────────────────

export const MINUTES_PER_DAY = 1440;
export const TickSchema = z.int().min(0);
/** Sim minutes since the world's epoch (Day 1, 00:00). */
export type Tick = number;

export const WORLD_SPEEDS = [0, 1, 4, 16] as const;
/** Sim minutes per wall second; 0 = paused. */
export type WorldSpeed = (typeof WORLD_SPEEDS)[number];
export const WorldSpeedSchema = z.union([z.literal(0), z.literal(1), z.literal(4), z.literal(16)]);
/** The speed that "resume" restores (never 0). */
export type RunningSpeed = Exclude<WorldSpeed, 0>;
export const RunningSpeedSchema = z.union([z.literal(1), z.literal(4), z.literal(16)]);

/** Day (1-based) and minute of day of a tick. */
export function clockOf(tick: Tick): { day: number; minute: number } {
  const day = Math.floor(tick / MINUTES_PER_DAY);
  return { day: day + 1, minute: tick - day * MINUTES_PER_DAY };
}

/** "Day 3 · 14:20" */
export function formatClock(tick: Tick): string {
  const { day, minute } = clockOf(tick);
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `Day ${day} · ${hh}:${mm}`;
}

// ── Provenance and sources ───────────────────────────────────────────

/**
 * simulation: the engine decided it (residents). user: a person did it in Studio.
 * external-agent: a real agent reported it (always with `obs`). system: Runloop
 * itself (boot, health). inferred: Runloop reconstructed it (idle sweep, interrupt).
 */
export const WorldProvenanceSchema = z.enum(['simulation', 'user', 'external-agent', 'system', 'inferred']);
export type WorldProvenance = z.infer<typeof WorldProvenanceSchema>;

export const CommandSourceSchema = z.enum(['user', 'external-agent', 'system']);
export type CommandSource = z.infer<typeof CommandSourceSchema>;

/** observed: the agent ran it and reported it. executed: Runloop ran it (reserved; nothing uses it yet). */
export const ObservationSchema = z.enum(['observed', 'executed']);
export type Observation = z.infer<typeof ObservationSchema>;

/** The run events a world event was derived from: `[seqFrom, seqTo]` of run `runId`. */
export const RunCauseSchema = z
  .object({ runId: z.uuid(), seqFrom: z.int().min(1), seqTo: z.int().min(1) })
  .refine((c) => c.seqFrom <= c.seqTo, { message: 'seqFrom must be <= seqTo', path: ['seqTo'] });
export type RunCause = z.infer<typeof RunCauseSchema>;

// ── Ids ──────────────────────────────────────────────────────────────

/** Town entity ids (districts, lots, buildings, outdoor spots, organisations). */
export const TOWN_ID_PATTERN = /^(dst|lot|bld|spot|org)_[a-z0-9_]+$/;
export const TownIdSchema = z.string().regex(TOWN_ID_PATTERN);
const townId = (prefix: 'dst' | 'lot' | 'bld' | 'spot' | 'org') => z.string().regex(new RegExp(`^${prefix}_[a-z0-9_]+$`));
export const DistrictIdSchema = townId('dst');
export const LotIdSchema = townId('lot');
export const BuildingIdSchema = townId('bld');
export const SpotIdSchema = townId('spot');
export const OrgIdSchema = townId('org');

/** Agents belong to the user's organisation. */
export const AGENT_ORG_ID = 'org_home';

export const ResidentIdSchema = z.string().regex(/^res_\d{4,}$/);
/** Resident ids follow the roster order: idx 0 → res_0001. */
export function residentId(idx: number): string {
  return `res_${String(idx + 1).padStart(4, '0')}`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const AgentIdSchema = z.string().regex(new RegExp(`^agt_${UUID}$`));
export const WorkspaceIdSchema = z.string().regex(new RegExp(`^wsp_${UUID}$`));
export const DispatchIdSchema = z.string().regex(new RegExp(`^dsp_${UUID}$`));

export const WorldIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/** fnv1a64 of the town's canonical JSON, 16 lowercase hex digits. */
export const ContentHashSchema = z.string().regex(/^[0-9a-f]{16}$/);
/** Command ids are idempotency keys (e.g. `house:<agentId>`, `act:<runId>:<seqTo>`). */
export const CommandIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);

/**
 * Prefixes of the command ids the runtime submits itself (projector: `sess:`,
 * `act:`, `conn:`; agents: `house:`; dispatch: `dsp:`). The world applies an
 * id once, so a client (POST /api/world/commands) may not use them: it could
 * otherwise take one of Runloop's own ids first and have the real command
 * dropped as a duplicate.
 */
export const RUNTIME_COMMAND_ID_PREFIXES = ['sess:', 'act:', 'conn:', 'house:', 'dsp:'] as const;
export function isRuntimeCommandId(id: string): boolean {
  return RUNTIME_COMMAND_ID_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * A slot is one furniture use or one outdoor spot cell:
 * `<furnitureId>#<use>@<floor>` inside a building, `<spotId>#<cell>` outdoors.
 */
export const SlotIdSchema = z.string().regex(/^[a-z0-9_]+#\d+(@\d+)?$/);

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// ── Space ────────────────────────────────────────────────────────────

/** A town grid cell [x, y]: x = column (west → east), y = row (north → south). */
export const WorldCellSchema = z.tuple([z.int().min(0), z.int().min(0)]);
export type WorldCell = z.infer<typeof WorldCellSchema>;

/** Where a resident is. Outdoors at a spot, outdoors in transit (spotId null), or inside a building. */
export const PlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outdoor'), spotId: SpotIdSchema.nullable() }),
  z.object({ kind: z.literal('building'), buildingId: BuildingIdSchema }),
]);
export type Place = z.infer<typeof PlaceSchema>;

/** The place's town id (null = outdoors in transit). */
export function placeId(place: Place): string | null {
  return place.kind === 'building' ? place.buildingId : place.spotId;
}

/**
 * A walk, run-length encoded: start cell plus steps like "E3S2" (N = y−1,
 * E = x+1, S = y+1, W = x−1). Empty rle = already there.
 */
export const RouteSchema = z.object({ from: WorldCellSchema, rle: z.string().regex(/^(?:[NESW][1-9]\d*)*$/) });
export type Route = z.infer<typeof RouteSchema>;

const STEP: Record<string, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** Encode a 4-connected path (first cell = start). Throws on a non-adjacent step. */
export function encodeRoute(path: readonly WorldCell[]): Route {
  if (path.length === 0) throw new Error('encodeRoute: empty path');
  let rle = '';
  let last = '';
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i]![0] - path[i - 1]![0];
    const dy = path[i]![1] - path[i - 1]![1];
    const dir = dx === 1 && dy === 0 ? 'E' : dx === -1 && dy === 0 ? 'W' : dx === 0 && dy === 1 ? 'S' : dx === 0 && dy === -1 ? 'N' : '';
    if (!dir) throw new Error(`encodeRoute: step ${i} is not to a neighbouring cell`);
    if (dir === last) run++;
    else {
      if (run) rle += `${last}${run}`;
      last = dir;
      run = 1;
    }
  }
  if (run) rle += `${last}${run}`;
  const [x, y] = path[0]!;
  return { from: [x, y], rle };
}

/** Every cell of a route, start included. */
export function decodeRoute(route: Route): WorldCell[] {
  let [x, y] = route.from;
  const out: WorldCell[] = [[x, y]];
  for (const m of route.rle.matchAll(/([NESW])(\d+)/g)) {
    const [dx, dy] = STEP[m[1]!]!;
    for (let n = Number(m[2]); n > 0; n--) {
      x += dx;
      y += dy;
      out.push([x, y]);
    }
  }
  return out;
}

// ── Residents ────────────────────────────────────────────────────────

/** Order is the tie-break ordinal: a lower index wins a tied score. */
export const RESIDENT_ACTIONS = ['sleep', 'rest', 'eat', 'work', 'socialize', 'stroll'] as const;
export const ResidentActionSchema = z.enum(RESIDENT_ACTIONS);
export type ResidentAction = z.infer<typeof ResidentActionSchema>;

/** Need order in every triple: [hunger, energy, social]. Each is an urgency (energy 100 = exhausted). */
export const NEED_IDS = ['hunger', 'energy', 'social'] as const;
export type NeedId = (typeof NEED_IDS)[number];
/** Milli-points per need point. */
export const NEED_SCALE = 1000;
export const NEED_MAX = 100 * NEED_SCALE;

const needValue = z.int().min(0).max(NEED_MAX);
/** Need values in milli-points: [hunger, energy, social]. */
export const NeedValuesSchema = z.tuple([needValue, needValue, needValue]);
export type NeedValues = z.infer<typeof NeedValuesSchema>;
/** Milli-points per sim minute while the current action lasts (positive = the need grows). */
export const NeedRatesSchema = z.tuple([z.int(), z.int(), z.int()]);
export type NeedRates = z.infer<typeof NeedRatesSchema>;

/** Closed-form need: value(t) = clamp(v0 + rate·(t − t0), 0, NEED_MAX). Re-anchored only by events. */
export const NeedTrackSchema = z.object({ v0: needValue, rate: z.int(), t0: TickSchema });
export type NeedTrack = z.infer<typeof NeedTrackSchema>;

/** A need's value at `tick` in milli-points (integer). Ticks before t0 read v0. */
export function needAt(track: NeedTrack, tick: Tick): number {
  const v = track.v0 + track.rate * Math.max(0, tick - track.t0);
  return v < 0 ? 0 : v > NEED_MAX ? NEED_MAX : v;
}

/** Trait axes in every triple, 0–100: [sociable, diligent, outdoorsy]. */
export const TRAIT_IDS = ['sociable', 'diligent', 'outdoorsy'] as const;
const trait = z.int().min(0).max(100);
export const TraitsSchema = z.tuple([trait, trait, trait]);

export const OutfitStyleSchema = z.enum(['casual', 'apron', 'hoodie', 'labcoat', 'vest', 'backpack', 'blazer', 'overalls', 'cardigan']);
export type OutfitStyle = z.infer<typeof OutfitStyleSchema>;
export const OutfitSchema = z.object({ style: OutfitStyleSchema, top: hex, bottom: hex, skin: hex, hair: hex });
export type Outfit = z.infer<typeof OutfitSchema>;

/** Who a resident is. Fixed at world creation (the roster in `world.created`). */
export const ResidentIdentitySchema = z.object({
  id: ResidentIdSchema,
  name: z.string().min(1).max(80),
  /** A role id from the town file (e.g. barista, engineer). */
  role: z.string().regex(/^[a-z_]+$/),
  homeId: BuildingIdSchema,
  /** null = no workplace (e.g. retirees). */
  workId: BuildingIdSchema.nullable(),
  traits: TraitsSchema,
  outfit: OutfitSchema,
});
export type ResidentIdentity = z.infer<typeof ResidentIdentitySchema>;

export const MotionSchema = z.object({ path: z.array(WorldCellSchema).min(1), startTick: TickSchema });
/** Closed-form walk on the town grid, `walkCellsPerMinute` cells per tick (the town file). */
export type WorldMotion = z.infer<typeof MotionSchema>;

export const ResidentStateSchema = ResidentIdentitySchema.extend({
  idx: z.int().min(0),
  place: PlaceSchema,
  /** The slot held at `place` (reserved when decided, kept on arrival). null = none. */
  slotId: SlotIdSchema.nullable(),
  action: ResidentActionSchema,
  /** The current walk; null when not walking. While walking, `place` is outdoor with spotId null. */
  motion: MotionSchema.nullable(),
  needs: z.tuple([NeedTrackSchema, NeedTrackSchema, NeedTrackSchema]),
  /** The tick at which the current action ends and the resident decides again. */
  until: TickSchema,
  /** Seq of the resident's latest `resident.decided` (0 = none yet). */
  lastDecisionSeq: z.int().min(0),
});
export type ResidentState = z.infer<typeof ResidentStateSchema>;

/** What woke a resident to decide. */
export const DecisionReasonSchema = z.enum(['start', 'arrived', 'need', 'schedule', 'until', 'dest_closed']);
export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

/**
 * One scored option: [action, placeId, total, needPart, schedPart, travelPart].
 * total = needPart + schedPart − travelPart + trait + jitter (travelPart ≥ 0 is the cost).
 */
export const DecisionOptionSchema = z.tuple([
  ResidentActionSchema,
  TownIdSchema.nullable(),
  z.int(),
  z.int(),
  z.int(),
  z.int().min(0),
]);
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

// ── Agents ───────────────────────────────────────────────────────────

/** First matching rule wins (plan §4.3): unknown, not_connected, awaiting_first_event, live, idle, offline. */
export const ConnectionHealthSchema = z.enum(['not_connected', 'awaiting_first_event', 'live', 'idle', 'offline', 'unknown']);
export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>;

export const AgentAttentionSchema = z.enum(['none', 'permission_requested', 'incident', 'dispatch_awaiting_approval']);
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;

export const AgentExecStateSchema = z.enum(['working', 'waiting', 'awaiting_approval', 'idle']);
export type AgentExecState = z.infer<typeof AgentExecStateSchema>;

export const DispatchPhaseSchema = z.enum(['approved', 'running', 'finished']);
export type DispatchPhase = z.infer<typeof DispatchPhaseSchema>;

/** How a dispatched Claude Code run ended, as reported (lost = the runtime restarted and its process was gone). */
export const DispatchOutcomeSchema = z.enum(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'lost']);
export type DispatchOutcome = z.infer<typeof DispatchOutcomeSchema>;

/** Tool calls started in the cause range, by category. */
export const ToolCountsSchema = z.partialRecord(ToolCategorySchema, z.int().min(0));
export type ToolCounts = z.infer<typeof ToolCountsSchema>;

const displayName = z.string().trim().min(1).max(60);

/** A real agent's presence in the town. No paths, tokens or task text ever live here. */
export const AgentPresenceSchema = z.object({
  agentId: AgentIdSchema,
  buildingId: BuildingIdSchema,
  lotId: LotIdSchema,
  displayName,
  hue: hex,
  health: ConnectionHealthSchema,
  attention: AgentAttentionSchema,
  /** The bound run being observed now (null = none open). */
  activeRunId: z.uuid().nullable(),
  /** Tool calls of the active run so far, by category (replaced by each activity event). */
  counts: ToolCountsSchema,
  execState: AgentExecStateSchema,
  /** Subagents seen in the active run. */
  helpers: z.int().min(0),
  openIncidents: z.int().min(0),
  /** The run events behind the latest session or activity change. */
  lastCause: RunCauseSchema.nullable(),
  /** The latest dispatch Runloop launched for this agent (null = none). */
  dispatch: z
    .object({ dispatchId: DispatchIdSchema, phase: DispatchPhaseSchema, outcome: DispatchOutcomeSchema.optional() })
    .nullable(),
});
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;

// ── Commands ─────────────────────────────────────────────────────────

const runId = z.uuid();

export const worldCommandSchemas = {
  'clock.set': z.strictObject({ type: z.literal('clock.set'), speed: WorldSpeedSchema }),
  'building.set_open': z.strictObject({ type: z.literal('building.set_open'), buildingId: BuildingIdSchema, open: z.boolean() }),
  'agent.house': z.strictObject({
    type: z.literal('agent.house'),
    agentId: AgentIdSchema,
    lotId: LotIdSchema,
    displayName,
    hue: hex,
  }),
  'agent.connection': z.strictObject({
    type: z.literal('agent.connection'),
    agentId: AgentIdSchema,
    health: ConnectionHealthSchema,
    attention: AgentAttentionSchema,
  }),
  'agent.session': z
    .strictObject({
      type: z.literal('agent.session'),
      agentId: AgentIdSchema,
      runId,
      phase: z.enum(['started', 'ended']),
      outcome: RunOutcomeSchema.optional(),
    })
    .refine((c) => (c.outcome !== undefined) === (c.phase === 'ended'), {
      message: 'outcome is required when phase is ended, and only then',
      path: ['outcome'],
    }),
  'agent.activity': z.strictObject({
    type: z.literal('agent.activity'),
    agentId: AgentIdSchema,
    runId,
    counts: ToolCountsSchema,
    execState: AgentExecStateSchema,
    helpers: z.int().min(0).max(1000),
    openIncidents: z.int().min(0),
  }),
  'agent.dispatch': z
    .strictObject({
      type: z.literal('agent.dispatch'),
      agentId: AgentIdSchema,
      dispatchId: DispatchIdSchema,
      phase: DispatchPhaseSchema,
      outcome: DispatchOutcomeSchema.optional(),
    })
    .refine((c) => (c.outcome !== undefined) === (c.phase === 'finished'), {
      message: 'outcome is required when phase is finished, and only then',
      path: ['outcome'],
    }),
} as const;

export type WorldCommandType = keyof typeof worldCommandSchemas;
export const WORLD_COMMAND_TYPES = Object.keys(worldCommandSchemas) as WorldCommandType[];
export type WorldCommandOf<T extends WorldCommandType> = z.infer<(typeof worldCommandSchemas)[T]>;
export type WorldCommand = { [T in WorldCommandType]: WorldCommandOf<T> }[WorldCommandType];

export const WorldCommandSchema = z.discriminatedUnion('type', [
  worldCommandSchemas['clock.set'],
  worldCommandSchemas['building.set_open'],
  worldCommandSchemas['agent.house'],
  worldCommandSchemas['agent.connection'],
  worldCommandSchemas['agent.session'],
  worldCommandSchemas['agent.activity'],
  worldCommandSchemas['agent.dispatch'],
]);

/** Who may send each command. Anything else is rejected with `forbidden_source` (P3). */
export const ALLOWED_SOURCES = {
  'clock.set': ['user'],
  'building.set_open': ['user'],
  'agent.house': ['user', 'system'],
  'agent.connection': ['system'],
  'agent.session': ['external-agent'],
  'agent.activity': ['external-agent'],
  'agent.dispatch': ['user', 'system'],
} as const satisfies Record<WorldCommandType, readonly CommandSource[]>;

export function isSourceAllowed(type: WorldCommandType, source: CommandSource): boolean {
  return (ALLOWED_SOURCES[type] as readonly CommandSource[]).includes(source);
}

/** Commands that report a real run: they need a cause and may be inferred. */
const RUN_COMMANDS: ReadonlySet<WorldCommandType> = new Set(['agent.session', 'agent.activity']);

/**
 * A command as submitted to the world host. The source is set by the caller
 * (HTTP is always 'user'), never by the body. `inferred` marks a run command
 * derived from idle-sweep or interrupt events. The source is not checked here:
 * a forbidden source must reach the sim to be logged as `command.rejected`.
 */
export const CommandEnvelopeSchema = z
  .object({
    id: CommandIdSchema,
    source: CommandSourceSchema,
    inferred: z.boolean().optional(),
    cause: RunCauseSchema.optional(),
    command: WorldCommandSchema,
  })
  .superRefine((env, ctx) => {
    const run = RUN_COMMANDS.has(env.command.type);
    if (run && !env.cause) ctx.addIssue({ code: 'custom', message: `${env.command.type} needs a cause`, path: ['cause'] });
    if (!run && env.cause) ctx.addIssue({ code: 'custom', message: `${env.command.type} takes no cause`, path: ['cause'] });
    if (env.inferred && !run) ctx.addIssue({ code: 'custom', message: `${env.command.type} cannot be inferred`, path: ['inferred'] });
    if (run && env.cause && 'runId' in env.command && env.cause.runId !== env.command.runId) {
      ctx.addIssue({ code: 'custom', message: 'cause.runId must equal the command runId', path: ['cause', 'runId'] });
    }
  });
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const RejectCodeSchema = z.enum(['forbidden_source', 'unknown_entity', 'lot_unavailable', 'not_housed', 'invalid']);
export type RejectCode = z.infer<typeof RejectCodeSchema>;

/** The provenance of a command's effect event: its source, or 'inferred' (P1). */
export function effectProvenance(env: Pick<CommandEnvelope, 'source' | 'inferred'>): WorldProvenance {
  return env.inferred ? 'inferred' : env.source;
}

// ── Explanations ─────────────────────────────────────────────────────

export const EntityKindSchema = z.enum(['resident', 'building', 'agent', 'district', 'lot', 'spot']);
export type EntityKind = z.infer<typeof EntityKindSchema>;
export const EntityRefSchema = z.object({ kind: EntityKindSchema, id: z.string().min(1).max(100) });
export type EntityRef = z.infer<typeof EntityRefSchema>;

/** "resident:res_0012" */
export function formatEntityRef(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseEntityRef(s: string): EntityRef | null {
  const i = s.indexOf(':');
  if (i < 0) return null;
  const r = EntityRefSchema.safeParse({ kind: s.slice(0, i), id: s.slice(i + 1) });
  return r.success ? r.data : null;
}

/** The only label a resident's explanation carries. It is never called reasoning. */
export const SIMULATED_DECISION_LABEL = 'Simulated resident · rule-based decision';

/** One reason, citing the recorded field it comes from (e.g. {seq: 812, field: 'needs[0]'}). */
export const ExplanationFactorSchema = z.object({
  text: z.string().min(1),
  source: z.object({ seq: z.int().min(1), field: z.string().min(1) }),
});
export type ExplanationFactor = z.infer<typeof ExplanationFactorSchema>;

export const ExplanationOptionSchema = z.object({
  action: ResidentActionSchema,
  placeId: TownIdSchema.nullable(),
  /** e.g. "Lunch at Corner Café" */
  label: z.string().min(1),
  total: z.int(),
  factors: z.array(ExplanationFactorSchema),
});
export type ExplanationOption = z.infer<typeof ExplanationOptionSchema>;

/** Built only from one recorded `resident.decided` event (plan §3). */
export const ExplanationSchema = z.object({
  subject: EntityRefSchema,
  /** Seq of the `resident.decided` it explains. */
  atSeq: z.int().min(1),
  label: z.literal(SIMULATED_DECISION_LABEL),
  chosen: ExplanationOptionSchema,
  alternatives: z.array(ExplanationOptionSchema).max(2),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

// ── Events ───────────────────────────────────────────────────────────

const resident = z.int().min(0);

/*
 * How each event folds into the snapshot (applyEvent; every reader folds the same way):
 * - world.created: residents from the roster, each at home ({building: homeId}),
 *   action 'rest', no slot, no motion, needs {v0: 0, rate: 0, t0: startTick},
 *   until = startTick; every town building open, its occupancy the number of
 *   residents at home there (so homes start occupied, every other building
 *   at 0). Each resident's 'start' decision follows at the same tick.
 * - resident.decided: action, slotId (reserved at `place`), until,
 *   lastDecisionSeq = seq, and the tracks re-anchor to {v0: needs[i],
 *   rate: rates[i], t0: tick}. `place` is the destination; the resident's
 *   current place changes only with departed and arrived.
 * - resident.departed: place = {outdoor, spotId: null}, motion = {path:
 *   decodeRoute(route), startTick}.
 * - resident.arrived: place, slotId, motion = null, tracks re-anchored as above.
 * - interaction.happened: affinity["a:b"] += dAffinity.
 * - world.clock_changed: speed, prevSpeed. building.open_changed: open.
 * - agent.housed: a presence with health 'not_connected', attention 'none',
 *   no run, empty counts, execState 'idle', no helpers or incidents, no cause, no dispatch.
 * - agent.connection_changed: health, attention.
 * - agent.session_changed: started → activeRunId, counts {}, execState
 *   'working', helpers 0, openIncidents 0; ended → activeRunId null,
 *   execState 'idle'. lastCause = cause.
 * - agent.activity_observed: counts, execState, helpers, openIncidents; lastCause = cause.
 * - agent.dispatch_changed: dispatch = {dispatchId, phase, outcome?}.
 * - world.resumed_after_offline, world.sim_upgraded, command.rejected: log only.
 * Every event sets seq and tick; building occupancy = residents whose place is that building.
 */

/** Payload (`p`) schemas keyed by world event type. `r`, `a`, `b` are resident indexes. */
export const worldEventPayloadSchemas = {
  // system
  'world.created': z
    .object({
      worldId: WorldIdSchema,
      townId: z.string().regex(/^[a-z0-9-]+$/),
      contentHash: ContentHashSchema,
      seed: z.int(),
      simVersion: z.int().min(1),
      startTick: TickSchema,
      /** Every resident, in idx order. */
      roster: z.array(ResidentIdentitySchema),
    })
    .superRefine((p, ctx) => {
      p.roster.forEach((r, i) => {
        if (r.id !== residentId(i)) ctx.addIssue({ code: 'custom', message: `roster[${i}] must be ${residentId(i)}`, path: ['roster', i, 'id'] });
      });
    }),
  'world.resumed_after_offline': z.object({ offlineWallMs: z.int().min(0) }),
  'world.sim_upgraded': z.object({ fromVersion: z.int().min(1), toVersion: z.int().min(1) }),
  'agent.connection_changed': z.object({ agentId: AgentIdSchema, health: ConnectionHealthSchema, attention: AgentAttentionSchema }),
  // user
  /** prevSpeed: the running speed "resume" restores. */
  'world.clock_changed': z.object({ speed: WorldSpeedSchema, prevSpeed: RunningSpeedSchema }),
  'building.open_changed': z.object({ buildingId: BuildingIdSchema, open: z.boolean() }),
  // user or system
  'agent.housed': z.object({ agentId: AgentIdSchema, lotId: LotIdSchema, buildingId: BuildingIdSchema, displayName, hue: hex }),
  'agent.dispatch_changed': z.object({
    agentId: AgentIdSchema,
    dispatchId: DispatchIdSchema,
    phase: DispatchPhaseSchema,
    outcome: DispatchOutcomeSchema.optional(),
  }),
  // external-agent or inferred, always with a cause
  'agent.session_changed': z
    .object({ agentId: AgentIdSchema, runId, phase: z.enum(['started', 'ended']), outcome: RunOutcomeSchema.optional() })
    .refine((p) => (p.outcome !== undefined) === (p.phase === 'ended'), {
      message: 'outcome is required when phase is ended, and only then',
      path: ['outcome'],
    }),
  'agent.activity_observed': z.object({
    agentId: AgentIdSchema,
    runId,
    counts: ToolCountsSchema,
    execState: AgentExecStateSchema,
    helpers: z.int().min(0),
    openIncidents: z.int().min(0),
  }),
  // simulation
  'resident.decided': z
    .object({
      r: resident,
      a: ResidentActionSchema,
      /** The chosen place (the destination when it differs from the current one). */
      place: PlaceSchema,
      /** The slot reserved there (null = none). */
      slotId: SlotIdSchema.nullable(),
      reason: DecisionReasonSchema,
      /** Schedule block id in force (e.g. "lunch"). */
      block: z.string().regex(/^[a-z0-9_]+$/),
      /** Needs at this tick (milli-points); they re-anchor the tracks. */
      needs: NeedValuesSchema,
      /** Need rates from this tick on (walking rates when a departure follows). */
      rates: NeedRatesSchema,
      until: TickSchema,
      /** Best options, highest total first; top[0] is the choice. */
      top: z.array(DecisionOptionSchema).min(1).max(3),
    })
    .superRefine((p, ctx) => {
      const [first] = p.top;
      if (first && (first[0] !== p.a || first[1] !== placeId(p.place))) {
        ctx.addIssue({ code: 'custom', message: 'top[0] must be the chosen action and place', path: ['top', 0] });
      }
      for (let i = 1; i < p.top.length; i++) {
        if (p.top[i]![2] > p.top[i - 1]![2]) ctx.addIssue({ code: 'custom', message: 'top must be sorted by total, highest first', path: ['top', i] });
      }
    }),
  'resident.departed': z.object({ r: resident, route: RouteSchema, startTick: TickSchema, dest: PlaceSchema }),
  /** Re-anchors needs with the action's rates now that the resident is there. */
  'resident.arrived': z.object({ r: resident, place: PlaceSchema, slotId: SlotIdSchema.nullable(), needs: NeedValuesSchema, rates: NeedRatesSchema }),
  'interaction.happened': z
    .object({ a: resident, b: resident, placeId: TownIdSchema, dAffinity: z.int() })
    .refine((p) => p.a < p.b, { message: 'a must be the lower index', path: ['b'] }),
  // the command's source
  'command.rejected': z.object({ cmdId: CommandIdSchema, code: RejectCodeSchema }),
} as const;

export type WorldEventType = keyof typeof worldEventPayloadSchemas;
export const WORLD_EVENT_TYPES = Object.keys(worldEventPayloadSchemas) as WorldEventType[];
export type WorldPayloadOf<T extends WorldEventType> = z.infer<(typeof worldEventPayloadSchemas)[T]>;

export function isWorldEventType(type: string): type is WorldEventType {
  return Object.hasOwn(worldEventPayloadSchemas, type);
}

/** The provenances each event type may carry (P1). */
export const WORLD_EVENT_PROV = {
  'world.created': ['system'],
  'world.resumed_after_offline': ['system'],
  'world.sim_upgraded': ['system'],
  'agent.connection_changed': ['system'],
  'world.clock_changed': ['user'],
  'building.open_changed': ['user'],
  'agent.housed': ['user', 'system'],
  'agent.dispatch_changed': ['user', 'system'],
  'resident.decided': ['simulation'],
  'resident.departed': ['simulation'],
  'resident.arrived': ['simulation'],
  'interaction.happened': ['simulation'],
  'agent.session_changed': ['external-agent', 'inferred'],
  'agent.activity_observed': ['external-agent', 'inferred'],
  'command.rejected': ['user', 'external-agent', 'system'],
} as const satisfies Record<WorldEventType, readonly WorldProvenance[]>;

/** The event each accepted command produces (exactly one; a rejection produces `command.rejected`). */
export const COMMAND_EFFECTS = {
  'clock.set': 'world.clock_changed',
  'building.set_open': 'building.open_changed',
  'agent.house': 'agent.housed',
  'agent.connection': 'agent.connection_changed',
  'agent.session': 'agent.session_changed',
  'agent.activity': 'agent.activity_observed',
  'agent.dispatch': 'agent.dispatch_changed',
} as const satisfies Record<WorldCommandType, WorldEventType>;

/** Movement and decisions: high volume, kept for 3 sim days (plan §4.1). */
export const AMBIENT_WORLD_EVENT_TYPES: readonly WorldEventType[] = ['resident.decided', 'resident.departed', 'resident.arrived'];
export function isAmbientWorldEvent(type: string): boolean {
  return (AMBIENT_WORLD_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * What retention drops after 3 sim days (plan §4.1): the ambient events plus
 * interactions, whose one effect (affinity) lives on in every checkpoint.
 * User, system and agent events are kept. (Studio's log still lists
 * interactions by default: this is about storage, not display.)
 */
export const SHORT_LIVED_WORLD_EVENT_TYPES: readonly WorldEventType[] = [...AMBIENT_WORLD_EVENT_TYPES, 'interaction.happened'];
export function isShortLivedWorldEvent(type: string): boolean {
  return (SHORT_LIVED_WORLD_EVENT_TYPES as readonly string[]).includes(type);
}

const COMMAND_EVENT_TYPES: ReadonlySet<string> = new Set([...Object.values(COMMAND_EFFECTS), 'command.rejected']);
const CAUSED_EVENT_TYPES: ReadonlySet<string> = new Set(['agent.session_changed', 'agent.activity_observed']);

export const WorldEventEnvelopeSchema = z.object({
  /** Contiguous per world from 1; the only ordering key. */
  seq: z.int().min(1),
  tick: TickSchema,
  type: z.string().min(1),
  prov: WorldProvenanceSchema,
  /** Set exactly when prov is external-agent. */
  obs: ObservationSchema.optional(),
  /** The command this event answers (its effect or its rejection). */
  cmdId: CommandIdSchema.optional(),
  /** The entity the event is about (resident, agent or building id), for per-entity queries. */
  actor: z.string().min(1).max(100).optional(),
  /** Required on agent session and activity events; never on simulation events. */
  cause: RunCauseSchema.optional(),
  p: z.unknown(),
});

type EnvelopeFields = Omit<z.infer<typeof WorldEventEnvelopeSchema>, 'type' | 'p'>;
export type WorldEventOf<T extends WorldEventType> = EnvelopeFields & { type: T; p: WorldPayloadOf<T> };
/** Every world event (narrow with `switch (e.type)`). */
export type WorldEvent = { [T in WorldEventType]: WorldEventOf<T> }[WorldEventType];
/** What the sim emits; the host assigns `seq`. */
export type WorldEventDraft = { [T in WorldEventType]: Omit<WorldEventOf<T>, 'seq'> }[WorldEventType];

function describe(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Truth rules every event obeys (P1 and the cause/obs/cmdId shape). Returns problems, empty when valid. */
function eventRuleProblems(e: z.infer<typeof WorldEventEnvelopeSchema> & { type: WorldEventType }): string[] {
  const out: string[] = [];
  const allowed = WORLD_EVENT_PROV[e.type] as readonly WorldProvenance[];
  if (!allowed.includes(e.prov)) out.push(`prov ${e.prov} is not allowed for ${e.type}`);
  if ((e.obs !== undefined) !== (e.prov === 'external-agent')) out.push('obs is required for external-agent events, and only for them');
  if (COMMAND_EVENT_TYPES.has(e.type) !== (e.cmdId !== undefined)) out.push(`cmdId is ${e.cmdId ? 'not allowed' : 'required'} on ${e.type}`);
  if (CAUSED_EVENT_TYPES.has(e.type) && !e.cause) out.push(`${e.type} needs a cause`);
  if (e.cause && !CAUSED_EVENT_TYPES.has(e.type) && e.type !== 'command.rejected') out.push(`${e.type} takes no cause`);
  return out;
}

/** The entity id an event must name as `actor`, when it has one. */
function expectedActor(e: WorldEvent): string | undefined {
  switch (e.type) {
    case 'resident.decided':
    case 'resident.departed':
    case 'resident.arrived':
      return residentId(e.p.r);
    case 'interaction.happened':
      return residentId(e.p.a);
    case 'agent.housed':
    case 'agent.connection_changed':
    case 'agent.session_changed':
    case 'agent.activity_observed':
    case 'agent.dispatch_changed':
      return e.p.agentId;
    case 'building.open_changed':
      return e.p.buildingId;
    default:
      return undefined;
  }
}

/** Strict parse of one world event: known type, valid payload, and the truth rules. Never throws. */
export function parseWorldEvent(raw: unknown): ParseResult<WorldEvent> {
  const env = WorldEventEnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, error: describe(env.error.issues) };
  const e = env.data;
  if (!isWorldEventType(e.type)) return { ok: false, error: `unknown world event type ${e.type}` };
  const p = worldEventPayloadSchemas[e.type].safeParse(e.p);
  if (!p.success) return { ok: false, error: `${e.type}: ${describe(p.error.issues)}` };
  const event = { ...e, type: e.type, p: p.data } as WorldEvent;
  const problems = eventRuleProblems(event);
  const actor = expectedActor(event);
  if (actor !== undefined && event.actor !== actor) problems.push(`actor must be ${actor}`);
  if (event.type === 'world.created' && event.tick !== event.p.startTick) problems.push('world.created must be at its startTick');
  if (problems.length) return { ok: false, error: `${e.type}: ${problems.join('; ')}` };
  return { ok: true, event };
}

/** zod form of parseWorldEvent, for arrays and frames. */
export const WorldEventSchema: z.ZodType<WorldEvent> = z.unknown().transform((raw, ctx) => {
  const r = parseWorldEvent(raw);
  if (!r.ok) {
    ctx.addIssue({ code: 'custom', message: r.error });
    return z.NEVER;
  }
  return r.event;
});

// ── Snapshot ─────────────────────────────────────────────────────────

/** A town building's mutable state. `open` is the user's switch; opening hours from the town file apply on top. */
export const BuildingStateSchema = z.object({ id: BuildingIdSchema, open: z.boolean(), occupancy: z.int().min(0) });
export type BuildingState = z.infer<typeof BuildingStateSchema>;

/** Affinity between two residents, keyed "i:j" with i < j (resident indexes). */
export const AffinitySchema = z.record(z.string().regex(/^\d+:\d+$/), z.int());

/**
 * The whole world state at `seq`: it is what the sim folds (no hidden fields),
 * so Studio applies streamed events to it with the same `applyEvent`.
 */
export const WorldSnapshotSchema = z.object({
  worldId: WorldIdSchema,
  simVersion: z.int().min(1),
  contentHash: ContentHashSchema,
  /** Seq of the last event folded in (0 = empty). */
  seq: z.int().min(0),
  tick: TickSchema,
  speed: WorldSpeedSchema,
  prevSpeed: RunningSpeedSchema,
  residents: z.array(ResidentStateSchema),
  buildings: z.array(BuildingStateSchema),
  agents: z.array(AgentPresenceSchema),
  affinity: AffinitySchema,
});
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
