/**
 * A small layered graph layout: columns from the stages, order from a barycentre sweep, and dummy points so a long edge passes between the nodes it
 * crosses instead of through them. No graph library, because the plans this draws are small and the layout has to stay deterministic and testable.
 */
export const NODE_W = 168;
export const NODE_H = 136;
const LAYER_GAP = 44;
const ROW_GAP = 16;
const DUMMY_H = 12;
const PORT_GAP = 12;
const SWEEPS = 4;

export interface LayoutInput {
  readonly nodes: readonly { readonly id: string; readonly column: number }[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

export interface LayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  readonly column: number;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
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

/** Edge directions that close a cycle, found by depth-first search from each node in input order. */
function backEdges(input: LayoutInput): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of input.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const color = new Map<string, number>();
  const backs = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (color.get(to) === 1) backs.add(`${id}->${to}`);
      else if (!color.has(to)) visit(to);
    }
    color.set(id, 2);
  };
  for (const n of input.nodes) if (!color.has(n.id)) visit(n.id);
  return backs;
}

interface Slot {
  readonly id: string;
  readonly dummy: boolean;
}

export function layoutGraph(input: LayoutInput): LayoutResult {
  const backs = backEdges(input);
  const isBack = (e: { from: string; to: string }): boolean => backs.has(`${e.from}->${e.to}`);
  const columnOf = new Map(input.nodes.map((n) => [n.id, n.column]));
  const forward = input.edges.filter((e) => !isBack(e) && columnOf.has(e.from) && columnOf.has(e.to));

  const sub = new Map(input.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass <= input.nodes.length; pass += 1) {
    for (const e of forward) {
      if (columnOf.get(e.from) === columnOf.get(e.to)) sub.set(e.to, Math.max(sub.get(e.to)!, sub.get(e.from)! + 1));
    }
  }

  const presentColumns = [...new Set(input.nodes.map((n) => n.column))].sort((a, b) => a - b);
  const spans = presentColumns.map((c) => ({ column: c, layers: Math.max(...input.nodes.filter((n) => n.column === c).map((n) => sub.get(n.id)!)) + 1 }));
  let cursor = 0;
  const baseOf = new Map<number, number>();
  for (const s of spans) {
    baseOf.set(s.column, cursor);
    cursor += s.layers;
  }
  const layerOf = new Map(input.nodes.map((n) => [n.id, baseOf.get(n.column)! + sub.get(n.id)!]));
  const layerCount = Math.max(1, cursor);
  const layers: Slot[][] = Array.from({ length: layerCount }, () => []);
  for (const n of input.nodes) layers[layerOf.get(n.id)!]!.push({ id: n.id, dummy: false });

  const dummyId = (e: { from: string; to: string }, layer: number): string => `${e.from}->${e.to}@${layer}`;
  for (const e of forward) {
    const a = layerOf.get(e.from)!;
    const b = layerOf.get(e.to)!;
    for (let l = a + 1; l < b; l += 1) layers[l]!.push({ id: dummyId(e, l), dummy: true });
  }

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const connect = (a: string, b: string): void => {
    succs.set(a, [...(succs.get(a) ?? []), b]);
    preds.set(b, [...(preds.get(b) ?? []), a]);
  };
  for (const e of forward) {
    const a = layerOf.get(e.from)!;
    const b = layerOf.get(e.to)!;
    let prev = e.from;
    for (let l = a + 1; l < b; l += 1) {
      connect(prev, dummyId(e, l));
      prev = dummyId(e, l);
    }
    connect(prev, e.to);
  }

  const order = (from: readonly Slot[], neighbors: Map<string, string[]>, target: Slot[]): void => {
    const position = new Map(from.map((s, i) => [s.id, i]));
    const score = (s: Slot, i: number): number => {
      const ns = (neighbors.get(s.id) ?? []).map((n) => position.get(n)).filter((p): p is number => p !== undefined);
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

  const point = new Map<string, { x: number; y: number }>();
  const nodes: LayoutNode[] = [];
  layers.forEach((layer, l) => {
    let y = (height - layerHeight(layer)) / 2;
    for (const s of layer) {
      point.set(s.id, { x: xOf(l), y });
      if (!s.dummy) nodes.push({ id: s.id, x: xOf(l), y, layer: l, column: columnOf.get(s.id)! });
      y += slotHeight(s) + ROW_GAP;
    }
  });

  // Ports spread along a node's side, ordered by where the far end sits, so edges meeting one node do not cross at the node.
  const portFor = (ids: readonly string[], self: string, far: (e: string) => number): Map<string, number> => {
    const sorted = [...ids].sort((a, b) => far(a) - far(b) || a.localeCompare(b));
    const mid = (sorted.length - 1) / 2;
    const span = Math.min(PORT_GAP, (NODE_H - 24) / Math.max(1, sorted.length - 1));
    return new Map(sorted.map((id, i) => [id, point.get(self)!.y + NODE_H / 2 + (i - mid) * span]));
  };
  const key = (e: { from: string; to: string }): string => `${e.from}->${e.to}`;
  const fromPorts = new Map<string, number>();
  const toPorts = new Map<string, number>();
  for (const n of input.nodes) {
    const outs = input.edges.filter((e) => e.from === n.id && !isBack(e)).map(key);
    const ins = input.edges.filter((e) => e.to === n.id && !isBack(e)).map(key);
    for (const [k, y] of portFor(outs, n.id, (k) => point.get(k.split('->')[1]!)?.y ?? 0)) fromPorts.set(k, y);
    for (const [k, y] of portFor(ins, n.id, (k) => point.get(k.split('->')[0]!)?.y ?? 0)) toPorts.set(k, y);
  }

  const edges: LayoutEdge[] = input.edges.map((e) => {
    const k = key(e);
    const a = point.get(e.from);
    const b = point.get(e.to);
    if (!a || !b) return { from: e.from, to: e.to, points: [], back: isBack(e) };
    if (isBack(e)) return { from: e.from, to: e.to, points: [{ x: a.x, y: a.y + NODE_H / 2 }, { x: b.x + NODE_W, y: b.y + NODE_H / 2 }], back: true };
    const start = { x: a.x + NODE_W, y: fromPorts.get(k)! };
    const end = { x: b.x, y: toPorts.get(k)! };
    const via: { x: number; y: number }[] = [];
    for (let l = layerOf.get(e.from)! + 1; l < layerOf.get(e.to)!; l += 1) {
      const d = point.get(dummyId(e, l))!;
      via.push({ x: d.x, y: d.y + DUMMY_H / 2 }, { x: d.x + NODE_W, y: d.y + DUMMY_H / 2 });
    }
    return { from: e.from, to: e.to, points: [start, ...via, end], back: false };
  });

  const width = xOf(layerCount - 1) + NODE_W;
  const columns: LayoutColumn[] = spans.map((s) => {
    const base = baseOf.get(s.column)!;
    return { index: s.column, x: xOf(base), width: xOf(base + s.layers - 1) + NODE_W - xOf(base) };
  });
  return { nodes, edges, columns, width, height };
}

/**
 * Where an arrow key goes from a node. Right and left follow dependencies, up and down stay in the column; there is no wrap, so the focus has an end.
 * `Home` and `End` reach the first and last task in reading order. Null means stay put.
 */
export function nextNode(layout: LayoutResult, id: string, key: string): string | null {
  const here = layout.nodes.find((n) => n.id === id);
  if (!here) return null;
  const by = (ids: readonly string[]): readonly LayoutNode[] => layout.nodes.filter((n) => ids.includes(n.id)).sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  const ordered = [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  if (key === 'Home') return ordered[0]!.id;
  if (key === 'End') return ordered.at(-1)!.id;
  if (key === 'ArrowRight') return by(layout.edges.filter((e) => e.from === id && !e.back).map((e) => e.to))[0]?.id ?? null;
  if (key === 'ArrowLeft') return by(layout.edges.filter((e) => e.to === id && !e.back).map((e) => e.from))[0]?.id ?? null;
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
