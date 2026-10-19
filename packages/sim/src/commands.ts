/**
 * Inputs (plan §3 phase 1): each command is checked against ALLOWED_SOURCES
 * and the entity rules, then emits exactly one event: its effect (provenance
 * = its source, or 'inferred'; P1) or `command.rejected`.
 */
import {
  COMMAND_EFFECTS,
  effectProvenance,
  isSourceAllowed,
  type CommandEnvelope,
  type RejectCode,
  type Tick,
  type WorldEvent,
  type WorldEventDraft,
} from '@runloop-world/events';
import { validateClaim, type CompiledTown } from '@runloop-world/town';
import type { SimState } from './apply';

export type CommandCheck = { ok: true } | { ok: false; code: RejectCode };

/**
 * ALLOWED_SOURCES first (forbidden_source), then the entity rules:
 * unknown_entity (no such building or lot), lot_unavailable (taken, or not an
 * agent lot), not_housed (agent commands before agent.house), invalid
 * (housing an agent that is already housed). Which run an agent shows is the
 * projector's business: session and activity commands follow the fold.
 */
export function validateCommand(s: SimState, town: CompiledTown, env: CommandEnvelope): CommandCheck {
  const cmd = env.command;
  if (!isSourceAllowed(cmd.type, env.source)) return { ok: false, code: 'forbidden_source' };
  switch (cmd.type) {
    case 'clock.set':
      return { ok: true };
    case 'building.set_open':
      return town.buildingById.has(cmd.buildingId) ? { ok: true } : { ok: false, code: 'unknown_entity' };
    case 'agent.house': {
      const claim = validateClaim(town, cmd.lotId, new Set(s.agents.map((a) => a.lotId)));
      if (!claim.ok) return claim;
      if (s.agents.some((a) => a.agentId === cmd.agentId)) return { ok: false, code: 'invalid' };
      return { ok: true };
    }
    case 'agent.connection':
    case 'agent.dispatch':
    case 'agent.session':
    case 'agent.activity':
      return s.agents.some((a) => a.agentId === cmd.agentId) ? { ok: true } : { ok: false, code: 'not_housed' };
  }
}

/** The effect event of an accepted command. */
function effectDraft(s: SimState, town: CompiledTown, env: CommandEnvelope, tick: Tick): WorldEventDraft {
  const prov = effectProvenance(env);
  const base = { tick, prov, cmdId: env.id, ...(prov === 'external-agent' ? { obs: 'observed' as const } : {}) };
  const cmd = env.command;
  switch (cmd.type) {
    case 'clock.set':
      return { ...base, type: COMMAND_EFFECTS[cmd.type], p: { speed: cmd.speed, prevSpeed: cmd.speed === 0 ? s.prevSpeed : cmd.speed } };
    case 'building.set_open':
      return { ...base, type: COMMAND_EFFECTS[cmd.type], actor: cmd.buildingId, p: { buildingId: cmd.buildingId, open: cmd.open } };
    case 'agent.house': {
      const lot = town.lotById.get(cmd.lotId)!;
      return {
        ...base,
        type: COMMAND_EFFECTS[cmd.type],
        actor: cmd.agentId,
        p: { agentId: cmd.agentId, lotId: cmd.lotId, buildingId: lot.buildingId!, displayName: cmd.displayName, hue: cmd.hue },
      };
    }
    case 'agent.connection':
      return { ...base, type: COMMAND_EFFECTS[cmd.type], actor: cmd.agentId, p: { agentId: cmd.agentId, health: cmd.health, attention: cmd.attention } };
    case 'agent.session':
      return {
        ...base,
        type: COMMAND_EFFECTS[cmd.type],
        actor: cmd.agentId,
        cause: env.cause!,
        p: { agentId: cmd.agentId, runId: cmd.runId, phase: cmd.phase, ...(cmd.outcome !== undefined ? { outcome: cmd.outcome } : {}) },
      };
    case 'agent.activity':
      return {
        ...base,
        type: COMMAND_EFFECTS[cmd.type],
        actor: cmd.agentId,
        cause: env.cause!,
        p: { agentId: cmd.agentId, runId: cmd.runId, counts: { ...cmd.counts }, execState: cmd.execState, helpers: cmd.helpers, openIncidents: cmd.openIncidents },
      };
    case 'agent.dispatch':
      return {
        ...base,
        type: COMMAND_EFFECTS[cmd.type],
        actor: cmd.agentId,
        p: { agentId: cmd.agentId, dispatchId: cmd.dispatchId, phase: cmd.phase, ...(cmd.outcome !== undefined ? { outcome: cmd.outcome } : {}) },
      };
  }
}

/** Apply one command: emit its effect or its rejection (provenance = its source). Returns the emitted event. */
export function applyCommand(s: SimState, town: CompiledTown, env: CommandEnvelope, tick: Tick, emit: (d: WorldEventDraft) => WorldEvent): WorldEvent {
  const check = validateCommand(s, town, env);
  if (check.ok) return emit(effectDraft(s, town, env, tick));
  return emit({
    tick,
    type: 'command.rejected',
    prov: env.source,
    cmdId: env.id,
    ...(env.source === 'external-agent' ? { obs: 'observed' as const } : {}),
    ...(env.cause ? { cause: env.cause } : {}),
    p: { cmdId: env.id, code: check.code },
  });
}
