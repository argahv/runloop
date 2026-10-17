'use client';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { rankCommands, type Command } from '../state/commands';
import styles from './CommandPalette.module.css';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { Kbd } from './Kbd';
import { scrollWithin } from './scroll';

/**
 * ⌘K / Ctrl-K palette: a combobox over a grouped listbox. ↑/↓ move, Enter
 * runs, Escape closes. Disabled commands stay visible with their reason.
 */
export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: readonly Command[] }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => rankCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (list.current && el) scrollWithin(list.current, el);
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    onClose();
    c.run();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      setActive(0);
    } else if (e.key === 'End') {
      setActive(results.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    }
  };

  // Group headings in result order (ranking may interleave groups when searching).
  let lastGroup = '';
  return (
    <Dialog open={open} onClose={onClose} labelledBy={`${id}-label`} initialFocus={input} placement="top" className={styles.panel}>
      <div className={styles.search}>
        <Icon name="search" size={18} />
        <label id={`${id}-label`} htmlFor={`${id}-input`} className="sr-only">
          Search commands, runs and pages
        </label>
        <input
          ref={input}
          id={`${id}-input`}
          className={styles.input}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={results[active] ? `${id}-opt-${results[active].id}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder="Jump to a run, page or command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <Kbd keys={['Esc']} label="Escape closes" />
      </div>
      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Commands" className={styles.list}>
        {results.length === 0 && <p className={styles.empty}>No command matches “{query}”.</p>}
        {results.map((c, i) => {
          const heading = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <div key={c.id}>
              {heading && (
                <div className={styles.group} aria-hidden="true">
                  {heading}
                </div>
              )}
              <div
                id={`${id}-opt-${c.id}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={c.disabled || undefined}
                data-active={i === active || undefined}
                className={styles.option}
                onMouseMove={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className={styles.label}>{c.label}</span>
                {c.hint && <span className={styles.hint}>{c.hint}</span>}
                {c.shortcut && <Kbd keys={c.shortcut} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.footer} aria-hidden="true">
        <span>
          <Kbd keys={['↑', '↓']} /> move
        </span>
        <span>
          <Kbd keys={['↵']} /> run
        </span>
        <span>
          <Kbd keys={['Esc']} /> close
        </span>
      </div>
    </Dialog>
  );
}
