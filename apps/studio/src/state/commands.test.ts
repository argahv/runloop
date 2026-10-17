import { describe, expect, it } from 'vitest';
import { rankCommands, type Command } from './commands';

const cmd = (id: string, label: string, group = 'Go to', keywords?: string): Command => ({ id, group, label, run: () => {}, ...(keywords ? { keywords } : {}) });
const all = [
  cmd('overview', 'Overview'),
  cmd('world', 'Live World', 'Go to', '3d agents'),
  cmd('traces', 'Traces'),
  cmd('run3', 'Run #3 · Build a task store', 'Runs'),
  cmd('theme', 'Theme: dark', 'Preferences', 'appearance'),
];
const ids = (q: string) => rankCommands(all, q).map((c) => c.id);

describe('command ranking', () => {
  it('keeps everything for an empty query', () => {
    expect(ids('')).toEqual(all.map((c) => c.id));
  });
  it('requires every term and searches keywords and groups', () => {
    expect(ids('task store')).toEqual(['run3']);
    expect(ids('3d')).toEqual(['world']);
    expect(ids('preferences')).toEqual(['theme']);
    expect(ids('nothing here')).toEqual([]);
  });
  it('ranks label prefixes, then word starts, then substrings', () => {
    expect(ids('t')).toEqual(['traces', 'theme', 'run3', 'overview', 'world'].filter((id) => ids('t').includes(id)));
    expect(ids('t')[0]).toBe('traces');
    expect(ids('#3')).toEqual(['run3']);
  });
});
