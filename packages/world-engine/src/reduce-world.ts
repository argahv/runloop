import { SequenceGapError, type ExecState } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import type { Cell, CharacterPreset } from './definition';
import { deriveIntent, type Intent } from './intent';
import { eventTick, haltMotion, redirectMotion } from './motion';
import type { CharacterWorld, CompiledWorld, StationWorld, Target, WorldState } from './types';

export function initialWorldState(): WorldState {
  return {
    lastSequence: 0,
    tick: 0,
    runStartMs: null,
    paused: false,
    characters: {},
    characterOrder: [],
    stations: {},
  };
}

/**
 * Fold one event into the world simulation. Pure. `exec` is the Layer-1 state
 * AFTER folding `e`; Layer 2 never reads tool output, only that state.
 * Same idempotency / gap rules as reduceExecution.
 *
 * Each event: create characters for newly registered embodied agents, then
 * re-derive every character's intent. Changed intents release their station
 * place, queued characters are promoted into freed slots, new places are
 * reserved (logically, at event time) and characters re-route from the cell
 * they are entering. While the run is paused intents freeze and walkers stop
 * at the cell they are entering; resuming re-derives and re-routes everyone.
 */
export function reduceWorld(w: WorldState, exec: ExecState, e: AnyEvent, world: CompiledWorld): WorldState {
  if (e.sequence <= w.lastSequence) return w;
  if (e.sequence !== w.lastSequence + 1) throw new SequenceGapError(w.lastSequence + 1, e.sequence);

  const ms = Date.parse(e.timestamp);
  const runStartMs = w.runStartMs ?? ms;
  const tick = eventTick(w.tick, ms, runStartMs, world.def.tickHz);
  const sim = new Sim(w, world, tick);
  sim.registerCharacters(exec);

  if (exec.run.status === 'paused') {
    if (!w.paused) sim.freeze();
    return sim.finish({ lastSequence: e.sequence, tick, runStartMs, paused: true });
  }
  sim.updateIntents(exec, w.paused);
  return sim.finish({ lastSequence: e.sequence, tick, runStartMs, paused: false });
}

const cellKey = (c: Cell) => `${c[0]},${c[1]}`;

/** Copy-on-write working set for one reduceWorld step (keeps unchanged references). */
class Sim {
  private characters: Record<string, CharacterWorld>;
  private characterOrder: string[];
  private stations: Record<string, StationWorld>;
  private copiedChars = false;
  private copiedStations = false;
  private readonly w: WorldState;
  private readonly world: CompiledWorld;
  private readonly tick: number;

  constructor(w: WorldState, world: CompiledWorld, tick: number) {
    this.w = w;
    this.world = world;
    this.tick = tick;
    this.characters = w.characters;
    this.characterOrder = w.characterOrder;
    this.stations = w.stations;
    if (w.lastSequence === 0) {
      this.stations = {};
      for (const s of world.def.stations) this.stations[s.id] = { slots: s.slots.map(() => null), overflow: [] };
      this.copiedStations = true;
    }
  }

  finish(fields: Pick<WorldState, 'lastSequence' | 'tick' | 'runStartMs' | 'paused'>): WorldState {
    return {
      ...this.w,
      ...fields,
      characters: this.characters,
      characterOrder: this.characterOrder,
      stations: this.stations,
    };
  }

  private setChar(c: CharacterWorld) {
    if (!this.copiedChars) {
      this.characters = { ...this.characters };
      this.copiedChars = true;
    }
    this.characters[c.agentId] = c;
  }

  private setStation(id: string, st: StationWorld) {
    if (!this.copiedStations) {
      this.stations = { ...this.stations };
      this.copiedStations = true;
    }
    this.stations[id] = st;
  }

  /** Embodied agents get a character at their preset's home (offset if taken). */
  registerCharacters(exec: ExecState) {
    for (const id of exec.agentOrder) {
      const a = exec.agents[id]!;
      if (!a.embodied || this.characters[id]) continue;
      const preset =
        (a.characterPreset ? this.world.presetsById[a.characterPreset] : undefined) ??
        this.world.presetsById[this.world.def.defaultPreset]!;
      const home = this.homeFor(preset);
      this.setChar({
        agentId: id,
        presetId: preset.id,
        home,
        activity: 'idle',
        taskId: null,
        stationId: null,
        stationKind: null,
        target: { kind: 'home' },
        motion: { path: [home], startTick: this.tick },
        sinceTick: this.tick,
      });
      this.characterOrder = [...this.characterOrder, id];
    }
  }

