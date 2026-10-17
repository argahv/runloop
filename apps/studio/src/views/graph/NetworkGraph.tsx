'use client';
import { formatClock } from '@runloop-world/core';
import type { RunState } from '@runloop-world/replay';
import type { CompiledWorld } from '@runloop-world/world-engine';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import CharacterStatus from '../../components/CharacterStatus';
import { useStudio, useStudioStore } from '../../state/context';
import { identityColor } from '../../state/identity';
import { KIND_LABEL, runHasEnded } from '../../state/view';
import { AgentDot, StatusBadge } from '../../ui/Chip';
import { Icon } from '../../ui/Icon';
import { EmptyState } from '../../ui/States';
import { DEFAULT_LAYOUT, edgeAnchors, edgePath, layerOf, layoutGraph, layoutGraphDown, type GraphLayout } from './layout';
import { buildAgentGraph, runtimeStatusView, type DelegationEdge, type GraphNode, type MessageEdge } from './model';
import styles from './graph.module.css';

/** Narrower cards for panels too narrow for the full ones (text keeps its size; long lines ellipsize). */
const NARROW = [
  { nodeW: 184, gapX: 76 },
  { nodeW: 144, gapX: 76, padding: 16 },
] as const;
/** Wide fan-outs (more agents in one column than this) use compact cards: name, role and state only. */
const COMPACT_OVER = 5;
const COMPACT = { nodeH: 58, gapY: 10 } as const;
/** A delegator with more delegates than this gets one summary label instead of one per edge. */
const FANOUT_LABELS = 3;
/** Room on the right (or below, in rows) for message loops between agents in the same column (row). */
const SIDE_ROOM = 96;
/** Space between rows in the row layout (room for the edge labels). */
const ROW_GAP = 76;
/** Message edges bend away from delegation edges between the same agents. */
const MESSAGE_BEND = { horizontal: 26, side: 22, vertical: 46, under: 22 } as const;

function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function delegationLabel(e: DelegationEdge): string {
  if (e.tasks.length === 1) return KIND_LABEL[e.tasks[0]!.kind];
  const kinds = [...new Set(e.tasks.map((t) => KIND_LABEL[t.kind]))];
  return kinds.length === 1 ? `${e.tasks.length} × ${kinds[0]}` : `${e.tasks.length} tasks`;
}

/**
 * D6 "Network": the agents of the run as a 2D graph (SVG edges, DOM nodes;
 * no WebGL). Nodes carry the identity hue and the state as icon + text;
 * solid edges are delegated tasks, dashed edges messages (count, latest on
 * click). Selection is the shell's: clicking a node selects the agent
 * everywhere, and a selection made elsewhere highlights it here. Arrow keys
 * move between agents; Enter selects.
 */
