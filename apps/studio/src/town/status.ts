/**
 * What an agent's building, robot and label show for its reported state
 * (pure). Only what the engine recorded is shown: health and attention come
 * from `agent.connection_changed`, the activity from
 * `agent.activity_observed`. Lime (working) appears only while the agent is
 * live and reported working; identity hue never signals state.
 */
import type { AgentPresence } from '@runloop-world/events';

export type RobotState = 'working' | 'waiting' | 'awaiting_approval' | 'idle' | 'failed' | 'off';
export type LabelTone = 'none' | 'live' | 'warn' | 'fail' | 'muted';

type Presence = Pick<AgentPresence, 'health' | 'attention' | 'execState'>;

/** The robot's eyes and ring. */
export function robotStateOf(a: Presence): RobotState {
  if (a.health !== 'live' && a.health !== 'idle') return 'off';
  if (a.attention === 'incident') return 'failed';
  if (a.attention === 'permission_requested' || a.attention === 'dispatch_awaiting_approval') return 'awaiting_approval';
  if (a.health === 'idle') return 'idle';
  return a.execState;
}

/** The label's status text and tone (text always; colour never alone). */
export function agentStatus(a: Presence): { text: string; tone: LabelTone } {
  switch (a.health) {
    case 'not_connected':
      return { text: 'Not connected', tone: 'muted' };
    case 'awaiting_first_event':
      return { text: 'Waiting for first event', tone: 'muted' };
    case 'offline':
      return { text: 'Offline', tone: 'muted' };
    case 'unknown':
      return { text: 'Not reported', tone: 'muted' };
    default:
      break;
  }
  const s = robotStateOf(a);
  if (s === 'failed') return { text: 'Incident', tone: 'fail' };
  if (s === 'awaiting_approval') return { text: a.attention === 'dispatch_awaiting_approval' ? 'Task awaiting approval' : 'Needs approval', tone: 'warn' };
  if (s === 'waiting') return { text: 'Live · waiting', tone: 'warn' };
  if (s === 'working') return { text: 'Live · working', tone: 'live' };
  return { text: a.health === 'idle' ? 'Idle' : 'Live · idle', tone: 'none' };
}

/** Whether the headquarters stands dimmed: housed, but no real event yet (or nothing known). */
export function isDimmedHq(a: Pick<AgentPresence, 'health'>): boolean {
  return a.health === 'awaiting_first_event' || a.health === 'not_connected' || a.health === 'unknown';
}

/** Whether its windows are lit: a session is open (live or idle). */
export function isLitHq(a: Pick<AgentPresence, 'health'>): boolean {
  return a.health === 'live' || a.health === 'idle';
}
