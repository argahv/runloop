import { formatEvent, type ExecState } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent } from '@runloop-world/events';
import { eventProvenance } from './selection';
import type { RowStatus, TimelineRow } from './timeline';

export const STATUS_FILTERS = ['ok', 'error', 'running', 'inferred'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Search and filter for the timeline and logs. Facets OR within themselves and AND with each other. */
export interface TraceFilter {
  /** Free text; every whitespace-separated term must appear. */
  text: string;
  /** Agent ids ('system' for events with no agent). */
  agents: string[];
  tools: string[];
  /** Tool categories (traced runs only). */
  categories: string[];
  statuses: StatusFilter[];
  /** Event types. */
  types: string[];
}

export const EMPTY_FILTER: TraceFilter = { text: '', agents: [], tools: [], categories: [], statuses: [], types: [] };

/** What a timeline row or a log entry exposes to the filter. */
export interface FilterSubject {
  text: string;
  agentId: string;
  tool: string | null;
  category: string | null;
  statuses: readonly StatusFilter[];
  types: readonly string[];
}

export function matchesFilter(s: FilterSubject, f: TraceFilter): boolean {
  if (f.agents.length > 0 && !f.agents.includes(s.agentId)) return false;
  if (f.tools.length > 0 && (s.tool === null || !f.tools.includes(s.tool))) return false;
  if (f.categories.length > 0 && (s.category === null || !f.categories.includes(s.category))) return false;
  if (f.statuses.length > 0 && !f.statuses.some((x) => s.statuses.includes(x))) return false;
  if (f.types.length > 0 && !s.types.some((t) => f.types.includes(t))) return false;
  const terms = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 0) {
    const hay = s.text.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

/** Number of active facets (the text query counts as one). */
export function activeFilterCount(f: TraceFilter): number {
  return (
    (f.text.trim() ? 1 : 0) + f.agents.length + f.tools.length + f.categories.length + f.statuses.length + f.types.length
  );
}

// ── URL ───────────────────────────────────────────────────────────

const LIST_PARAMS = { agents: 'actor', tools: 'tool', categories: 'cat', statuses: 'status', types: 'type' } as const;
const TEXT_PARAM = 'q';
/** Query parameters the filter owns (the URL sync replaces exactly these). */
export const FILTER_PARAMS: readonly string[] = [TEXT_PARAM, ...Object.values(LIST_PARAMS)];

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export function parseFilter(params: URLSearchParams): TraceFilter {
  const statuses = uniq(params.getAll(LIST_PARAMS.statuses)).filter((s): s is StatusFilter =>
    (STATUS_FILTERS as readonly string[]).includes(s),
  );
  return {
    text: params.get(TEXT_PARAM) ?? '',
    agents: uniq(params.getAll(LIST_PARAMS.agents)),
    tools: uniq(params.getAll(LIST_PARAMS.tools)),
    categories: uniq(params.getAll(LIST_PARAMS.categories)),
    statuses,
    types: uniq(params.getAll(LIST_PARAMS.types)),
  };
}

/** Write the filter into `params` (repeated keys for lists); empty facets are removed. */
export function writeFilter(params: URLSearchParams, f: TraceFilter): void {
  for (const key of FILTER_PARAMS) params.delete(key);
  if (f.text.trim()) params.set(TEXT_PARAM, f.text);
  for (const [field, key] of Object.entries(LIST_PARAMS) as [keyof typeof LIST_PARAMS, string][]) {
    for (const v of f[field]) params.append(key, v);
  }
}

/** Add or remove one value of a list facet. */
export function toggleFacet<K extends keyof typeof LIST_PARAMS>(f: TraceFilter, key: K, value: TraceFilter[K][number]): TraceFilter {
  const list = f[key] as string[];
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return { ...f, [key]: next };
}

// ── Subjects ──────────────────────────────────────────────────────

const ROW_STATUS: Partial<Record<RowStatus, StatusFilter>> = { ok: 'ok', error: 'error', running: 'running' };

/** A timeline row as seen at the playhead (`status` from rowStatusAt). */
export function rowSubject(row: TimelineRow, status: RowStatus, agentName: string): FilterSubject {
  const statuses: StatusFilter[] = [];
  const s = ROW_STATUS[status];
  if (s) statuses.push(s);
  if (row.inferred) statuses.push('inferred');
  return {
    text: [row.title, row.detail ?? '', agentName, row.actorId, row.tool ?? '', row.category ?? '', ...row.types, ...row.failingTests].join('\n'),
    agentId: row.actorId,
    tool: row.tool,
    category: row.category,
    statuses,
    types: row.types,
  };
}

export interface CallInfo {
  tool: string;
  category: string | null;
}

/** The searchable text of an event and its severity, which never change once recorded: computed once per event. */
const textOf = new WeakMap<AnyEvent, { text: string; severity: string }>();

function eventText(e: AnyEvent, exec: ExecState): { text: string; severity: string } {
  const cached = textOf.get(e);
  if (cached) return cached;
  const f = formatEvent(e, exec);
  let payloadText = '';
  try {
    payloadText = JSON.stringify(e.payload) ?? '';
  } catch {
    // unserialisable payloads only lose free-text matching
  }
  const out = {
    text: [e.type, f.label, f.detail ?? '', e.actorId ?? '', e.taskId ?? '', `#${e.sequence}`, payloadText, isUnknownEvent(e) ? e.reason : ''].join('\n'),
    severity: f.severity,
  };
  textOf.set(e, out);
  return out;
}

/** A log entry. `call` is the event's tool call (tool.* events); `running` = that call is open at the playhead. */
export function eventSubject(
  e: AnyEvent,
  ctx: { exec: ExecState; agentId: string | null; agentName: string; call: CallInfo | null; running: boolean },
): FilterSubject {
  const f = eventText(e, ctx.exec);
  const statuses: StatusFilter[] = [];
  if (e.type === 'tool.call_started' && ctx.running) statuses.push('running');
  else if (f.severity === 'error') statuses.push('error');
  else if (f.severity === 'ok') statuses.push('ok');
  if (eventProvenance(e) === 'inferred') statuses.push('inferred');
  return {
    text: `${f.text}\n${ctx.agentName}`,
    agentId: ctx.agentId ?? 'system',
    tool: ctx.call?.tool ?? null,
    category: ctx.call?.category ?? null,
    statuses,
    types: [e.type],
  };
}

export interface Facets {
  agents: string[];
  tools: string[];
  categories: string[];
  types: string[];
}

/** Values present in the data (so menus only offer choices that can match). */
export function facetsOf(subjects: readonly FilterSubject[]): Facets {
  const agents = new Set<string>();
  const tools = new Set<string>();
  const categories = new Set<string>();
  const types = new Set<string>();
  for (const s of subjects) {
    agents.add(s.agentId);
    if (s.tool) tools.add(s.tool);
    if (s.category) categories.add(s.category);
    for (const t of s.types) types.add(t);
  }
  return { agents: [...agents], tools: [...tools].sort(), categories: [...categories].sort(), types: [...types].sort() };
}
