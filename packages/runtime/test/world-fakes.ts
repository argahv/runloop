/**
 * Test doubles for the agent layer: a world host that applies agent commands
 * exactly as the S0 contract describes (packages/events/src/world.ts, the fold
 * comment and ALLOWED_SOURCES), and a manual clock.
 *
 * The fake validates every envelope with CommandEnvelopeSchema and every
 * event it emits with parseWorldEvent, so a projector bug that breaks the
 * contract fails loudly. It has no residents and no ticking.
 */
import {
  COMMAND_EFFECTS,
  CommandEnvelopeSchema,
  effectProvenance,
  isSourceAllowed,
  parseWorldEvent,
  type AgentPresence,
  type CommandEnvelope,
  type RejectCode,
  type WorldCommandResponse,
  type WorldEvent,
  type WorldSnapshot,
  type WorldSpeed,
} from '@runloop-world/events';
import type { ProjectorClock, WorldCommandSink } from '../src/world/projector';

/** The Commons' six agent lots and the buildings they get. */
export const AGENT_LOTS: Record<string, string> = Object.fromEntries(
  [1, 2, 3, 4, 5, 6].map((n) => [`lot_agent_${n}`, `bld_agent_hq_${n}`]),
);

export class FakeWorldHost implements WorldCommandSink {
  readonly events: WorldEvent[] = [];
  /** Envelopes that failed CommandEnvelopeSchema (must stay empty). */
  readonly invalid: { env: unknown; error: string }[] = [];
  tick = 480;
  speed: WorldSpeed = 1;
  private readonly agents = new Map<string, AgentPresence>();
  private readonly outcomes = new Map<string, WorldCommandResponse>();
  private readonly listeners = new Set<(batch: readonly WorldEvent[]) => void>();

  constructor(
    private readonly lots: Record<string, string> = AGENT_LOTS,
    seed?: { events: readonly WorldEvent[]; agents: readonly AgentPresence[] },
  ) {
    if (seed) {
      this.events.push(...seed.events);
      for (const a of seed.agents) this.agents.set(a.agentId, structuredClone(a));
      for (const e of seed.events) if (e.cmdId) this.outcomes.set(e.cmdId, e.type === 'command.rejected' ? { ok: false, code: e.p.code } : { ok: true, seq: e.seq, tick: e.tick });
    }
  }

  /** A host restarted on this one's state (same log, same presences), of the same class. */
  restart(): this {
    const Ctor = this.constructor as new (lots: Record<string, string>, seed: { events: readonly WorldEvent[]; agents: readonly AgentPresence[] }) => this;
    return new Ctor(this.lots, { events: this.events, agents: [...this.agents.values()] });
  }

