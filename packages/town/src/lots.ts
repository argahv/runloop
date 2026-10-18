/** Agent lots: the empty plots a real agent's headquarters can be housed on. */
import type { CompiledTown } from './compile';
import type { Lot } from './schema';

/** Agent lots not housing an agent yet (`taken` = lot ids in use), in id order. */
export function freeAgentLots(town: CompiledTown, taken: ReadonlySet<string>): Lot[] {
  return town.agentLots.filter((l) => !taken.has(l.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type LotClaim = { ok: true; buildingId: string } | { ok: false; code: 'unknown_entity' | 'lot_unavailable' };

/** Whether an agent may be housed on `lotId` (maps onto the world's RejectCode). */
export function validateClaim(town: CompiledTown, lotId: string, taken: ReadonlySet<string>): LotClaim {
  const lot = town.lotById.get(lotId);
  if (!lot) return { ok: false, code: 'unknown_entity' };
  if (lot.use !== 'agent' || !lot.buildingId || taken.has(lotId)) return { ok: false, code: 'lot_unavailable' };
  return { ok: true, buildingId: lot.buildingId };
}

/** The agent lot whose headquarters has this building id, if any. */
export function agentLotOfBuilding(town: CompiledTown, buildingId: string): Lot | undefined {
  return town.agentLots.find((l) => l.buildingId === buildingId);
}
