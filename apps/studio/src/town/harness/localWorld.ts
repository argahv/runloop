/**
 * The harness's world: the real engine (createWorld, step) running in the
 * page, so the renderer can be built, measured and screenshotted without a
 * runtime. Everything it shows is simulation output; the agents it houses
 * come from fixture commands (the same shapes as the sim's fixture day) and
 * are labelled as fixture data by the harness. Dev only (never in Studio).
 */
import type { CommandEnvelope, WorldEvent, WorldEventDraft, WorldSnapshot } from '@runloop-world/events';
import { applyEvent, applyInputs, createWorld, step, type SimState, type SimWorld } from '@runloop-world/sim';
import type { CompiledTown } from '@runloop-world/town';
import type { TownClock } from '../clock';

export class LocalWorld {
  readonly world: SimWorld;
  state: SimState;
  tick: number;
  speed: number;
  private seq = 0;
  /** Wall time (ms) at which `tick` became current. */
  private tickAt = 0;
  readonly events: WorldEvent[] = [];

  constructor(readonly town: CompiledTown, opts: { seed: number; population: number; startTick: number }) {
    this.world = { town, seed: opts.seed };
    let s: SimState | null = null;
    for (const d of createWorld(town, { worldId: 'harness', seed: opts.seed, population: opts.population, startTick: opts.startTick })) {
      const e = { ...d, seq: ++this.seq } as WorldEvent;
      s = applyEvent(s, e, town);
    }
    this.state = s!;
    this.tick = opts.startTick;
    this.speed = 1;
  }

  private emit = (d: WorldEventDraft): WorldEvent => {
    const e = { ...d, seq: ++this.seq } as WorldEvent;
    this.state = applyEvent(this.state, e, this.town);
    this.events.push(e);
    if (this.events.length > 2000) this.events.splice(0, 1000);
    return e;
  };

  /** Run whole ticks up to `tick` (fast-forward). */
  runTo(tick: number, inputs: ReadonlyMap<number, CommandEnvelope[]> = new Map()): void {
    for (let t = this.tick + 1; t <= tick; t++) {
      step(this.state, this.world, t, inputs.get(t) ?? [], this.emit);
      this.tick = t;
    }
  }

  /** Apply commands now (between ticks), as the host does. */
  command(...envs: CommandEnvelope[]): void {
    applyInputs(this.state, this.world, this.tick, envs, this.emit);
    if (envs.some((e) => e.command.type === 'clock.set')) this.speed = this.state.speed;
  }

  /** Advance in real time at the world's speed; returns the clock the renderer interpolates from. */
  advance(now: number): TownClock {
    if (this.tickAt === 0) this.tickAt = now;
    if (this.speed > 0) {
      const due = Math.floor(((now - this.tickAt) * this.speed) / 1000);
      // Never catch up more than 40 ticks per frame (the host drops them the same way).
      const n = Math.min(due, 40);
      if (n > 0) {
        this.runTo(this.tick + n);
        this.tickAt = n === due ? this.tickAt + (n * 1000) / this.speed : now;
      }
    } else {
      this.tickAt = now;
    }
    return { tick: this.tick, speed: this.speed, receivedAt: this.tickAt };
  }

  snapshot(): WorldSnapshot {
    return this.state;
  }
}

const AGENTS = [
  { id: 'agt_5f1c2a8e-3b4d-4c6e-9a7b-1d2e3f405a61', lot: 'lot_agent_1', name: 'Engineering House', hue: '#5aa9f5', run: '7c9e6679-7425-40de-944b-e07fc1f90ae7', state: 'working' },
  { id: 'agt_9b2d4e6f-1a3c-4e5d-8f7a-2b3c4d5e6f70', lot: 'lot_agent_4', name: 'Docs Desk', hue: '#e0946a', run: null, state: 'awaiting' },
  { id: 'agt_0c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5', lot: 'lot_agent_2', name: 'Review Bot', hue: '#a08cf9', run: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', state: 'approval' },
  { id: 'agt_3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7', lot: 'lot_agent_6', name: 'Night Shift', hue: '#43c6d9', run: null, state: 'offline' },
] as const;

export const HARNESS_AGENT_IDS = AGENTS.map((a) => a.id);

/** House the fixture agents in their demo states (fixture commands, same shapes the projector sends). */
export function houseFixtureAgents(w: LocalWorld, count: number = AGENTS.length): void {
  for (const a of AGENTS.slice(0, count)) {
    w.command({ id: `house:${a.id}`, source: 'user', command: { type: 'agent.house', agentId: a.id, lotId: a.lot, displayName: a.name, hue: a.hue } });
    if (a.state === 'awaiting') {
      w.command({ id: `conn:${a.id}:1`, source: 'system', command: { type: 'agent.connection', agentId: a.id, health: 'awaiting_first_event', attention: 'none' } });
      continue;
    }
    if (a.state === 'offline') {
      w.command({ id: `conn:${a.id}:1`, source: 'system', command: { type: 'agent.connection', agentId: a.id, health: 'offline', attention: 'none' } });
      continue;
    }
    const run = a.run!;
    w.command({ id: `sess:${run}:start:1`, source: 'external-agent', cause: { runId: run, seqFrom: 1, seqTo: 1 }, command: { type: 'agent.session', agentId: a.id, runId: run, phase: 'started' } });
    w.command({
      id: `act:${run}:14`,
      source: 'external-agent',
      cause: { runId: run, seqFrom: 1, seqTo: 14 },
      command: { type: 'agent.activity', agentId: a.id, runId: run, counts: { read: 4, search: 2, edit: 1 }, execState: a.state === 'approval' ? 'awaiting_approval' : 'working', helpers: 1, openIncidents: 0 },
    });
    w.command({
      id: `conn:${a.id}:2`,
      source: 'system',
      command: { type: 'agent.connection', agentId: a.id, health: 'live', attention: a.state === 'approval' ? 'permission_requested' : 'none' },
    });
  }
}

/** The first agent (its headquarters mounts the fixture run). */
export const FIXTURE_HQ_AGENT = AGENTS[0].id;
