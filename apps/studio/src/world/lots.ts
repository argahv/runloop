/**
 * Agent lots (contract §4.3): their short names and whether Add to World may
 * pick one. Pure; unit-tested.
 */
import type { CompiledTown } from '@runloop-world/town';

/** "Lot 3" from "lot_agent_3". */
export function lotLabel(id: string): string {
  const n = Number(id.replace(/\D+/g, ''));
  return Number.isFinite(n) && n > 0 ? `Lot ${n}` : id;
}

/**
 * Why a lot cannot be picked, or null when it can: it must be an agent lot of
 * this town that no agent holds. With no town loaded yet nothing can be checked
 * (null; the runtime still refuses a bad lot on submit).
 */
export function lotRefusal(
  town: Pick<CompiledTown, 'lotById'> | null,
  agents: readonly { lotId: string; displayName: string }[] | null,
  lotId: string,
): string | null {
  if (!town) return null;
  const lot = town.lotById.get(lotId);
  if (!lot || lot.use !== 'agent') return `Lot not available: “${lotId}” is not an agent lot in this town. Pick a free lot.`;
  const holder = agents?.find((a) => a.lotId === lotId);
  if (holder) return `Lot not available: ${lotLabel(lotId)} is ${holder.displayName}'s. Pick a free lot.`;
  return null;
}
