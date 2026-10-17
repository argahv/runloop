'use client';
import { useId, type ReactNode } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { activeFilterCount, EMPTY_FILTER, toggleFacet, type Facets, type StatusFilter, type TraceFilter } from '../state/filters';
import { Button } from '../ui/Button';
import { AgentDot } from '../ui/Chip';
import { Icon, type IconName } from '../ui/Icon';
import { Kbd } from '../ui/Kbd';
import { Popover } from '../ui/Popover';
import styles from './FilterBar.module.css';

const STATUS: { id: StatusFilter; label: string; icon: IconName }[] = [
  { id: 'ok', label: 'OK', icon: 'check' },
  { id: 'error', label: 'Error', icon: 'x' },
  { id: 'running', label: 'Running', icon: 'pulse' },
  { id: 'inferred', label: 'Inferred', icon: 'inferred' },
];

type ListKey = 'agents' | 'tools' | 'categories' | 'types';

export interface AgentOption {
  id: string;
  name: string;
  color: string;
}

/**
 * Search and facet filters for the timeline and logs. The filter lives in the
 * store (and the URL), so both lists and every page share it.
 */
export default function FilterBar({
  facets,
  agents,
  shown,
  total,
  noun,
  compact,
}: {
  facets: Facets;
  agents: readonly AgentOption[];
  shown: number;
  total: number;
  noun: string;
  compact?: boolean;
}) {
  const store = useStudioStore();
  const filter = useStudio((s) => s.filter);
  const set = (f: TraceFilter) => store.getState().setFilter(f);
  const id = useId();
  const active = activeFilterCount(filter);
  const nameOf = (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId;

  const facetMenu = (key: ListKey, label: string, values: readonly string[], render?: (v: string) => ReactNode) => {
    const selected = filter[key];
    if (values.length === 0 && selected.length === 0) return null;
    const all = [...new Set([...values, ...selected])];
    return (
      <Popover label={selected.length ? `${label} · ${selected.length}` : label} active={selected.length > 0}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{label}</legend>
          {all.map((v) => (
            <label key={v} className={styles.option}>
              <input type="checkbox" checked={selected.includes(v)} onChange={() => set(toggleFacet(filter, key, v))} />
              {render ? render(v) : <span className={styles.optionText}>{v}</span>}
            </label>
          ))}
        </fieldset>
      </Popover>
    );
  };

  const agentRender = (v: string) => {
    const a = agents.find((x) => x.id === v);
    return (
      <span className={styles.optionText}>
        <AgentDot color={a?.color ?? 'var(--rl-id-neutral)'} /> {a?.name ?? (v === 'system' ? 'System' : v)}
      </span>
    );
  };
  const monoRender = (v: string) => <code className={styles.optionText}>{v}</code>;

  const chips: { key: ListKey; value: string; label: string }[] = [
    ...filter.agents.map((v) => ({ key: 'agents' as const, value: v, label: `Agent: ${nameOf(v)}` })),
    ...filter.tools.map((v) => ({ key: 'tools' as const, value: v, label: `Tool: ${v}` })),
    ...filter.categories.map((v) => ({ key: 'categories' as const, value: v, label: `Category: ${v}` })),
    ...filter.types.map((v) => ({ key: 'types' as const, value: v, label: `Type: ${v}` })),
  ];

  return (
    <div className={styles.bar} data-compact={compact || undefined}>
      <div className={styles.row}>
        <div className={styles.search}>
          <Icon name="search" size={15} />
          <label htmlFor="trace-search" className="sr-only">
            Search {noun}
          </label>
          <input
            id="trace-search"
            type="search"
            className={styles.input}
            placeholder={`Search ${noun}…`}
            value={filter.text}
            onChange={(e) => set({ ...filter, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter.text) {
                e.preventDefault();
                set({ ...filter, text: '' });
              }
            }}
            aria-describedby={`${id}-count`}
            autoComplete="off"
            spellCheck={false}
          />
          {!filter.text && <Kbd keys={['/']} label="Press slash to search" />}
        </div>
        <div className={styles.statuses} role="group" aria-label="Status">
          {STATUS.map((st) => (
            <button
              key={st.id}
              type="button"
              className={styles.status}
              data-status={st.id}
              aria-pressed={filter.statuses.includes(st.id)}
              onClick={() => set(toggleFacet(filter, 'statuses', st.id))}
            >
              <Icon name={st.icon} size={12} />
              {st.label}
            </button>
          ))}
        </div>
        <div className={styles.facets}>
          {facetMenu('agents', 'Agent', facets.agents, agentRender)}
          {facetMenu('tools', 'Tool', facets.tools, monoRender)}
          {facetMenu('categories', 'Category', facets.categories)}
          {facetMenu('types', 'Event type', facets.types, monoRender)}
        </div>
        <span id={`${id}-count`} className={styles.count} aria-live="polite">
          {active > 0 ? `${shown} of ${total} ${noun}` : `${total} ${noun}`}
        </span>
        {active > 0 && chips.length === 0 && (
          <Button variant="ghost" size="sm" onClick={() => set(EMPTY_FILTER)}>
            Clear all
          </Button>
        )}
      </div>
      {chips.length > 0 && (
        <div className={styles.row}>
          <ul className={styles.chips} aria-label="Active filters">
            {chips.map((c) => (
              <li key={`${c.key}:${c.value}`}>
                <button type="button" className={styles.chip} onClick={() => set(toggleFacet(filter, c.key, c.value))} aria-label={`Remove filter ${c.label}`}>
                  {c.label}
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => set(EMPTY_FILTER)}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
