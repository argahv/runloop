/**
 * createWorld (plan §3): the roster and each resident's first decision. All
 * draws are hash32 of the seed, so the same town, seed and population always
 * give the same residents and the same first hour.
 */
import { MINUTES_PER_DAY, residentId, type ResidentIdentity, type Tick, type WorldEvent, type WorldEventDraft } from '@runloop-world/events';
import { hash32, hashRange, minuteOf, type CompiledTown } from '@runloop-world/town';
import { applyEvent, type SimState } from './apply';
import { startTick as runStart } from './step';
import { SIM_VERSION } from './version';

export interface CreateWorldOptions {
  worldId: string;
  seed: number;
  population: number;
  /** Defaults to Day 1 at the town's startTime (08:00). */
  startTick?: Tick;
}

/** Residents by role share (largest remainder), homes filled round-robin, workplaces with free slots, names unique. */
export function buildRoster(town: CompiledTown, seed: number, population: number): ResidentIdentity[] {
  const { def } = town;
  if (!Number.isInteger(population) || population < 1) throw new Error(`population must be a positive integer, not ${population}`);
  if (population > def.population.max) throw new Error(`population ${population} exceeds the town's ${def.population.max}`);
  const total = def.roles.reduce((n, r) => n + r.share, 0);
  const counts = def.roles.map((r) => Math.floor((population * r.share) / total));
  const byRemainder = def.roles
    .map((r, i) => [(population * r.share) % total, i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0, left = population - counts.reduce((a, b) => a + b, 0); k < left; k++) counts[byRemainder[k]![1]]!++;
  const roles = def.roles
    .flatMap((r, i) => Array.from({ length: counts[i]! }, (_, j) => ({ role: r, key: hash32(seed, 'role', i, j) })))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.role);

  const homes = town.buildings.filter((b) => b.isHome);
  const bedsLeft = new Map(homes.map((b) => [b.def.id, b.slots.filter((s) => s.tags.includes('sleep')).length]));
  const workLeft = new Map<string, number>();
  for (const r of def.roles) {
    if (!r.work) continue;
    const tag = r.work.tag ?? 'work';
    for (const id of r.work.buildings) {
      const b = town.buildingById.get(id)!;
      workLeft.set(`${id}:${tag}`, b.slots.filter((s) => s.tags.includes('work') && s.tags.includes(tag)).length);
    }
  }
  const { first, last } = def.names;
  const used = new Set<string>();
  const pick = <T>(list: readonly T[], ...parts: (number | string)[]): T => list[hash32(seed, ...parts) % list.length]!;
  let cursor = 0;
  return roles.map((role, idx) => {
    let homeId: string | null = null;
    for (let k = 0; k < homes.length && !homeId; k++) {
      const h = homes[(cursor + k) % homes.length]!;
      if (bedsLeft.get(h.def.id)! > 0) {
        homeId = h.def.id;
        bedsLeft.set(homeId, bedsLeft.get(homeId)! - 1);
        cursor = (cursor + k + 1) % homes.length;
      }
    }
    if (!homeId) throw new Error('not enough beds');
    let workId: string | null = null;
    if (role.work) {
      const tag = role.work.tag ?? 'work';
      const open = role.work.buildings.filter((id) => workLeft.get(`${id}:${tag}`)! > 0);
      if (!open.length) throw new Error(`no work slots left for ${role.id}`);
      workId = pick(open, 'work', idx);
      workLeft.set(`${workId}:${tag}`, workLeft.get(`${workId}:${tag}`)! - 1);
    }
    let name = '';
    for (let attempt = 0; !name || used.has(name); attempt++) name = `${pick(first, 'first', idx, attempt)} ${pick(last, 'last', idx, attempt)}`;
    used.add(name);
    const tops = def.look.tops[role.outfit] ?? def.look.tops.casual ?? Object.values(def.look.tops)[0]!;
    return {
      id: residentId(idx),
      name,
      role: role.id,
      homeId,
      workId,
      traits: [hashRange(10, 90, seed, 'trait', idx, 0), hashRange(10, 90, seed, 'trait', idx, 1), hashRange(10, 90, seed, 'trait', idx, 2)],
      outfit: {
        style: role.outfit,
        top: pick(tops, 'top', idx),
        bottom: pick(def.look.bottoms, 'bottom', idx),
        skin: pick(def.look.skin, 'skin', idx),
        hair: pick(def.look.hair, 'hair', idx),
      },
    };
  });
}

/** world.created (with the roster) plus each resident's first decision, as drafts, in log order from seq 1. */
export function createWorld(town: CompiledTown, options: CreateWorldOptions): WorldEventDraft[] {
  const start = options.startTick ?? minuteOf(town.def.startTime);
  if (!Number.isInteger(start) || start < 0) throw new Error(`startTick must be a non-negative integer, not ${start}`);
  const roster = buildRoster(town, options.seed, options.population);
  const created: WorldEventDraft = {
    tick: start,
    type: 'world.created',
    prov: 'system',
    p: {
      worldId: options.worldId,
      townId: town.def.id,
      contentHash: town.contentHash,
      seed: options.seed,
      simVersion: SIM_VERSION,
      startTick: start,
      roster,
    },
  };
  const drafts: WorldEventDraft[] = [created];
  let seq = 1;
  const s: SimState = applyEvent(null, { ...created, seq } as WorldEvent, town);
  runStart(s, { town, seed: options.seed }, start, (d) => {
    drafts.push(d);
    const e = { ...d, seq: ++seq } as WorldEvent;
    applyEvent(s, e);
    return e;
  });
  return drafts;
}

/** Day 1 at `clock` ("08:00") as a tick. */
export function tickAt(day: number, clock: string): Tick {
  return (day - 1) * MINUTES_PER_DAY + minuteOf(clock);
}
