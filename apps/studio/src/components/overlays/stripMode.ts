/**
 * The session strip's state chip (contract §1.1 S): what the playhead shows
 * and, for an open session, the agent's own health. An open run is not a live
 * agent: a quiet session reads "Open · idle 12m" (as the sidebar says "idle"),
 * never "Live" with the health pulse. Pure; unit-tested.
 */
import type { ConnectionHealth } from '@runloop-world/events';
import { formatAgo } from '../../state/runs';
import type { IconName } from '../../ui/Icon';
import { healthView } from '../../world/selectors';

export interface StripMode {
  text: string;
  icon: IconName;
  /** The agent is live right now (the only state drawn in the live accent). */
  live: boolean;
}

export function stripMode(o: { following: boolean; open: boolean; health: ConnectionHealth | null; lastEventAt: string | null; nowMs: number }): StripMode {
  if (!o.following) return { text: 'Replay · recorded state', icon: 'clock', live: false };
  if (!o.open) return { text: 'Recorded · latest', icon: 'checkCircle', live: false };
  if (o.health === 'live') return { text: 'Live', icon: 'pulse', live: true };
  if (!o.health) return { text: 'Open · health not reported', icon: 'ellipsis', live: false };
  const t = o.lastEventAt ? Date.parse(o.lastEventAt) : Number.NaN;
  const quiet = o.health === 'idle' && Number.isFinite(t) ? ` ${formatAgo(Math.max(0, o.nowMs - t))}` : '';
  const h = healthView(o.health);
  return { text: `Open · ${h.text.toLowerCase()}${quiet}`, icon: h.icon, live: false };
}

/** A session in the picker: open (still recording) or recorded, never "Live" (that is the agent's health). */
export const sessionStateLabel = (status: string) => (status === 'running' ? 'Open' : 'Recorded');
