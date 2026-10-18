/**
 * Sending world commands from Studio. HTTP commands are always the user's
 * (P2: the body is `{id, command}` only). Nothing changes on screen until
 * the engine's effect event arrives: the command shows as pending, then
 * either the event clears it or the rejection is shown with its reason.
 */
import type { WorldCommand, WorldCommandResponse, WorldSpeed } from '@runloop-world/events';
import { postWorldCommand } from './api';
import type { WorldStore } from './store';

let counter = 0;

/** A fresh command id (idempotency key): `ui:<time>:<n>:<random>`. */
export function newCommandId(nowMs: number = Date.now()): string {
  counter = (counter + 1) % 1e6;
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36);
  return `ui:${nowMs.toString(36)}:${counter}:${rand}`;
}

/** How long a rejection stays on screen before the chip goes away. */
export const REJECTION_MS = 6000;

export async function sendWorldCommand(store: WorldStore, command: WorldCommand, label: string): Promise<WorldCommandResponse | null> {
  const id = newCommandId();
  const s = store.getState();
  s.addPending({ id, command, label, sentAt: Date.now(), state: 'sending' });
  try {
    const res = await postWorldCommand(id, command);
    if (!res.ok) store.getState().resolvePending(id, { ok: false, reason: res.code, state: 'rejected' });
    else store.getState().resolvePending(id, { ok: true });
    if (!res.ok) setTimeout(() => store.getState().dropPending(id), REJECTION_MS);
    // An accepted command whose event got lost in a reconnect must not stay pending forever.
    else setTimeout(() => store.getState().dropPending(id), 10_000);
    return res;
  } catch (e) {
    store.getState().resolvePending(id, { ok: false, reason: e instanceof Error ? e.message : String(e), state: 'failed' });
    setTimeout(() => store.getState().dropPending(id), REJECTION_MS);
    return null;
  }
}

export const SPEED_LABEL: Record<WorldSpeed, string> = { 0: 'Pause', 1: '1×', 4: '4×', 16: '16×' };

/** The clock caption (UX §6): what the speed means, and that real agents are not affected. */
export function speedCaption(speed: WorldSpeed, liveAgentNames: readonly string[]): string {
  if (speed === 0) {
    if (liveAgentNames.length === 0) return 'World paused.';
    const who = liveAgentNames.length === 1 ? `${liveAgentNames[0]} is live` : `${liveAgentNames.length} agents are live`;
    return `World paused. Real agents keep running: ${who}.`;
  }
  return `Simulated time ×${speed}. Real agents run at real speed.`;
}
