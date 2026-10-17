'use client';
import type { ExecState } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';
import { useMemo } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { activeFilterCount, eventSubject, facetsOf, matchesFilter, rowSubject, type CallInfo, type Facets, type FilterSubject } from '../state/filters';
import { agentOfEvent, categoryOfStart } from '../state/selection';
import { buildTimelineRows, rowStatusAt, type TimelineRow } from '../state/timeline';
import { agentLook } from '../state/view';
import type { AgentOption } from './FilterBar';

export interface TraceModel {
  events: readonly AnyEvent[];
  /** Latest execution state (ids, names, calls, artifacts). */
  exec: ExecState;
  rows: TimelineRow[];
  agents: AgentOption[];
  /** Rows that pass the filter, with their index into `rows`. */
  visibleRows: TimelineRow[];
  visibleEvents: AnyEvent[];
  rowFacets: Facets;
  eventFacets: Facets;
  agentOf: (e: AnyEvent) => string | null;
}

/**
 * Timeline rows, log events and their filter subjects for the open run. The
 * expensive parts (rows, subjects with each payload's text) are built once per
 * new event, not per playhead move; only a status filter reads the playhead.
 */
export function useTraceModel(): TraceModel {
  const store = useStudioStore();
  const lastSequence = useStudio((s) => s.lastSequence);
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const filter = useStudio((s) => s.filter);
  const world = useStudio((s) => s.world);

  const events = useMemo(() => [...store.getState().events()], [store, lastSequence]);
  const exec = useMemo(() => store.getState().stateAt(lastSequence).exec, [store, lastSequence]);
  const rows = useMemo(() => buildTimelineRows(events, store.getState().timeOfSeq, exec), [store, events, exec]);

  const agents = useMemo<AgentOption[]>(() => {
    const ids = [...exec.agentOrder];
    if (events.some((e) => !e.actorId || e.actorId === 'system')) ids.push('system');
    return ids.map((id) => {
      const look = agentLook(exec, world, id);
      return { id, name: look.name, color: look.color };
    });
  }, [exec, world, events]);

  // Filter subjects that do not depend on the playhead (text, agent, tool, ...): built once per new event.
  const subjects = useMemo(() => {
    const nameOf = (id: string | null) => (id ? agentLook(exec, world, id).name : 'System');
    const agentOf = (e: AnyEvent) => agentOfEvent(e, exec);
    const calls = new Map<string, CallInfo>();
    for (const e of events) {
      if (e.type === 'tool.call_started') {
        const p = e.payload as { callId: string; tool: string };
        calls.set(p.callId, { tool: p.tool, category: categoryOfStart(e) });
      }
    }
    const rowSubjects = rows.map((r) => rowSubject(r, 'info', nameOf(r.actorId)));
    const eventSubjects = events.map((e) => {
      const agentId = agentOf(e);
      const callId = (e.payload as { callId?: unknown } | null)?.callId;
      const call = typeof callId === 'string' && e.type.startsWith('tool.') ? (calls.get(callId) ?? null) : null;
      return eventSubject(e, { exec, agentId, agentName: nameOf(agentId), call, running: false });
    });
    return { agentOf, rowSubjects, eventSubjects, rowFacets: facetsOf(rowSubjects), eventFacets: facetsOf(eventSubjects) };
  }, [events, rows, exec, world]);

  // Only a status filter depends on the playhead (a call is running, or not yet finished, at the playhead).
  const statusSeq = filter.statuses.length > 0 ? playheadSeq : null;
  const visible = useMemo(() => {
    if (activeFilterCount(filter) === 0) return { visibleRows: rows, visibleEvents: [...events] };
    const rowAt = (r: TimelineRow, i: number): FilterSubject => {
      const base = subjects.rowSubjects[i]!;
      if (statusSeq === null) return base;
      return { ...base, statuses: rowSubject(r, rowStatusAt(r, statusSeq), '').statuses };
    };
    const eventAt = (e: AnyEvent, i: number): FilterSubject => {
      const base = subjects.eventSubjects[i]!;
      if (statusSeq === null || e.type !== 'tool.call_started') return base;
      const c = exec.toolCalls.get((e.payload as { callId: string }).callId);
      const running = c !== undefined && c.startedSeq <= statusSeq && (c.endedSeq === null || c.endedSeq > statusSeq);
      return running ? { ...base, statuses: ['running', ...base.statuses] } : base;
    };
    return {
      visibleRows: rows.filter((r, i) => matchesFilter(rowAt(r, i), filter)),
      visibleEvents: events.filter((e, i) => matchesFilter(eventAt(e, i), filter)),
    };
  }, [subjects, rows, events, exec, filter, statusSeq]);

  const model = { agentOf: subjects.agentOf, rowFacets: subjects.rowFacets, eventFacets: subjects.eventFacets, ...visible };

  return { events, exec, rows, agents, ...model };
}
