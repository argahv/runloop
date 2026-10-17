import { foldExecution } from '@runloop-world/core';
import { codingMissionFixture } from '@runloop-world/testkit';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  EMPTY_FILTER,
  eventSubject,
  facetsOf,
  matchesFilter,
  parseFilter,
  rowSubject,
  toggleFacet,
  writeFilter,
  type FilterSubject,
  type TraceFilter,
} from './filters';
import { agentOfEvent } from './selection';
import { buildTimelineRows, rowStatusAt } from './timeline';

const events = codingMissionFixture();
const exec = foldExecution(events);
const t0 = Date.parse(events[0]!.timestamp);
const rows = buildTimelineRows(events, (seq) => Date.parse(events[seq - 1]!.timestamp) - t0);
const last = events.length;
const subjects = rows.map((r) => rowSubject(r, rowStatusAt(r, last), exec.agents[r.actorId]?.name ?? r.actorId));
const visible = (f: Partial<TraceFilter>) => rows.filter((_, i) => matchesFilter(subjects[i]!, { ...EMPTY_FILTER, ...f }));

describe('trace filter: matching', () => {
  it('passes everything when empty', () => {
    expect(visible({})).toHaveLength(rows.length);
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
  });

  it('filters by agent, tool, status and event type', () => {
    expect(visible({ agents: ['tester'] }).every((r) => r.actorId === 'tester')).toBe(true);
    expect(visible({ tools: ['run_command'] }).map((r) => r.callId)).toEqual(['call-6', 'call-9']);
    // The failing test run is the only tool row with an error.
    expect(visible({ statuses: ['error'], types: ['tool.call_started'] }).map((r) => r.callId)).toEqual(['call-6']);
    // Tool rows merge their completion, so the completion type finds them too.
    expect(visible({ types: ['tool.call_completed'] })).toHaveLength(9);
  });

  it('ORs values within a facet and ANDs facets together', () => {
    const either = visible({ tools: ['run_command', 'write_file'] });
    expect(either.map((r) => r.tool)).toEqual(['write_file', 'run_command', 'write_file', 'run_command']);
    const both = visible({ tools: ['run_command', 'write_file'], agents: ['builder'] });
    expect(both.map((r) => r.callId)).toEqual(['call-5', 'call-8']);
    expect(visible({ tools: ['run_command'], agents: ['builder'] })).toEqual([]);
  });

  it('matches every text term, case-insensitively, across title, detail and agent name', () => {
    const hits = visible({ text: 'RUN_COMMAND tester' });
    expect(hits.map((r) => r.callId)).toEqual(expect.arrayContaining(['call-6', 'call-9']));
    for (const r of hits) {
      const i = rows.indexOf(r);
      expect(subjects[i]!.text.toLowerCase()).toContain('run_command');
      expect(subjects[i]!.text.toLowerCase()).toContain('tester');
    }
    expect(visible({ text: 'run_command builder' })).toEqual([]);
    expect(visible({ text: '   ' })).toHaveLength(rows.length);
  });

  it('matches category and inferred only when the data carries them', () => {
    const subject: FilterSubject = { text: 'Bash npm test', agentId: 'main', tool: 'Bash', category: 'test', statuses: ['error', 'inferred'], types: ['tool.call_started'] };
    expect(matchesFilter(subject, { ...EMPTY_FILTER, categories: ['test'] })).toBe(true);
    expect(matchesFilter(subject, { ...EMPTY_FILTER, categories: ['edit'] })).toBe(false);
    expect(matchesFilter(subject, { ...EMPTY_FILTER, statuses: ['inferred'] })).toBe(true);
    // Executed runs have no categories: a category filter hides their rows.
    expect(visible({ categories: ['test'] })).toEqual([]);
    expect(visible({ statuses: ['inferred'] })).toEqual([]);
  });

  it('sees a call as running at a playhead inside it', () => {
    const call6 = rows.find((r) => r.callId === 'call-6')!;
    const atStart = rowSubject(call6, rowStatusAt(call6, call6.seq), 'Tester');
    expect(matchesFilter(atStart, { ...EMPTY_FILTER, statuses: ['running'] })).toBe(true);
    expect(matchesFilter(atStart, { ...EMPTY_FILTER, statuses: ['error'] })).toBe(false);
  });
});

describe('trace filter: log events', () => {
  it('derives status, tool and agent per event', () => {
    const failed = events[35]!; // #36 tool.call_completed (error)
    const s = eventSubject(failed, { exec, agentId: agentOfEvent(failed, exec), agentName: 'Tester', call: { tool: 'run_command', category: null }, running: false });
    expect(s).toMatchObject({ agentId: 'tester', tool: 'run_command', statuses: ['error'], types: ['tool.call_completed'] });
    const start = events[33]!; // #34 tool.call_started
    expect(eventSubject(start, { exec, agentId: 'tester', agentName: 'Tester', call: null, running: true }).statuses).toEqual(['running']);
    const system = eventSubject(events[0]!, { exec, agentId: null, agentName: 'System', call: null, running: false });
    expect(system.agentId).toBe('system');
  });

  it('marks inferred events from their provenance', () => {
    const e = { ...events[12]!, provenance: 'inferred' } as (typeof events)[number];
    expect(eventSubject(e, { exec, agentId: 'researcher', agentName: 'Researcher', call: null, running: false }).statuses).toContain('inferred');
  });
});

describe('trace filter: URL and facets', () => {
  it('round-trips through query parameters and keeps other parameters', () => {
    const f: TraceFilter = { text: 'node --test', agents: ['tester', 'builder'], tools: ['run_command'], categories: [], statuses: ['error', 'running'], types: ['tool.call_completed'] };
    const params = new URLSearchParams('run=abc&event=12');
    writeFilter(params, f);
    expect(params.get('run')).toBe('abc');
    expect(params.getAll('actor')).toEqual(['tester', 'builder']);
    expect(parseFilter(params)).toEqual(f);
    writeFilter(params, EMPTY_FILTER);
    expect(params.toString()).toBe('run=abc&event=12');
  });

  it('drops unknown statuses and duplicates', () => {
    expect(parseFilter(new URLSearchParams('status=ok&status=bogus&status=ok&tool=a&tool=a'))).toMatchObject({ statuses: ['ok'], tools: ['a'] });
  });

  it('toggles facet values and counts active filters', () => {
    const on = toggleFacet(EMPTY_FILTER, 'tools', 'read_file');
    expect(on.tools).toEqual(['read_file']);
    expect(toggleFacet(on, 'tools', 'read_file').tools).toEqual([]);
    expect(activeFilterCount({ ...on, text: 'x', statuses: ['ok'] })).toBe(3);
  });

  it('offers only values present in the data', () => {
    const facets = facetsOf(subjects);
    expect(facets.tools).toEqual(['list_files', 'read_file', 'run_command', 'write_file']);
    expect(facets.categories).toEqual([]);
    expect(facets.agents).toEqual(expect.arrayContaining(['researcher', 'builder', 'tester', 'system']));
  });
});
