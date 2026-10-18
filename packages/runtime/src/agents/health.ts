/**
 * Connection health and attention of a real agent (plan §4.3, P9). Pure: the
 * caller gathers the signals and passes the time. Only real signals count:
 * the ingest switch, a registered root, received hook envelopes, open bound
 * runs and (S4) a running dispatch.
 */
import type { AgentAttention, ConnectionHealth } from '@runloop-world/events';

/** An open run counts as live while it had an event this recently. */
export const LIVE_WINDOW_MS = 5 * 60_000;

export interface HealthSignals {
  /** Claude Code ingest is served (tracing on, with a token). */
  ingestOn: boolean;
  /** The agent's workspace has at least one root. */
  hasRoot: boolean;
  /** Wall time of the first recorded event of a bound run (null = none yet). */
  firstEventAt: number | null;
  /** Wall time the last hook envelope of a bound session arrived. */
  lastEnvelopeAt: number | null;
  /** Bound runs still open. */
  openRuns: number;
  /** A dispatch Runloop launched is running or orphaned (S4): a session is open even before its first hook. */
  dispatchRunning: boolean;
}

/**
 * The first rule that matches wins:
 * unknown (ingest off) → not_connected (no root) → awaiting_first_event (no
 * event yet) → live (a session is open, as a run or a running dispatch, and a
 * hook arrived in the last 5 min) → idle (a session is open but quiet) →
 * offline. Only arriving events make an agent live: a dispatch whose session
 * sends no hooks (untraced) reads idle, never live. A restart lands on
 * offline, because recoverInterrupted has already closed every open run.
 */
export function deriveHealth(s: HealthSignals, now: number): ConnectionHealth {
  if (!s.ingestOn) return 'unknown';
  if (!s.hasRoot) return 'not_connected';
  if (s.firstEventAt === null) return 'awaiting_first_event';
  const recent = s.lastEnvelopeAt !== null && now - s.lastEnvelopeAt < LIVE_WINDOW_MS;
  const open = s.openRuns > 0 || s.dispatchRunning;
  if (open && recent) return 'live';
  if (open) return 'idle';
  return 'offline';
}

export interface AttentionSignals {
  /** Permission requests still pending in open bound runs. */
  pendingPermissions: number;
  /** Unresolved incidents in open bound runs. */
  openIncidents: number;
  /** A dispatch preview waits for approval (S4). */
  dispatchAwaitingApproval: boolean;
}

/** What needs the user, most urgent first. */
export function deriveAttention(s: AttentionSignals): AgentAttention {
  if (s.pendingPermissions > 0) return 'permission_requested';
  if (s.dispatchAwaitingApproval) return 'dispatch_awaiting_approval';
  if (s.openIncidents > 0) return 'incident';
  return 'none';
}