export default function NetworkGraph() {
  const store = useStudioStore();
  const seq = useStudio((s) => s.playheadSeq);
  const lastSequence = useStudio((s) => s.lastSequence);
  const world = useStudio((s) => s.world);
  const selected = useStudio((s) => s.selectedAgentId);
  const selectedSeq = useStudio((s) => s.selectedSeq);
  const state = useMemo(() => store.getState().stateAt(seq), [store, seq, lastSequence]);
  const graph = useMemo(() => buildAgentGraph(state.exec), [state]);
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [focusId, setFocusId] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  const ids = useMemo(() => graph.nodes.map((n) => n.id), [graph]);
  // Text is never scaled down to fit. Candidates, in order of preference: columns of full cards, columns of
  // narrower cards, layers as rows. The first that fits is used, else the one that shows the most (it scrolls).
  // (Wide fan-outs use compact cards: name, role and state.)
  const layout = useMemo(() => {
    const opts = { ...DEFAULT_LAYOUT };
    const perLayer = new Map<number, number>();
    for (const d of layerOf(ids, graph.delegations).values()) perLayer.set(d, (perLayer.get(d) ?? 0) + 1);
    const compact = Math.max(0, ...perLayer.values()) > COMPACT_OVER;
    const base = compact ? { ...opts, ...COMPACT } : opts;
    const pairs = [...graph.delegations.map((e) => [e.from, e.to]), ...graph.messages.map((e) => [e.a, e.b])];
    const sideOf = (l: GraphLayout, down: boolean) => {
      const axis = down ? 'y' : 'x';
      return pairs.some(([a, b]) => l.positions.get(a!)?.[axis] === l.positions.get(b!)?.[axis]) ? SIDE_ROOM : 0;
    };
    const availH = Math.max(base.nodeH, size.h - 2 * opts.padding);
    const candidates = [
      { l: layoutGraph(ids, graph.delegations, { ...base, maxColumnHeight: availH }), nodeW: base.nodeW, down: false },
      ...NARROW.map((n) => ({ l: layoutGraph(ids, graph.delegations, { ...base, ...n, maxColumnHeight: availH }), nodeW: n.nodeW, down: false })),
      {
        l: layoutGraphDown(ids, graph.delegations, { ...base, gapX: ROW_GAP, gapY: 24, maxColumnHeight: Math.max(base.nodeW, size.w - 2 * opts.padding) }),
        nodeW: base.nodeW,
        down: true,
      },
    ].map((c) => {
      const side = sideOf(c.l, c.down);
      const w = c.l.width + (c.down ? 0 : side);
      const h = c.l.height + (c.down ? side : 0);
      const shown = (size.w > 0 ? Math.min(1, size.w / w) : 1) * (size.h > 0 ? Math.min(1, size.h / h) : 1);
      return { ...c, w, h, shown };
    });
    const best = candidates.find((c) => c.shown >= 1) ?? candidates.reduce((a, b) => (b.shown > a.shown + 0.01 ? b : a));
    return { ...best.l, contentW: best.w, contentH: best.h, nodeW: best.nodeW, nodeH: base.nodeH, compact, down: best.down };
  }, [ids, graph, size.w, size.h]);
  const NODE_H = layout.nodeH;
  const NODE_W = layout.nodeW;
  const anchors = (a: { x: number; y: number }, b: { x: number; y: number }) => edgeAnchors(a, b, NODE_W, NODE_H, layout.down);
  const fanout = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of graph.delegations) out.set(e.from, (out.get(e.from) ?? 0) + 1);
    return out;
  }, [graph.delegations]);
  const contentW = layout.contentW;
  const contentH = layout.contentH;
  const scrolls = contentW > size.w + 1 || contentH > size.h + 1;
  const left = Math.max(0, (size.w - contentW) / 2);
  const top = Math.max(0, (size.h - contentH) / 2);

  // A selection made elsewhere moves the keyboard position here too (without stealing focus).
  useEffect(() => {
    if (selected && ids.includes(selected)) setFocusId(selected);
  }, [selected, ids]);
  const current = focusId && ids.includes(focusId) ? focusId : (ids[0] ?? null);

  if (graph.nodes.length === 0) {
    // Same wrapper as the graph, so its size is observed from the start.
    return (
      <div ref={wrapRef} className={styles.wrap}>
        <div className={styles.empty}>
          <EmptyState compact icon="graph" title="No agents yet">
            <p>Agents appear here as soon as they register in the run, with the tasks and messages between them.</p>
          </EmptyState>
        </div>
      </div>
    );
  }

  const s = store.getState();
  const touches = (a: string, b: string) => selected === null || a === selected || b === selected;
  const pos = (id: string) => layout.positions.get(id)!;

  const move = (e: KeyboardEvent) => {
    if (!current) return;
    const li = layout.layers.findIndex((l) => l.includes(current));
    const layer = layout.layers[li] ?? [];
    const i = layer.indexOf(current);
    let next: string | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = layer[Math.min(layer.length - 1, i + 1)];
        break;
      case 'ArrowUp':
        next = layer[Math.max(0, i - 1)];
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const target = layout.layers[li + (e.key === 'ArrowRight' ? 1 : -1)];
        if (target?.length) {
          const y = pos(current).y;
          next = [...target].sort((a, b) => Math.abs(pos(a).y - y) - Math.abs(pos(b).y - y))[0];
        }
        break;
      }
      case 'Home':
        next = ids[0];
        break;
      case 'End':
        next = ids[ids.length - 1];
        break;
      default:
        return;
    }
    // Keep arrows from also stepping the playhead (global shortcuts skip handled events).
    e.preventDefault();
    if (next) {
      setFocusId(next);
      nodeRefs.current.get(next)?.focus();
    }
  };

  return (
    <div className={styles.frame}>
      <div ref={wrapRef} className={styles.wrap} data-scrolls={scrolls || undefined}>
        <div
          className={styles.content}
          data-layout={layout.down ? 'rows' : 'columns'}
          style={{ width: contentW, height: contentH, transform: `translate(${left}px, ${top}px)` }}
          role="group"
          aria-label={`Agent network: ${graph.nodes.length} agents, ${graph.delegations.length} delegations, ${graph.messages.length} message threads. Arrow keys move between agents.`}
          onKeyDown={move}
        >
          <svg className={styles.edges} width={contentW} height={contentH} aria-hidden="true">
            <defs>
              {(['base', 'active', 'failed', 'message'] as const).map((k) => (
                <marker key={k} id={`rl-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M1,1 L9,5 L1,9 z" className={styles[`arrow_${k}`]} />
                </marker>
              ))}
            </defs>
            {graph.delegations.map((e) => {
              const a = anchors(pos(e.from), pos(e.to));
              const p = edgePath(a.p0, a.p1, a.mode);
              const tone = e.failed ? 'failed' : e.active ? 'active' : 'base';
              return <path key={e.id} d={p.d} className={styles.delegation} data-tone={tone} data-dim={!touches(e.from, e.to) || undefined} markerEnd={`url(#rl-arrow-${tone})`} />;
            })}
            {graph.messages.map((e) => {
              const a = anchors(pos(e.a), pos(e.b));
              const p = edgePath(a.p0, a.p1, a.mode, MESSAGE_BEND[a.mode]);
              return (
                <path
                  // Keyed by count: a new message remounts the path and replays its pulse once.
                  key={`${e.id}:${e.count}`}
                  d={p.d}
                  className={styles.message}
                  data-dim={!touches(e.a, e.b) || undefined}
                  markerEnd={e.aToB > 0 ? 'url(#rl-arrow-message)' : undefined}
                  markerStart={e.bToA > 0 ? 'url(#rl-arrow-message)' : undefined}
                />
              );
            })}
          </svg>
  
          {[...fanout].map(([from, n]) =>
            n > FANOUT_LABELS ? (
              <span
                key={`fan:${from}`}
                className={styles.edgeLabel}
                data-dim={(selected !== null && selected !== from) || undefined}
                style={layout.down ? { left: pos(from).x, top: pos(from).y + NODE_H / 2 + 30 } : { left: pos(from).x + NODE_W / 2 + 46, top: pos(from).y }}
              >
                {n} delegated
              </span>
            ) : null,
          )}
          {graph.delegations.map((e) => {
            if ((fanout.get(e.from) ?? 0) > FANOUT_LABELS) return null;
            const a = anchors(pos(e.from), pos(e.to));
            const { mid } = edgePath(a.p0, a.p1, a.mode);
            const titles = e.tasks.map((t) => `${KIND_LABEL[t.kind]} · ${t.title} (${t.status.replace('_', ' ')})`).join('\n');
            return (
              <span
                key={e.id}
                className={styles.edgeLabel}
                data-tone={e.failed ? 'failed' : e.active ? 'active' : 'base'}
                data-dim={!touches(e.from, e.to) || undefined}
                style={{ left: mid.x, top: mid.y }}
                title={`Delegated by ${nameOf(graph.nodes, e.from)} to ${nameOf(graph.nodes, e.to)}:\n${titles}`}
              >
                {delegationLabel(e)}
              </span>
            );
          })}
          {graph.messages.map((e) => (
            <MessageChip
              key={e.id}
              edge={e}
              nodes={graph.nodes}
              pos={pos}
              anchors={anchors}
              dim={!touches(e.a, e.b)}
              selected={selectedSeq === e.latest.seq}
              timeOfSeq={s.timeOfSeq}
              onOpen={(seq) => s.selectEvent(seq)}
            />
          ))}
  
          {graph.nodes.map((n) => {
            const p = pos(n.id);
            return (
              <Node
                key={n.id}
                node={n}
                compact={layout.compact}
                height={NODE_H}
                x={p.x - NODE_W / 2}
                width={NODE_W}
                y={p.y - NODE_H / 2}
                color={identityColor(state.exec, n.id)}
                where={whereOf(n, state, world)}
                runEnded={runHasEnded(state.exec)}
                selected={selected === n.id}
                tabIndex={n.id === current ? 0 : -1}
                buttonRef={(el) => void (el ? nodeRefs.current.set(n.id, el) : nodeRefs.current.delete(n.id))}
                onFocus={() => setFocusId(n.id)}
                onSelect={() => s.selectAgent(selected === n.id ? null : n.id)}
                onIncident={() => n.latestIncidentSeq !== null && s.selectEvent(n.latestIncidentSeq)}
              />
            );
          })}
        </div>
      </div>
      <p className={styles.legend} aria-hidden="true">
        <span className={styles.legendLine} data-kind="delegation" />
        delegated task
        <span className={styles.legendLine} data-kind="message" />
        messages
        <span className={styles.legendLine} data-kind="active" />
        running now
      </p>
    </div>
  );
}

/** A message thread between two agents: the count, the latest message on hover, and a button that opens it. */
function MessageChip({
  edge: e,
  nodes,
  pos,
  anchors,
  dim,
  selected,
  timeOfSeq,
  onOpen,
}: {
  edge: MessageEdge;
  nodes: readonly GraphNode[];
  pos: (id: string) => { x: number; y: number };
  anchors: (a: { x: number; y: number }, b: { x: number; y: number }) => ReturnType<typeof edgeAnchors>;
  dim: boolean;
  selected: boolean;
  timeOfSeq: (seq: number) => number;
  onOpen: (seq: number) => void;
}) {
  const a = anchors(pos(e.a), pos(e.b));
  const { mid } = edgePath(a.p0, a.p1, a.mode, MESSAGE_BEND[a.mode]);
  const latest = `${nameOf(nodes, e.latest.from)} → ${nameOf(nodes, e.latest.to)} at ${formatClock(timeOfSeq(e.latest.seq))}`;
  const noun = e.count === 1 ? 'message' : 'messages';
  return (
    <button
      type="button"
      className={styles.messageChip}
      data-dim={dim || undefined}
      aria-pressed={selected}
      style={{ left: mid.x, top: mid.y }}
      title={`${e.count} ${noun} (${nameOf(nodes, e.a)} → ${nameOf(nodes, e.b)}: ${e.aToB}, back: ${e.bToA})\nLatest: ${latest}`}
      aria-label={`${e.count} ${noun} between ${nameOf(nodes, e.a)} and ${nameOf(nodes, e.b)}. Latest: ${latest}. Open it.`}
      onClick={() => onOpen(e.latest.seq)}
    >
      <Icon name="message" size={12} />
      {e.count}
    </button>
  );
}

const nameOf = (nodes: readonly GraphNode[], id: string) => nodes.find((n) => n.id === id)?.name ?? id;

/** Where the agent's robot is: the environment and station, home, or no robot at all. */
function whereOf(n: GraphNode, state: RunState, world: CompiledWorld | null): string {
  if (!n.embodied) return 'No robot in the world';
  const c = state.world.characters[n.id];
  const station = c?.stationId && world ? world.stationsById[c.stationId] : undefined;
  if (station) return `${world?.zonesById[station.zoneId]?.label ?? 'World'} · ${station.label}`;
  const hub = world?.def.zones.find((z) => z.kind === 'hub');
  return hub ? `${hub.label} · home` : 'Home';
}

function Node({
  node: n,
  compact,
  width,
  height,
  x,
  y,
  color,
  where,
  runEnded,
  selected,
  tabIndex,
  buttonRef,
  onFocus,
  onSelect,
  onIncident,
}: {
  node: GraphNode;
  /** Wide fan-outs: name, role and state only (the inspector has the rest). */
  compact: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  color: string;
  where: string;
  runEnded: boolean;
  selected: boolean;
  tabIndex: number;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onSelect: () => void;
  onIncident: () => void;
}) {
  const task = n.task ? `${KIND_LABEL[n.task.kind]} · ${n.task.title}` : null;
  const status = n.embodied ? null : runtimeStatusView(n.state, runEnded);
  const label = [
    `${n.name} (${n.role})`,
    status ? status.text : null,
    n.call ? `running ${n.call.tool}` : null,
    task ? `task: ${task}` : 'no current task',
    where,
    n.usage ? `${n.usage} reported` : null,
    n.openIncidents ? `${n.openIncidents} open ${n.openIncidents === 1 ? 'failure' : 'failures'}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.node}
        data-selected={selected || undefined}
        data-running={n.call ? true : undefined}
        data-compact={compact || undefined}
        aria-pressed={selected}
        aria-label={label}
        tabIndex={tabIndex}
        style={{ left: x, top: y, width, height, '--agent': color } as CSSProperties}
        onFocus={onFocus}
        onClick={onSelect}
      >
        <span className={styles.nodeHead}>
          <AgentDot color={color} size={9} />
          <span className={styles.nodeName}>{n.name}</span>
          <span className={styles.nodeRole}>{compact && n.usage ? n.usage : n.role}</span>
        </span>
        <span className={styles.nodeState}>
          {status ? <StatusBadge view={status} /> : <CharacterStatus agentId={n.id} />}
          {n.call && <span className={styles.nodeTool}>{n.call.tool}</span>}
        </span>
        {!compact && (
          <>
            <span className={styles.nodeTask} data-empty={task ? undefined : true}>
              {task ?? 'No current task'}
            </span>
            <span className={styles.nodeMeta}>
              <span className={styles.nodeWhere}>{where}</span>
              {n.usage && <span className={styles.nodeUsage}>{n.usage}</span>}
            </span>
          </>
        )}
      </button>
      {n.openIncidents > 0 && (
        <button
          type="button"
          className={styles.incident}
          style={{ left: x + width - 10, top: y - 9 }}
          title="Open the latest failure"
          aria-label={`${n.name}: ${n.openIncidents} open ${n.openIncidents === 1 ? 'failure' : 'failures'}. Open the latest`}
          onClick={onIncident}
        >
          <Icon name="alert" size={12} />
          {n.openIncidents}
        </button>
      )}
    </>
  );
}
