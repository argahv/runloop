/**
 * Layered layout for the agent network (pure; px in content space).
 *
 * Delegation edges define layers: roots (agents nobody delegated to) on the
 * left, each delegate one column to the right of its delegator (longest path,
 * cycle-safe). Within a column, agents follow their delegators' order, then
 * registration order. A column taller than the space available wraps into
 * sub-columns. `layoutGraphDown` turns the same layout 90° (layers as rows)
 * for panels too narrow for columns: text is never scaled down to fit.
 */

export interface LayoutOptions {
  nodeW: number;
  nodeH: number;
  /** Space between layers. */
  gapX: number;
  /** Space between nodes in a column. */
  gapY: number;
  /** Height available for a column before it wraps. */
  maxColumnHeight: number;
  padding: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeW: 232, nodeH: 104, gapX: 104, gapY: 16, maxColumnHeight: 560, padding: 24 };

export interface GraphLayout {
  /** Centre of each node. */
  positions: Map<string, { x: number; y: number }>;
  /** Node ids per layer, in visual order (top to bottom, then sub-column by sub-column). */
  layers: string[][];
  width: number;
  height: number;
}

/** Layer of each node: 0 for roots, else one more than its deepest delegator. */
export function layerOf(ids: readonly string[], edges: readonly { from: string; to: string }[]): Map<string, number> {
  const depth = new Map(ids.map((id) => [id, 0]));
  const max = ids.length;
  // Bellman-Ford style relaxation; capping at N layers breaks cycles.
  for (let pass = 0; pass < max; pass++) {
    let changed = false;
    for (const e of edges) {
      const d = depth.get(e.from);
      const cur = depth.get(e.to);
      if (d === undefined || cur === undefined || e.from === e.to) continue;
      if (d + 1 > cur && d + 1 < max) {
        depth.set(e.to, d + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

export function layoutGraph(ids: readonly string[], edges: readonly { from: string; to: string }[], opts: LayoutOptions = DEFAULT_LAYOUT): GraphLayout {
  const { nodeW, nodeH, gapX, gapY, padding } = opts;
  const depth = layerOf(ids, edges);
  const regOrder = new Map(ids.map((id, i) => [id, i]));
  const count = Math.max(0, ...depth.values()) + 1;
  const layers: string[][] = Array.from({ length: ids.length ? count : 0 }, () => []);
  for (const id of ids) layers[depth.get(id)!]!.push(id);

  // Order each layer by the mean position of its delegators in earlier layers, then registration order.
  const rank = new Map<string, number>();
  layers.forEach((layer, li) => {
    const key = (id: string) => {
      const parents = edges.filter((e) => e.to === id && rank.has(e.from) && depth.get(e.from)! < li).map((e) => rank.get(e.from)!);
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : Infinity;
    };
    layer.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka === kb ? regOrder.get(a)! - regOrder.get(b)! : ka - kb;
    });
    layer.forEach((id, i) => rank.set(id, i));
  });

  const perColumn = Math.max(1, Math.floor((opts.maxColumnHeight + gapY) / (nodeH + gapY)));
  // Sub-columns of one layer are spaced like layers, so a label on an edge between them has room.
  const subGap = Math.max(gapY, gapX);
  const positions = new Map<string, { x: number; y: number }>();
  let x = padding;
  let height = 0;
  const columns: { ids: string[]; x: number }[] = [];
  for (const layer of layers) {
    const subs = Math.max(1, Math.ceil(layer.length / perColumn));
    const rows = Math.ceil(layer.length / subs);
    for (let s = 0; s < subs; s++) {
      columns.push({ ids: layer.slice(s * rows, (s + 1) * rows), x: x + s * (nodeW + subGap) + nodeW / 2 });
    }
    height = Math.max(height, rows * nodeH + (rows - 1) * gapY);
    x += subs * nodeW + (subs - 1) * subGap + gapX;
  }
  const width = layers.length ? x - gapX + padding : 2 * padding;
  const totalH = height + 2 * padding;
  for (const col of columns) {
    const h = col.ids.length * nodeH + (col.ids.length - 1) * gapY;
    const top = padding + (height - h) / 2;
    col.ids.forEach((id, i) => positions.set(id, { x: col.x, y: top + i * (nodeH + gapY) + nodeH / 2 }));
  }
  return { positions, layers, width, height: totalH };
}

/**
 * The layered layout with layers as rows, top to bottom (for narrow panels).
 * Same ordering and wrapping; `maxColumnHeight` is the width a row may take.
 */
export function layoutGraphDown(ids: readonly string[], edges: readonly { from: string; to: string }[], opts: LayoutOptions = DEFAULT_LAYOUT): GraphLayout {
  // Lay out with the node's sides swapped, then turn it: columns become rows.
  const t = layoutGraph(ids, edges, { ...opts, nodeW: opts.nodeH, nodeH: opts.nodeW });
  const positions = new Map([...t.positions].map(([id, p]) => [id, { x: p.y, y: p.x }]));
  return { positions, layers: t.layers, width: t.height, height: t.width };
}

type Pt = { x: number; y: number };

/**
 * horizontal: between columns, side to side. side: within a column, out of the
 * right edges and around. vertical: between rows, bottom to top. under: within
 * a row, out of the bottom edges and around.
 */
export type EdgeMode = 'horizontal' | 'side' | 'vertical' | 'under';

/** Where an edge leaves `a` and enters `b` (`nodeH` and `down` for the row layout). */
export function edgeAnchors(a: Pt, b: Pt, nodeW: number, nodeH = 0, down = false): { p0: Pt; p1: Pt; mode: EdgeMode } {
  if (down) {
    const dy = b.y - a.y;
    if (Math.abs(dy) >= nodeH * 0.75) {
      const s = Math.sign(dy);
      return { p0: { x: a.x, y: a.y + (s * nodeH) / 2 }, p1: { x: b.x, y: b.y - (s * nodeH) / 2 }, mode: 'vertical' };
    }
    return { p0: { x: a.x, y: a.y + nodeH / 2 }, p1: { x: b.x, y: b.y + nodeH / 2 }, mode: 'under' };
  }
  const dx = b.x - a.x;
  if (Math.abs(dx) >= nodeW * 0.75) {
    const s = Math.sign(dx);
    return { p0: { x: a.x + (s * nodeW) / 2, y: a.y }, p1: { x: b.x - (s * nodeW) / 2, y: b.y }, mode: 'horizontal' };
  }
  return { p0: { x: a.x + nodeW / 2, y: a.y }, p1: { x: b.x + nodeW / 2, y: b.y }, mode: 'side' };
}

/**
 * A smooth cubic path between two anchors and its midpoint. `bend` pushes a
 * horizontal edge sideways (message edges sit beside delegation edges) and
 * widens a side loop.
 */
export function edgePath(p0: Pt, p1: Pt, mode: EdgeMode, bend = 0): { d: string; mid: Pt } {
  let c0: Pt;
  let c1: Pt;
  if (mode === 'side') {
    const k = 36 + Math.abs(p1.y - p0.y) * 0.22 + bend;
    c0 = { x: p0.x + k, y: p0.y };
    c1 = { x: p1.x + k, y: p1.y };
  } else if (mode === 'under') {
    const k = 36 + Math.abs(p1.x - p0.x) * 0.22 + bend;
    c0 = { x: p0.x, y: p0.y + k };
    c1 = { x: p1.x, y: p1.y + k };
  } else if (mode === 'vertical') {
    const half = (p1.y - p0.y) / 2;
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const nx = -(p1.y - p0.y) / len;
    const ny = (p1.x - p0.x) / len;
    c0 = { x: p0.x + nx * bend, y: p0.y + half + ny * bend };
    c1 = { x: p1.x + nx * bend, y: p1.y - half + ny * bend };
  } else {
    const half = (p1.x - p0.x) / 2;
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    // Normal to the straight line, for the sideways bend.
    const nx = -(p1.y - p0.y) / len;
    const ny = (p1.x - p0.x) / len;
    c0 = { x: p0.x + half + nx * bend, y: p0.y + ny * bend };
    c1 = { x: p1.x - half + nx * bend, y: p1.y + ny * bend };
  }
  const mid = { x: (p0.x + 3 * c0.x + 3 * c1.x + p1.x) / 8, y: (p0.y + 3 * c0.y + 3 * c1.y + p1.y) / 8 };
  const f = (v: number) => v.toFixed(1);
  return { d: `M${f(p0.x)},${f(p0.y)} C${f(c0.x)},${f(c0.y)} ${f(c1.x)},${f(c1.y)} ${f(p1.x)},${f(p1.y)}`, mid };
}
