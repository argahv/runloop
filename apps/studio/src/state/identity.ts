import type { ExecState } from '@runloop-world/core';

/** Number of identity hues in tokens.css (--rl-id-1 … --rl-id-8). */
export const IDENTITY_HUES = 8;

/**
 * Identity hue (1-based) of an agent: embodied agents in registration order,
 * wrapping after 8. Non-embodied agents, 'system' and unknown ids have none.
 * Identity never signals state; the same index is meant for the 3D robots and
 * the agent graph so an agent looks the same everywhere.
 */
export function identityIndex(exec: ExecState, agentId: string): number | null {
  if (!exec.agents[agentId]?.embodied) return null;
  let i = 0;
  for (const id of exec.agentOrder) {
    if (!exec.agents[id]?.embodied) continue;
    if (id === agentId) return (i % IDENTITY_HUES) + 1;
    i += 1;
  }
  return null;
}

/** CSS colour for an agent's identity (a token reference). */
export function identityColor(exec: ExecState, agentId: string): string {
  const i = identityIndex(exec, agentId);
  return i === null ? 'var(--rl-id-neutral)' : `var(--rl-id-${i})`;
}
