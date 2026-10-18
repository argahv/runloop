import { describe, expect, it } from 'vitest';
import { agentStatus, isDimmedHq, isLitHq, robotStateOf } from './status';

const healths = ['not_connected', 'awaiting_first_event', 'live', 'idle', 'offline', 'unknown'] as const;
const attentions = ['none', 'permission_requested', 'incident', 'dispatch_awaiting_approval'] as const;
const execs = ['working', 'waiting', 'awaiting_approval', 'idle'] as const;

describe('agent status (what buildings, robots and labels show)', () => {
  it('shows working (lime) only for a live agent reported working with nothing needing attention', () => {
    for (const health of healths)
      for (const attention of attentions)
        for (const execState of execs) {
          const live = agentStatus({ health, attention, execState }).tone === 'live';
          expect(live).toBe(health === 'live' && attention === 'none' && execState === 'working');
          expect(robotStateOf({ health, attention, execState }) === 'working').toBe(live);
        }
  });
  it('never animates an agent that has sent nothing, or is offline (P9)', () => {
    for (const health of ['not_connected', 'awaiting_first_event', 'offline', 'unknown'] as const) {
      for (const execState of execs) {
        expect(robotStateOf({ health, attention: 'none', execState })).toBe('off');
        expect(agentStatus({ health, attention: 'none', execState }).tone).toBe('muted');
        expect(isLitHq({ health })).toBe(false);
      }
    }
    expect(agentStatus({ health: 'awaiting_first_event', attention: 'none', execState: 'idle' }).text).toBe('Waiting for first event');
    expect(isDimmedHq({ health: 'awaiting_first_event' })).toBe(true);
    expect(isDimmedHq({ health: 'offline' })).toBe(false);
  });
  it('says attention in words as well as colour', () => {
    expect(agentStatus({ health: 'live', attention: 'permission_requested', execState: 'working' })).toEqual({ text: 'Needs approval', tone: 'warn' });
    expect(agentStatus({ health: 'live', attention: 'incident', execState: 'working' })).toEqual({ text: 'Incident', tone: 'fail' });
    expect(agentStatus({ health: 'unknown', attention: 'none', execState: 'idle' }).text).toBe('Not reported');
  });
});
