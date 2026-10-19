/**
 * Interact (plan §3 phase 4): residents who have been socialising at the same
 * place for at least 5 minutes pair up by hash. Each place pairs its
 * socialisers once every 30 minutes, at its own minute (hash of seed and
 * place), so no resident interacts twice at a place within 30 minutes and
 * the town's interactions are spread over the half hour. "Socialising since"
 * is the anchor of their needs (set when they arrived or decided), so no
 * hidden timers are needed.
 */
import { placeId, residentId, type ResidentState, type Tick } from '@runloop-world/events';
import { hash32 } from '@runloop-world/town';
import type { DecideContext } from './decide';

export const SETTLE_MINUTES = 5;
export const INTERACT_EVERY = 30;

export function interact(ctx: DecideContext, tick: Tick): void {
  const { s, world } = ctx;
  const byPlace = new Map<string, ResidentState[]>();
  for (const r of s.residents) {
    if (r.action !== 'socialize' || r.motion || tick - r.needs[0].t0 < SETTLE_MINUTES) continue;
    const id = placeId(r.place);
    if (!id || tick % INTERACT_EVERY !== hash32(world.seed, 'pairing', id) % INTERACT_EVERY) continue;
    let list = byPlace.get(id);
    if (!list) byPlace.set(id, (list = []));
    list.push(r);
  }
  for (const place of [...byPlace.keys()].sort()) {
    const here = byPlace.get(place)!;
    const paired = new Set<number>();
    for (const r of here) {
      if (paired.has(r.idx)) continue;
      const partners = here.filter((o) => o.idx !== r.idx && !paired.has(o.idx));
      if (!partners.length) break;
      const other = partners[hash32(world.seed, tick, r.idx, 'pair') % partners.length]!;
      paired.add(r.idx);
      paired.add(other.idx);
      const a = Math.min(r.idx, other.idx);
      const b = Math.max(r.idx, other.idx);
      ctx.emit({
        tick,
        type: 'interaction.happened',
        prov: 'simulation',
        actor: residentId(a),
        p: { a, b, placeId: place, dAffinity: 1 + (hash32(world.seed, tick, a, b, 'aff') % 3) },
      });
    }
  }
}
