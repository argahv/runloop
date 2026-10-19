import { describe, expect, it } from 'vitest';
import { rankCommands, SEARCH_ONLY_LIMIT, type Command } from '../state/commands';
import { speedCaption } from './send';

const cmd = (label: string, extra: Partial<Command> = {}): Command => ({ id: label, group: 'G', label, run: () => undefined, ...extra });

describe('⌘K with town entities', () => {
  const entities = Array.from({ length: 50 }, (_, i) => cmd(`Resident ${String(i).padStart(2, '0')}`, { group: 'Town', searchOnly: true }));
  const all = [cmd('Overview'), cmd('Pause the world'), ...entities];

  it('keeps entities out of the empty palette and every existing command in it', () => {
    expect(rankCommands(all, '').map((c) => c.label)).toEqual(['Overview', 'Pause the world']);
  });

  it('finds at most 20 entities for a query', () => {
    const r = rankCommands(all, 'resident');
    expect(r).toHaveLength(SEARCH_ONLY_LIMIT);
    expect(rankCommands(all, 'resident 07').map((c) => c.label)).toEqual(['Resident 07']);
  });
});

describe('time controls caption (UX §6)', () => {
  it('says simulated time only, and that real agents keep running', () => {
    expect(speedCaption(4, [])).toBe('Simulated time ×4. Real agents run at real speed.');
    expect(speedCaption(0, [])).toBe('World paused.');
    expect(speedCaption(0, ['Engineering House'])).toBe('World paused. Real agents keep running: Engineering House is live.');
    expect(speedCaption(0, ['A', 'B'])).toBe('World paused. Real agents keep running: 2 agents are live.');
  });
});
