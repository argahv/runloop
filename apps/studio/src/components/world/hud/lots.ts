/**
 * Add to World's lots (contract §4.3): every agent lot of the town, free or
 * taken (with its agent's name), as the renderer's `LotPick` and the banner's
 * buttons. Pure; unit-tested.
 */
import type { CompiledTown } from '@runloop-world/town';
import type { LotPick } from '../../../town/types';

/** "Lot 3" from "lot_agent_3". */
export function lotLabel(id: string): string {
  const n = Number(id.replace(/\D+/g, ''));
  return Number.isFinite(n) && n > 0 ? `Lot ${n}` : id;
}

export function lotPickModel(
  town: Pick<CompiledTown, 'agentLots'>,
  agents: readonly { lotId: string; displayName: string }[],
  selected: string | null,
): LotPick {
  const taken = new Map(agents.map((a) => [a.lotId, a.displayName]));
  return {
    selected,
    lots: town.agentLots.map((l) => {
      const who = taken.get(l.id);
      return { id: l.id, state: who ? 'taken' : 'free', label: who ? `${lotLabel(l.id)} · ${who}` : `${lotLabel(l.id)} · Free` };
    }),
  };
}
