'use client';
import { formatEntityRef, type EntityRef } from '@runloop-world/events';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useWorld, useWorldStore } from '../../world/context';
import { tickNow } from '../../world/interpolate';
import { directoryTree, type DirectoryNode } from '../../world/entityIndex';
import { focusOf } from '../../world/store';
import { Icon, type IconName } from '../../ui/Icon';
import styles from './EntityDirectory.module.css';

const KIND_ICON: Record<string, IconName> = { district: 'layers', building: 'world', spot: 'map', resident: 'dot', agent: 'agent' };

interface Row {
  node: DirectoryNode;
  depth: number;
  parent: string | null;
  expandable: boolean;
}

/**
 * The town as an accessible tree (plan §5): District › Building or place ›
 * occupants, agents in their buildings, walkers under "On the move". Arrow
 * keys move, → opens, ← closes or goes to the parent, Enter chooses: the same
 * as clicking the entity in 3D. One Tab stop (roving tabindex).
 */
export default function EntityDirectory({ embedded }: { /** Inside a sheet that shows the title already. */ embedded?: boolean } = {}) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  const rev = useWorld((s) => s.rev);
  const focus = useWorld((s) => focusOf(s));
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  // Rebuilt when the world changes (rev); walkers are placed by the cell they are on now.
  const tree = useMemo(
    () => (snapshot && town && rev >= 0 ? directoryTree(snapshot, town, Math.floor(tickNow(store.getState().clock, Date.now()))) : []),
    [store, snapshot, town, rev],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = filter.trim().toLowerCase();
    const matches = (n: DirectoryNode): boolean => n.name.toLowerCase().includes(q) || n.children.some(matches);
    const walk = (n: DirectoryNode, depth: number, parent: string | null) => {
      if (q && !matches(n)) return;
      out.push({ node: n, depth, parent, expandable: n.children.length > 0 });
      if (n.children.length && (open.has(n.key) || q)) for (const c of n.children) walk(c, depth + 1, n.key);
    };
    for (const n of tree) walk(n, 0, null);
    return out;
  }, [tree, open, filter]);

  const choose = (ref: EntityRef | null) => {
    if (!ref) return;
    store.getState().focusEntity(ref, { expand: true });
    if (ref.kind === 'resident' || ref.kind === 'agent') store.getState().setFollow(ref);
  };
  const toggle = (key: string, to?: boolean) =>
    setOpen((s) => {
      const next = new Set(s);
      if (to ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });
  const move = (key: string | null) => {
    if (!key) return;
    setActive(key);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  };

  const activeKey = active && rows.some((r) => r.node.key === active) ? active : (rows[0]?.node.key ?? null);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const i = rows.findIndex((r) => r.node.key === activeKey);
    const row = rows[i];
    if (!row) return;
    const handled = () => e.preventDefault();
    switch (e.key) {
      case 'ArrowDown':
        handled();
        move(rows[Math.min(rows.length - 1, i + 1)]?.node.key ?? null);
        break;
      case 'ArrowUp':
        handled();
        move(rows[Math.max(0, i - 1)]?.node.key ?? null);
        break;
      case 'Home':
        handled();
        move(rows[0]?.node.key ?? null);
        break;
      case 'End':
        handled();
        move(rows[rows.length - 1]?.node.key ?? null);
        break;
      case 'ArrowRight':
        handled();
        if (row.expandable && !open.has(row.node.key)) toggle(row.node.key, true);
        else if (row.expandable) move(rows[i + 1]?.node.key ?? null);
        break;
      case 'ArrowLeft':
        handled();
        if (row.expandable && open.has(row.node.key)) toggle(row.node.key, false);
        else move(row.parent);
        break;
      case 'Enter':
      case ' ':
        handled();
        if (row.node.ref) choose(row.node.ref);
        else toggle(row.node.key);
        break;
    }
  };

  const focusKey = focus ? formatEntityRef(focus) : null;
  return (
    <div className={styles.dir}>
      <div className={styles.head}>
        <h2 className={embedded ? 'sr-only' : styles.title} id="directory-title">
          Directory
        </h2>
        <input className={styles.filter} placeholder="Filter by name" aria-label="Filter the directory" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>{snapshot ? 'Nothing matches.' : 'Loading the town…'}</p>
      ) : (
        <ul ref={listRef} role="tree" aria-labelledby="directory-title" className={styles.tree} onKeyDown={onKey}>
          {rows.map((r) => {
            const k = r.node.ref ? formatEntityRef(r.node.ref) : null;
            const expanded = r.expandable ? open.has(r.node.key) || filter.trim() !== '' : undefined;
            return (
              <li
                key={r.node.key}
                data-key={r.node.key}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-expanded={expanded}
                aria-selected={k !== null && k === focusKey}
                tabIndex={r.node.key === activeKey ? 0 : -1}
                className={styles.item}
                style={{ paddingLeft: 8 + r.depth * 16 }}
                onFocus={() => setActive(r.node.key)}
                onClick={() => {
                  setActive(r.node.key);
                  if (r.node.ref) choose(r.node.ref);
                  if (r.expandable) toggle(r.node.key);
                }}
              >
                <span className={styles.caret} aria-hidden="true">
                  {r.expandable && <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />}
                </span>
                <Icon name={KIND_ICON[r.node.ref?.kind ?? 'district'] ?? 'dot'} size={13} className={styles.kind} />
                <span className={styles.name}>{r.node.name}</span>
                <span className={styles.detail}>{r.node.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