  async submit(raw: CommandEnvelope): Promise<WorldCommandResponse> {
    const parsed = CommandEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.invalid.push({ env: raw, error: parsed.error.message });
      return { ok: false, code: 'invalid' };
    }
    const env = parsed.data;
    const seen = this.outcomes.get(env.id);
    if (seen) return seen;
    const code = this.check(env);
    const out: WorldCommandResponse = code ? this.reject(env, code) : this.apply(env);
    this.outcomes.set(env.id, out);
    return out;
  }

  snapshot(): WorldSnapshot {
    return structuredClone({
      worldId: 'test-world',
      simVersion: 1,
      contentHash: '0000000000000000',
      seq: this.events.length,
      tick: this.tick,
      speed: this.speed,
      prevSpeed: 1,
      residents: [],
      buildings: [],
      agents: [...this.agents.values()],
      affinity: {},
    });
  }

  subscribe(fn: (batch: readonly WorldEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  presence(agentId: string): AgentPresence | undefined {
    return this.agents.get(agentId);
  }

  /** Agent events (effects and rejections) in order. */
  agentEvents(agentId?: string): WorldEvent[] {
    return this.events.filter((e) => e.type.startsWith('agent.') && (!agentId || e.actor === agentId));
  }

  private check(env: CommandEnvelope): RejectCode | null {
    const c = env.command;
    if (!isSourceAllowed(c.type, env.source)) return 'forbidden_source';
    if (c.type === 'clock.set' || c.type === 'building.set_open') return null;
    if (c.type === 'agent.house') {
      if (!this.lots[c.lotId]) return 'unknown_entity';
      if ([...this.agents.values()].some((a) => a.lotId === c.lotId)) return 'lot_unavailable';
      if (this.agents.has(c.agentId)) return 'invalid';
      return null;
    }
    return this.agents.has(c.agentId) ? null : 'not_housed';
  }

  private emit(draft: Omit<WorldEvent, 'seq' | 'tick'>): WorldEvent {
    const raw = { ...draft, seq: this.events.length + 1, tick: this.tick };
    const r = parseWorldEvent(raw);
    if (!r.ok) throw new Error(`FakeWorldHost emitted an invalid event: ${r.error}`);
    this.events.push(r.event);
    for (const fn of this.listeners) fn([r.event]);
    return r.event;
  }

  private reject(env: CommandEnvelope, code: RejectCode): WorldCommandResponse {
    this.emit({
      type: 'command.rejected',
      prov: env.source,
      ...(env.source === 'external-agent' ? { obs: 'observed' as const } : {}),
      cmdId: env.id,
      ...(env.cause ? { cause: env.cause } : {}),
      p: { cmdId: env.id, code },
    } as Omit<WorldEvent, 'seq' | 'tick'>);
    return { ok: false, code };
  }

  private apply(env: CommandEnvelope): WorldCommandResponse {
    const c = env.command;
    const prov = effectProvenance(env);
    const base = {
      type: COMMAND_EFFECTS[c.type],
      prov,
      ...(prov === 'external-agent' ? { obs: 'observed' as const } : {}),
      cmdId: env.id,
      ...(env.cause ? { cause: env.cause } : {}),
    };
    let e: WorldEvent;
    switch (c.type) {
      case 'agent.house': {
        const buildingId = this.lots[c.lotId]!;
        e = this.emit({ ...base, actor: c.agentId, p: { agentId: c.agentId, lotId: c.lotId, buildingId, displayName: c.displayName, hue: c.hue } } as never);
        this.agents.set(c.agentId, {
          agentId: c.agentId,
          buildingId,
          lotId: c.lotId,
          displayName: c.displayName,
          hue: c.hue,
          health: 'not_connected',
          attention: 'none',
          activeRunId: null,
          counts: {},
          execState: 'idle',
          helpers: 0,
          openIncidents: 0,
          lastCause: null,
          dispatch: null,
        });
        break;
      }
      case 'agent.connection': {
        e = this.emit({ ...base, actor: c.agentId, p: { agentId: c.agentId, health: c.health, attention: c.attention } } as never);
        Object.assign(this.agents.get(c.agentId)!, { health: c.health, attention: c.attention });
        break;
      }
      case 'agent.session': {
        const { type: _t, ...p } = c;
        e = this.emit({ ...base, actor: c.agentId, p } as never);
        const a = this.agents.get(c.agentId)!;
        if (c.phase === 'started') Object.assign(a, { activeRunId: c.runId, counts: {}, execState: 'working', helpers: 0, openIncidents: 0 });
        else Object.assign(a, { activeRunId: null, execState: 'idle' });
        a.lastCause = env.cause!;
        break;
      }
      case 'agent.activity': {
        const { type: _t, ...p } = c;
        e = this.emit({ ...base, actor: c.agentId, p } as never);
        Object.assign(this.agents.get(c.agentId)!, { counts: c.counts, execState: c.execState, helpers: c.helpers, openIncidents: c.openIncidents, lastCause: env.cause! });
        break;
      }
      case 'agent.dispatch': {
        const { type: _t, ...p } = c;
        e = this.emit({ ...base, actor: c.agentId, p } as never);
        this.agents.get(c.agentId)!.dispatch = { dispatchId: c.dispatchId, phase: c.phase, ...(c.outcome ? { outcome: c.outcome } : {}) };
        break;
      }
      case 'clock.set': {
        const prevSpeed = this.speed === 0 ? 1 : this.speed;
        this.speed = c.speed;
        e = this.emit({ ...base, p: { speed: c.speed, prevSpeed } } as never);
        break;
      }
      case 'building.set_open':
        e = this.emit({ ...base, actor: c.buildingId, p: { buildingId: c.buildingId, open: c.open } } as never);
        break;
    }
    return { ok: true, seq: e.seq, tick: e.tick };
  }
}

/** A clock the test advances; timers fire in due order (also those scheduled while advancing). */
export class ManualClock implements ProjectorClock {
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  constructor(public t = Date.parse('2026-10-18T10:00:00Z')) {}

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Move time forward by `ms`, running every timer that falls due (0 runs what is due now). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}
