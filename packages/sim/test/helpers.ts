/** Test helpers: the Commons, and a headless world loop (what the host does, minus I/O and clock). */
import { parseWorldEvent, type CommandEnvelope, type WorldEvent, type WorldEventDraft } from '@runloop-world/events';
import { canonicalJson, fnv1a64, loadTown, type CompiledTown } from '@runloop-world/town';
import { readCommons } from '../../town/test/load-commons';
import { applyEvent, applyInputs, createWorld, step, type SimState, type SimWorld } from '../src/index';

let cached: CompiledTown | null = null;
export function commons(): CompiledTown {
  if (!cached) {
    const raw = readCommons();
    cached = loadTown(raw.town, raw.interiors);
  }
  return cached;
}

export interface Run {
  world: SimWorld;
  state: SimState;
  events: WorldEvent[];
  /** The last tick stepped. */
  tick: number;
  /** Assigns the seq, checks the event against the contract, applies it. */
  emit: (d: WorldEventDraft) => WorldEvent;
}

/** A new world: world.created and the first decisions, applied. `strict` parses every event (truth rules). */
export function newWorld(opts: { seed?: number; population?: number; strict?: boolean; town?: CompiledTown; worldId?: string } = {}): Run {
  const town = opts.town ?? commons();
  const world: SimWorld = { town, seed: opts.seed ?? 42 };
  const run = { world, events: [] as WorldEvent[], state: null as unknown as SimState } as Run;
  run.emit = makeEmit(run, opts.strict ?? false);
  for (const d of createWorld(town, { worldId: opts.worldId ?? 'test-world', seed: world.seed, population: opts.population ?? town.def.population.default })) run.emit(d);
  run.tick = run.state.tick;
  return run;
}

/** Continue a world from a state and its log (e.g. after a restart). */
export function resume(world: SimWorld, state: SimState, events: WorldEvent[], tick: number, strict = false): Run {
  const run = { world, events, state, tick } as Run;
  run.emit = makeEmit(run, strict);
  return run;
}

function makeEmit(run: Run, strict: boolean) {
  return (d: WorldEventDraft): WorldEvent => {
    const raw = { ...d, seq: run.events.length ? run.events.at(-1)!.seq + 1 : 1 };
    let e = raw as WorldEvent;
    if (strict) {
      const r = parseWorldEvent(raw);
      if (!r.ok) throw new Error(`invalid event: ${r.error}\n${JSON.stringify(raw)}`);
      e = r.event;
    }
    run.events.push(e);
    run.state = applyEvent(run.state ?? null, e, run.world.town);
    return e;
  };
}

/** Step ticks (from the state's next tick) up to and including `until`; `inputs` by tick; `each` after every tick. */
export function runUntil(run: Run, until: number, opts: { inputs?: Map<number, CommandEnvelope[]>; each?: (tick: number) => void } = {}): void {
  for (let t = run.tick + 1; t <= until; t++) {
    step(run.state, run.world, t, opts.inputs?.get(t) ?? [], run.emit);
    run.tick = t;
    opts.each?.(t);
  }
}

export function between(run: Run, tick: number, inputs: CommandEnvelope[]): WorldEvent[] {
  return applyInputs(run.state, run.world, tick, inputs, run.emit);
}

/** Hash of a whole event log. */
export function logHash(events: readonly WorldEvent[]): string {
  return fnv1a64(canonicalJson(events));
}

export const AGENT = 'agt_5f1c2a8e-3b4d-4c6e-9a7b-1d2e3f405a61';
export const AGENT_B = 'agt_9b2d4e6f-1a3c-4e5d-8f7a-2b3c4d5e6f70';
export const RUN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** A day of scripted commands from every source (for determinism and provenance tests). */
export function scriptedCommands(start: number): Map<number, CommandEnvelope[]> {
  const at = new Map<number, CommandEnvelope[]>();
  const add = (tick: number, env: CommandEnvelope) => at.set(tick, [...(at.get(tick) ?? []), env]);
  add(start + 1, { id: `house:${AGENT}`, source: 'user', command: { type: 'agent.house', agentId: AGENT, lotId: 'lot_agent_1', displayName: 'Engineering House', hue: '#5aa9f5' } });
  add(start + 1, { id: `conn:${AGENT}:1`, source: 'system', command: { type: 'agent.connection', agentId: AGENT, health: 'awaiting_first_event', attention: 'none' } });
  add(start + 4, { id: `sess:${RUN}:start:1`, source: 'external-agent', cause: { runId: RUN, seqFrom: 1, seqTo: 1 }, command: { type: 'agent.session', agentId: AGENT, runId: RUN, phase: 'started' } });
  add(start + 6, { id: `act:${RUN}:14`, source: 'external-agent', cause: { runId: RUN, seqFrom: 1, seqTo: 14 }, command: { type: 'agent.activity', agentId: AGENT, runId: RUN, counts: { read: 4, edit: 1 }, execState: 'working', helpers: 1, openIncidents: 0 } });
  add(start + 7, { id: `house:${AGENT_B}`, source: 'system', command: { type: 'agent.house', agentId: AGENT_B, lotId: 'lot_agent_1', displayName: 'Docs Desk', hue: '#e0946a' } });
  add(start + 8, { id: 'clock:1', source: 'user', command: { type: 'clock.set', speed: 4 } });
  add(start + 9, { id: 'clock:forbidden', source: 'system', command: { type: 'clock.set', speed: 16 } });
  add(start + 200, { id: 'close:diner', source: 'user', command: { type: 'building.set_open', buildingId: 'bld_bluebird_diner', open: false } });
  add(start + 260, { id: 'open:diner', source: 'user', command: { type: 'building.set_open', buildingId: 'bld_bluebird_diner', open: true } });
  add(start + 300, { id: `sess:${RUN}:end`, source: 'external-agent', inferred: true, cause: { runId: RUN, seqFrom: 15, seqTo: 20 }, command: { type: 'agent.session', agentId: AGENT, runId: RUN, phase: 'ended', outcome: 'interrupted' } });
  add(start + 400, { id: 'pause', source: 'user', command: { type: 'clock.set', speed: 0 } });
  add(start + 400, { id: 'resume', source: 'user', command: { type: 'clock.set', speed: 4 } });
  return at;
}
