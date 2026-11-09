/**
 * A small layered graph layout: columns from the stages, order from a barycentre sweep, and dummy points so a long edge passes between the nodes it
 * crosses instead of through them. No graph library, because the plans this draws are small and the layout has to stay deterministic and testable.
 */
export const NODE_W = 168;
export const NODE_H = 156;
const LAYER_GAP = 44;
const ROW_GAP = 16;
const DUMMY_H = 12;
const PORT_GAP = 12;
const SWEEPS = 4;
/** With no edges, a stage's tasks sit side by side so parallel work reads as parallel, in rows of at most this many. */
const EDGELESS_PER_ROW = 4;

export interface LayoutInput {
  readonly nodes: readonly { readonly id: string; readonly column: number }[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface LayoutNode extends LayoutPoint {
  readonly id: string;
  readonly layer: number;
  readonly column: number;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly points: readonly LayoutPoint[];
  /** True when this edge closes a cycle, so it is drawn but ignored for layering. */
  readonly back: boolean;
}

export interface LayoutColumn {
  readonly index: number;
  readonly x: number;
  readonly width: number;
}

export interface LayoutResult {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly columns: readonly LayoutColumn[];
  readonly width: number;
  readonly height: number;
}

interface IndexedEdge {
  readonly index: number;
  readonly a: number | undefined;
  readonly b: number | undefined;
}

/** Slots are integers: a node's index, then dummies counted on from there. Nothing in a task id can then collide with a dummy or an edge key. */
interface Slot {
  readonly key: number;
  readonly dummy: boolean;
}

/** The indices of edges that close a cycle, found by depth-first search from each node in input order. */
function backEdges(nodeCount: number, edges: readonly IndexedEdge[]): ReadonlySet<number> {
  const out = new Map<number, IndexedEdge[]>();
  for (const e of edges) {
    if (e.a !== undefined && e.b !== undefined) out.set(e.a, [...(out.get(e.a) ?? []), e]);
  }
  const color = new Map<number, 'on_stack' | 'done'>();
  const backs = new Set<number>();
  const visit = (n: number): void => {
    color.set(n, 'on_stack');
    for (const e of out.get(n) ?? []) {
      if (color.get(e.b!) === 'on_stack') backs.add(e.index);
      else if (!color.has(e.b!)) visit(e.b!);
    }
    color.set(n, 'done');
  };
  for (let n = 0; n < nodeCount; n += 1) if (!color.has(n)) visit(n);
  return backs;
}

export function layoutGraph(input: LayoutInput): LayoutResult {
  const indexOf = new Map(input.nodes.map((n, i) => [n.id, i]));
  const edges: IndexedEdge[] = input.edges.map((e, index) => ({ index, a: indexOf.get(e.from), b: indexOf.get(e.to) }));
  const backs = backEdges(input.nodes.length, edges);
  const forward = edges.filter((e) => e.a !== undefined && e.b !== undefined && !backs.has(e.index));
  const columnOf = input.nodes.map((n) => n.column);

  const sub = input.nodes.map(() => 0);
  if (input.edges.length === 0) {
    const inColumn = new Map<number, number>();
    input.nodes.forEach((n, i) => {
      const at = inColumn.get(n.column) ?? 0;
      sub[i] = at % EDGELESS_PER_ROW;
      inColumn.set(n.column, at + 1);
    });
  }
  for (let pass = 0; pass <= input.nodes.length; pass += 1) {
    for (const e of forward) {
      if (columnOf[e.a!] === columnOf[e.b!]) sub[e.b!] = Math.max(sub[e.b!]!, sub[e.a!]! + 1);
    }
  }

  const presentColumns = [...new Set(columnOf)].sort((a, b) => a - b);
  const spans = presentColumns.map((c) => ({ column: c, layers: Math.max(...input.nodes.map((_, i) => (columnOf[i] === c ? sub[i]! : 0))) + 1 }));
  let cursor = 0;
  const baseOf = new Map<number, number>();
  for (const s of spans) {
    baseOf.set(s.column, cursor);
    cursor += s.layers;
  }
  const layerOf = input.nodes.map((_, i) => baseOf.get(columnOf[i]!)! + sub[i]!);
  const layerCount = Math.max(1, cursor);
  const layers: Slot[][] = Array.from({ length: layerCount }, () => []);
  input.nodes.forEach((_, i) => layers[layerOf[i]!]!.push({ key: i, dummy: false }));

  let nextDummy = input.nodes.length;
  const dummiesOf = new Map<number, number[]>();
  for (const e of forward) {
    const route: number[] = [];
    for (let l = layerOf[e.a!]! + 1; l < layerOf[e.b!]!; l += 1) {
      const key = nextDummy;
      nextDummy += 1;
      layers[l]!.push({ key, dummy: true });
      route.push(key);
    }
    dummiesOf.set(e.index, route);
  }

  const preds = new Map<number, number[]>();
  const succs = new Map<number, number[]>();
  const connect = (a: number, b: number): void => {
    succs.set(a, [...(succs.get(a) ?? []), b]);
    preds.set(b, [...(preds.get(b) ?? []), a]);
  };
  for (const e of forward) {
    const chain = [e.a!, ...dummiesOf.get(e.index)!, e.b!];
    for (let i = 1; i < chain.length; i += 1) connect(chain[i - 1]!, chain[i]!);
  }

  const order = (from: readonly Slot[], neighbors: Map<number, number[]>, target: Slot[]): void => {
    const position = new Map(from.map((s, i) => [s.key, i]));
    const score = (s: Slot, i: number): number => {
      const ns = (neighbors.get(s.key) ?? []).map((n) => position.get(n)).filter((p): p is number => p !== undefined);
      return ns.length === 0 ? i : ns.reduce((a, b) => a + b, 0) / ns.length;
    };
    const scored = target.map((s, i) => ({ s, k: score(s, i), i })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.s);
    target.length = 0;
    target.push(...scored);
  };
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    for (let l = 1; l < layers.length; l += 1) order(layers[l - 1]!, preds, layers[l]!);
    for (let l = layers.length - 2; l >= 0; l -= 1) order(layers[l + 1]!, succs, layers[l]!);
  }

  const slotHeight = (s: Slot): number => (s.dummy ? DUMMY_H : NODE_H);
  const layerHeight = (l: readonly Slot[]): number => l.reduce((sum, s) => sum + slotHeight(s), 0) + Math.max(0, l.length - 1) * ROW_GAP;
  const height = Math.max(NODE_H, ...layers.map(layerHeight));
  const xOf = (l: number): number => l * (NODE_W + LAYER_GAP);

  const point = new Map<number, LayoutPoint>();
  const nodes: LayoutNode[] = [];
  layers.forEach((layer, l) => {
    let y = (height - layerHeight(layer)) / 2;
    for (const s of layer) {
      point.set(s.key, { x: xOf(l), y });
      if (!s.dummy) nodes.push({ id: input.nodes[s.key]!.id, x: xOf(l), y, layer: l, column: columnOf[s.key]! });
      y += slotHeight(s) + ROW_GAP;
    }
  });

  // Ports spread along a node's side, ordered by where the far end sits, so edges meeting one node do not cross at the node.
  const assignPorts = (ids: readonly IndexedEdge[], self: number, far: (e: IndexedEdge) => number, out: Map<number, number>): void => {
    const sorted = [...ids].sort((p, q) => far(p) - far(q) || p.index - q.index);
    const mid = (sorted.length - 1) / 2;
    const span = Math.min(PORT_GAP, (NODE_H - 24) / Math.max(1, sorted.length - 1));
    sorted.forEach((e, i) => out.set(e.index, point.get(self)!.y + NODE_H / 2 + (i - mid) * span));
  };
  const fromPorts = new Map<number, number>();
  const toPorts = new Map<number, number>();
  for (let n = 0; n < input.nodes.length; n += 1) {
    assignPorts(forward.filter((e) => e.a === n), n, (e) => point.get(e.b!)!.y, fromPorts);
    assignPorts(forward.filter((e) => e.b === n), n, (e) => point.get(e.a!)!.y, toPorts);
  }

  const outEdges: LayoutEdge[] = input.edges.map((raw, index) => {
    const e = edges[index]!;
    const back = backs.has(index);
    if (e.a === undefined || e.b === undefined) return { from: raw.from, to: raw.to, points: [], back };
    const a = point.get(e.a)!;
    const b = point.get(e.b)!;
    if (back) return { from: raw.from, to: raw.to, points: [{ x: a.x, y: a.y + NODE_H / 2 }, { x: b.x + NODE_W, y: b.y + NODE_H / 2 }], back };
    const via: LayoutPoint[] = (dummiesOf.get(index) ?? []).flatMap((key) => {
      const d = point.get(key)!;
      return [{ x: d.x, y: d.y + DUMMY_H / 2 }, { x: d.x + NODE_W, y: d.y + DUMMY_H / 2 }];
    });
    return { from: raw.from, to: raw.to, points: [{ x: a.x + NODE_W, y: fromPorts.get(index)! }, ...via, { x: b.x, y: toPorts.get(index)! }], back };
  });

  const width = xOf(layerCount - 1) + NODE_W;
  const columns: LayoutColumn[] = spans.map((s) => {
    const base = baseOf.get(s.column)!;
    return { index: s.column, x: xOf(base), width: xOf(base + s.layers - 1) + NODE_W - xOf(base) };
  });
  return { nodes, edges: outEdges, columns, width, height };
}

/** Where an edge's label goes: the gap after its first segment starts. Between layers there are no nodes to hide it. */
export function edgeLabelPoint(points: LayoutEdge['points']): LayoutPoint | null {
  if (points.length < 2) return null;
  const [p, q] = points as readonly [LayoutPoint, LayoutPoint];
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/**
 * Where an arrow key goes from a node. Right and left go to the next populated layer, by a dependency into that layer when one exists, otherwise to the
 * nearest node there, so every node can be reached even when no edge leads to it. Up and down stay in the layer; there is no wrap, so the focus has an
 * end. `Home` and `End` reach the first and last task in reading order. Null means stay put.
 */
export function nextNode(layout: LayoutResult, id: string, key: string): string | null {
  const here = layout.nodes.find((n) => n.id === id);
  if (!here) return null;
  const ordered = [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  if (key === 'Home') return ordered[0]!.id;
  if (key === 'End') return ordered.at(-1)!.id;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const forward = key === 'ArrowRight';
    const populated = [...new Set(layout.nodes.map((n) => n.layer))].sort((a, b) => a - b);
    const target = populated[populated.indexOf(here.layer) + (forward ? 1 : -1)];
    if (target === undefined) return null;
    const inLayer = layout.nodes.filter((n) => n.layer === target).sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    const linked = layout.edges.filter((e) => !e.back && (forward ? e.from === id : e.to === id)).map((e) => (forward ? e.to : e.from));
    const direct = inLayer.find((n) => linked.includes(n.id));
    if (direct) return direct.id;
    return [...inLayer].sort((a, b) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y))[0]!.id;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const column = layout.nodes.filter((n) => n.layer === here.layer).sort((a, b) => a.y - b.y);
    const at = column.findIndex((n) => n.id === id);
    return column[at + (key === 'ArrowDown' ? 1 : -1)]?.id ?? null;
  }
  return null;
}

/** The SVG path for an edge's points: a smooth step between each pair, straight runs across dummy layers. */
export function edgePath(points: LayoutEdge['points']): string {
  if (points.length < 2) return '';
  const first = points[0]!;
  let path = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const mx = (p.x + q.x) / 2;
    path += ` C ${mx} ${p.y}, ${mx} ${q.y}, ${q.x} ${q.y}`;
  }
  return path;
}