  /**
   * The preset home, or (when another character already lives there) the
   * nearest walkable cell, in BFS order N,E,S,W, that is nobody's home, no
   * preset's home and no station slot/overflow.
   */
  private homeFor(preset: CharacterPreset): Cell {
    const taken = new Set(this.characterOrder.map((id) => cellKey(this.characters[id]!.home)));
    if (!taken.has(cellKey(preset.home))) return preset.home;
    const reserved = new Set(taken);
    for (const p of this.world.def.characterPresets) reserved.add(cellKey(p.home));
    for (const s of this.world.def.stations) {
      for (const c of s.slots) reserved.add(cellKey(c));
      reserved.add(cellKey(s.overflow));
    }
    const seen = new Set([cellKey(preset.home)]);
    const queue: Cell[] = [preset.home];
    for (let head = 0; head < queue.length; head++) {
      const [x, y] = queue[head]!;
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const n: Cell = [x + dx, y + dy];
        const k = cellKey(n);
        if (seen.has(k) || !this.world.isWalkable(n[0], n[1])) continue;
        if (!reserved.has(k)) return n;
        seen.add(k);
        queue.push(n);
      }
    }
    return preset.home;
  }

  /** Pause: everyone finishes the step they are on and stands still. */
  freeze() {
    const tpc = this.world.def.ticksPerCell;
    for (const id of this.characterOrder) {
      const c = this.characters[id]!;
      const motion = haltMotion(c.motion, this.tick, tpc);
      if (motion !== c.motion) this.setChar({ ...c, motion });
    }
  }

  updateIntents(exec: ExecState, resuming: boolean) {
    const changed: { id: string; intent: Intent }[] = [];
    for (const id of this.characterOrder) {
      const c = this.characters[id]!;
      const intent = deriveIntent(exec, id, this.world);
      // 'succeeded' is only entered on the completing event; it then lasts until
      // something else changes (presentationAt fades it to idle after a moment).
      if (c.activity === 'succeeded' && intent.activity === 'idle') continue;
      // The station kind can change within one task (a Read, then an Edit), so it is compared too.
      if (intent.activity !== c.activity || intent.taskId !== c.taskId || intent.stationKind !== c.stationKind) {
        changed.push({ id, intent });
      }
    }

    for (const { id } of changed) this.release(id);
    this.promoteQueued();
    for (const { id, intent } of changed) {
      const c = this.characters[id]!;
      const target = this.reserve(id, intent);
      this.setChar({
        ...c,
        activity: intent.activity,
        taskId: intent.taskId,
        stationKind: intent.stationKind,
        stationId: target.kind === 'slot' || target.kind === 'overflow' ? target.stationId : null,
        target,
        motion: this.route(c, target),
        // Entering 'succeeded' always means a fresh completion, so its reaction restarts.
        sinceTick: intent.activity !== c.activity || intent.activity === 'succeeded' ? this.tick : c.sinceTick,
      });
    }

    if (resuming) {
      // Walkers were halted by the pause: send everyone on to their target again.
      for (const id of this.characterOrder) {
        const c = this.characters[id]!;
        const motion = this.route(c, c.target);
        if (motion !== c.motion) this.setChar({ ...c, motion });
      }
    }
  }

  /** Give up the character's slot or overflow place. */
  private release(agentId: string) {
    const t = this.characters[agentId]!.target;
    if (t.kind === 'slot') {
      const st = this.stations[t.stationId]!;
      if (st.slots[t.index] !== agentId) return;
      const slots = st.slots.slice();
      slots[t.index] = null;
      this.setStation(t.stationId, { ...st, slots });
    } else if (t.kind === 'overflow') {
      const st = this.stations[t.stationId]!;
      this.setStation(t.stationId, { ...st, overflow: st.overflow.filter((a) => a !== agentId) });
    }
  }

  /** Fill free slots with the heads of overflow queues of the same station kind. */
  private promoteQueued() {
    for (const station of this.world.def.stations) {
      const candidates = this.world.stationsByKind[station.kind] ?? [];
      for (;;) {
        const index = this.stations[station.id]!.slots.indexOf(null);
        if (index < 0) break;
        const queue = candidates.find((s) => this.stations[s.id]!.overflow.length > 0);
        if (!queue) break;
        const q = this.stations[queue.id]!;
        const agentId = q.overflow[0]!;
        this.setStation(queue.id, { ...q, overflow: q.overflow.slice(1) });
        this.occupy(station.id, index, agentId);
        const c = this.characters[agentId]!;
        const target: Target = { kind: 'slot', stationId: station.id, index };
        this.setChar({ ...c, stationId: station.id, target, motion: this.route(c, target) });
      }
    }
  }

  private occupy(stationId: string, index: number, agentId: string) {
    const st = this.stations[stationId]!;
    const slots = st.slots.slice();
    slots[index] = agentId;
    this.setStation(stationId, { ...st, slots });
  }

  /**
   * Choose and reserve the character's new place. Stations of the wanted kind
   * are tried in id order, lowest free slot first; if all are full the agent
   * queues at the first candidate's overflow cell.
   */
  private reserve(agentId: string, intent: Intent): Target {
    if (intent.activity === 'failed') return { kind: 'stay' };
    const wantsStation = intent.activity === 'working' || intent.activity === 'awaiting_approval';
    const candidates = wantsStation && intent.stationKind ? (this.world.stationsByKind[intent.stationKind] ?? []) : [];
    if (candidates.length === 0) return { kind: 'home' };
    for (const s of candidates) {
      const index = this.stations[s.id]!.slots.indexOf(null);
      if (index >= 0) {
        this.occupy(s.id, index, agentId);
        return { kind: 'slot', stationId: s.id, index };
      }
    }
    const first = candidates[0]!;
    const st = this.stations[first.id]!;
    this.setStation(first.id, { ...st, overflow: [...st.overflow, agentId] });
    return { kind: 'overflow', stationId: first.id };
  }

  private route(c: CharacterWorld, target: Target) {
    const tpc = this.world.def.ticksPerCell;
    if (target.kind === 'stay') return haltMotion(c.motion, this.tick, tpc);
    return redirectMotion(this.world, c.motion, this.tick, this.cellOf(c, target));
  }

  private cellOf(c: CharacterWorld, target: Target): Cell {
    switch (target.kind) {
      case 'slot':
        return this.world.stationsById[target.stationId]!.slots[target.index]!;
      case 'overflow':
        return this.world.stationsById[target.stationId]!.overflow;
      default:
        return c.home;
    }
  }
}
