/**
 * Explanations (plan §3, P10): built only from one recorded
 * `resident.decided` event. Every factor cites the event field it comes from
 * ({seq, field}); nothing is inferred or invented. The town only supplies
 * names (places, needs, schedule blocks) and the walking cost per minute.
 */
import {
  NEED_IDS,
  SIMULATED_DECISION_LABEL,
  type DecisionOption,
  type Explanation,
  type ExplanationFactor,
  type ExplanationOption,
  type ResidentAction,
  type WorldEventOf,
} from '@runloop-world/events';
import type { CompiledTown } from '@runloop-world/town';
import { points } from './needs';

/** Which needs each action relieves when no town is given (the Commons' weights). */
const DEFAULT_SATISFIES: Record<ResidentAction, readonly (typeof NEED_IDS)[number][]> = {
  sleep: ['energy'],
  rest: ['energy'],
  eat: ['hunger'],
  work: [],
  socialize: ['social'],
  stroll: ['social'],
};
const DEFAULT_NEED_LABELS = ['Hunger', 'Tiredness', 'Loneliness'];

const VERBS: Record<ResidentAction, string> = {
  sleep: 'Sleep at',
  rest: 'Rest at',
  eat: 'Eat at',
  work: 'Work at',
  socialize: 'Socialise at',
  stroll: 'Stroll to',
};

const REASONS = {
  start: 'First decision since the world began',
  arrived: 'Arrived at their destination',
  need: 'A need reached its threshold',
  schedule: 'Their schedule moved on',
  until: 'Finished what they were doing',
  dest_closed: 'Where they were going (or were) closed',
} as const;

function placeName(town: CompiledTown | undefined, id: string | null): string {
  if (!id) return 'somewhere outdoors';
  return town?.buildingById.get(id)?.def.name ?? town?.spotById.get(id)?.def.label ?? id;
}

function blockLabel(town: CompiledTown | undefined, blockId: string, role: string | undefined): string {
  if (!town) return blockId;
  const own = role ? town.def.schedules.find((s) => s.id === town.def.roles.find((r) => r.id === role)?.schedule) : undefined;
  const block = own?.blocks.find((b) => b.id === blockId) ?? town.def.schedules.flatMap((s) => s.blocks).find((b) => b.id === blockId);
  return block?.label ?? blockId;
}

/** Why a resident decided, from the recorded event only (P10). `role` picks the right schedule's block names. */
export function explain(decided: WorldEventOf<'resident.decided'>, town?: CompiledTown, role?: string): Explanation {
  const { seq, p } = decided;
  const needLabels = town ? town.def.needs.map((n) => n.label) : DEFAULT_NEED_LABELS;
  const satisfies = town?.def.weights.satisfies ?? DEFAULT_SATISFIES;
  const perMinute = town?.def.weights.travelPerMinute ?? 0;
  const block = blockLabel(town, p.block, role);
  const factor = (text: string, field: string): ExplanationFactor => ({ text, source: { seq, field } });

  const option = (o: DecisionOption, k: number): ExplanationOption => {
    const [action, place, total, need, sched, travel] = o;
    const factors: ExplanationFactor[] = [];
    if (need > 0) {
      for (const n of satisfies[action]) {
        const i = NEED_IDS.indexOf(n);
        factors.push(factor(`${needLabels[i]} ${points(p.needs[i as 0 | 1 | 2])}/100`, `needs[${i}]`));
      }
    }
    if (sched !== 0) factors.push(factor(`${block} ${sched > 0 ? '+' : '−'}${Math.abs(sched)}`, `top[${k}][4]`));
    if (travel > 0) {
      const minutes = perMinute > 0 ? travel / perMinute : null;
      factors.push(factor(minutes !== null ? `Walk ${minutes} min −${travel}` : `Walking −${travel}`, `top[${k}][5]`));
    }
    const rest = total - need - sched + travel;
    if (rest !== 0) factors.push(factor(`Personality, habit and chance ${rest > 0 ? '+' : '−'}${Math.abs(rest)}`, `top[${k}][2]`));
    const label = action === 'eat' && p.block === 'lunch' ? `Lunch at ${placeName(town, place)}` : `${VERBS[action]} ${placeName(town, place)}`;
    return { action, placeId: place, label, total, factors };
  };

  const chosen = option(p.top[0]!, 0);
  let why: string = REASONS[p.reason];
  if (p.reason === 'need' && town) {
    const over = town.def.needs.filter((n, i) => p.needs[i as 0 | 1 | 2] >= n.threshold * 1000).map((n) => n.label.toLowerCase());
    if (over.length) why = `${over.join(' and ')} reached ${over.length > 1 ? 'their thresholds' : 'its threshold'}`.replace(/^./, (c) => c.toUpperCase());
  }
  if (p.reason === 'schedule') why = `Schedule: ${block}`;
  chosen.factors.unshift(factor(why, 'reason'));
  return {
    subject: { kind: 'resident', id: decided.actor ?? `res_${String(p.r + 1).padStart(4, '0')}` },
    atSeq: seq,
    label: SIMULATED_DECISION_LABEL,
    chosen,
    alternatives: p.top.slice(1, 3).map((o, i) => option(o, i + 1)),
  };
}
