/**
 * What Runloop can do with a Claude Code agent, each with the reason when it
 * cannot (plan §4.3). Pure. Studio shows every capability; an unavailable one
 * is a disabled chip carrying its reason.
 */
import type { Capability, CapabilityStatus } from '@runloop-world/events';

export interface CapabilitySignals {
  ingestOn: boolean;
  /** A bound run recorded its first event. */
  hasFirstEvent: boolean;
  /** Bound sessions (traced runs) so far. */
  sessions: number;
  /** The `claude` CLI flag probe (S4); 'off' when this runtime does not serve dispatch. */
  cli: 'unprobed' | 'missing' | 'ok' | 'off';
  /** Why the probe failed (cli 'missing'). */
  cliReason?: string;
  /** The organisation's dispatch policy allows this agent. */
  policyAllowsDispatch: boolean;
  /** Dispatches Runloop launched that are still running. */
  runningDispatches: number;
}

const available: CapabilityStatus = { state: 'available', reason: null };
const status = (state: CapabilityStatus['state'], reason: string): CapabilityStatus => ({ state, reason });

export function capabilitiesFor(s: CapabilitySignals): Record<Capability, CapabilityStatus> {
  const observe = !s.ingestOn
    ? status('needs_setup', 'Tracing is off: start Runloop with Claude Code ingest enabled')
    : s.hasFirstEvent
      ? available
      : status('needs_setup', 'Waiting for the first hook event from Claude Code in this workspace');

  const inspect = s.sessions > 0 ? available : status('needs_setup', 'No traced session yet');

  const submitReasons: string[] = [];
  if (s.cli === 'off') submitReasons.push('task dispatch is turned off in this runtime');
  if (s.cli === 'unprobed') submitReasons.push('the claude CLI has not been checked yet');
  if (s.cli === 'missing') submitReasons.push(s.cliReason ?? 'the claude CLI was not found or lacks the required flags');
  if (!s.policyAllowsDispatch) submitReasons.push("your organisation's policy does not allow dispatch");
  const submit_task = submitReasons.length === 0 ? available : status('needs_setup', `Task dispatch needs setup: ${submitReasons.join('; ')}`);

  const cancel =
    s.runningDispatches > 0 ? available : status('unsupported', 'Runloop can only stop tasks it launched, and none is running');

  return {
    observe,
    inspect,
    submit_task,
    cancel,
    message: status('unsupported', 'Claude Code offers no way to send a message into a running session'),
    control: status('unsupported', 'Claude Code hooks only report; Runloop cannot pause or steer a session'),
  };
}
