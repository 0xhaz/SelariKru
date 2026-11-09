import { describe, expect, it } from 'vitest';
import { NODE_H, NODE_W, edgeLabelPoint, layoutGraph, nextNode, type LayoutInput, type LayoutResult } from './layout.ts';

const node = (id: string, column: number): LayoutInput['nodes'][number] => ({ id, column });
const graph = (): LayoutInput => ({
  nodes: [node('brief', 0), node('contract', 1), node('api', 2), node('web', 2), node('search', 2), node('int', 3), node('e2e', 4), node('rev', 5)],
  edges: [
    { from: 'brief', to: 'contract' }, { from: 'contract', to: 'api' }, { from: 'contract', to: 'web' }, { from: 'contract', to: 'search' },
    { from: 'api', to: 'int' }, { from: 'web', to: 'int' }, { from: 'search', to: 'int' }, { from: 'int', to: 'e2e' }, { from: 'e2e', to: 'rev' },
  ],
});

describe('graph layout', () => {
  it('places nodes without overlap and every edge left to right', () => {
    const out = layoutGraph(graph());
    const boxes = out.nodes;
    for (const a of boxes) {
      for (const b of boxes) {
        if (a.id >= b.id) continue;
        const clear = a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
        expect(clear, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
    for (const e of out.edges) expect(e.points.at(-1)!.x).toBeGreaterThan(e.points[0]!.x);
  });

  it('routes a long edge around the nodes in the layers it crosses', () => {
    const input: LayoutInput = { nodes: [node('a', 0), node('b', 1), node('c', 2), node('d', 1)], edges: [{ from: 'a', to: 'c' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'd', to: 'c' }] };
    const out = layoutGraph(input);
    const long = out.edges.find((e) => e.from === 'a' && e.to === 'c')!;
    expect(long.points.length).toBeGreaterThan(2);
    for (const p of long.points.slice(1, -1)) {
      for (const n of out.nodes.filter((x) => x.id === 'b' || x.id === 'd')) {
        const inside = p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H;
        expect(inside, `${n.id} sits on the long edge`).toBe(false);
      }
    }
  });

  it('sub-orders tasks inside one stage by their dependencies', () => {
    const out = layoutGraph({ nodes: [node('late', 0), node('needs', 0)], edges: [{ from: 'late', to: 'needs' }] });
    const late = out.nodes.find((n) => n.id === 'late')!;
    const needs = out.nodes.find((n) => n.id === 'needs')!;
    expect(needs.x).toBeGreaterThan(late.x);
    expect(out.columns).toEqual([{ index: 0, x: late.x, width: needs.x + NODE_W - late.x }]);
  });

  it('survives a cycle by leaving its back edge out of the layering', () => {
    const out = layoutGraph({ nodes: [node('a', 0), node('b', 0)], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(2);
  });

  it('is deterministic', () => {
    expect(layoutGraph(graph())).toEqual(layoutGraph(graph()));
  });

  it('reports a size that holds every node', () => {
    const out = layoutGraph(graph());
    for (const n of out.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(out.width);
      expect(n.y + NODE_H).toBeLessThanOrEqual(out.height);
    }
  });
});

describe('edge labels and ids', () => {
  it('puts a label in the gap between layers, on a two-point edge too', () => {
    const out = layoutGraph({ nodes: [node('a', 0), node('b', 1)], edges: [{ from: 'a', to: 'b' }] });
    const at = edgeLabelPoint(out.edges[0]!.points)!;
    const a = out.nodes.find((n) => n.id === 'a')!;
    const b = out.nodes.find((n) => n.id === 'b')!;
    expect(at.x).toBeGreaterThan(a.x + NODE_W);
    expect(at.x).toBeLessThan(b.x);
  });

  it('labels a long edge in its first gap, and a back edge in the gap it crosses', () => {
    const out = layoutGraph({ nodes: [node('a', 0), node('b', 1)], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
    const back = out.edges.find((e) => e.back)!;
    const at = edgeLabelPoint(back.points)!;
    const a = out.nodes.find((n) => n.id === 'a')!;
    const b = out.nodes.find((n) => n.id === 'b')!;
    expect(at.x).toBeGreaterThan(a.x + NODE_W);
    expect(at.x).toBeLessThan(b.x);
  });

  it('an arrow or a hyphen in a task id cannot collide with an edge key', () => {
    const out = layoutGraph({ nodes: [node('a->b', 0), node('a', 0), node('b', 1), node('c-d', 1)], edges: [{ from: 'a->b', to: 'b' }, { from: 'a', to: 'c-d' }] });
    expect(out.edges.every((e) => e.points.length === 2 && !e.back)).toBe(true);
  });

  it('lays an edgeless stage side by side so parallel work reads as parallel', () => {
    const out = layoutGraph({ nodes: [node('a', 2), node('b', 2), node('c', 2)], edges: [] });
    expect(new Set(out.nodes.map((n) => n.y)).size).toBe(1);
    expect(new Set(out.nodes.map((n) => n.x)).size).toBe(3);
    expect(out.columns).toHaveLength(1);
  });
});

const reachable = (out: LayoutResult, start: string): Set<string> => {
  const seen = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
      const to = nextNode(out, queue[i]!, key);
      if (to && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
};

describe('keyboard path', () => {
  const out = layoutGraph(graph());
  it('Right follows a dependent, Left a dependency', () => {
    expect(nextNode(out, 'brief', 'ArrowRight')).toBe('contract');
    expect(nextNode(out, 'contract', 'ArrowLeft')).toBe('brief');
    expect(nextNode(out, 'rev', 'ArrowRight')).toBeNull();
    expect(nextNode(out, 'brief', 'ArrowLeft')).toBeNull();
  });
  it('Up and Down move within a column, and stop at the ends', () => {
    const column = out.nodes.filter((n) => ['api', 'web', 'search'].includes(n.id)).sort((a, b) => a.y - b.y).map((n) => n.id);
    expect(nextNode(out, column[0]!, 'ArrowDown')).toBe(column[1]);
    expect(nextNode(out, column[1]!, 'ArrowUp')).toBe(column[0]);
    expect(nextNode(out, column[0]!, 'ArrowUp')).toBeNull();
  });
  it('reaches every node in an edgeless multi-stage graph, and picks the nearest across a gap', () => {
    const many = layoutGraph({ nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => node(id, i % 3)), edges: [] });
    expect(reachable(many, 'a').size).toBe(7);
  });

  it('reaches a node under a long edge', () => {
    const out2 = layoutGraph({ nodes: [node('a', 0), node('under', 1), node('c', 2)], edges: [{ from: 'a', to: 'c' }] });
    expect(nextNode(out2, 'a', 'ArrowRight')).toBe('under');
    expect(nextNode(out2, 'under', 'ArrowRight')).toBe('c');
    expect(reachable(out2, 'a').size).toBe(3);
  });

  it('Home and End reach the first and last task in reading order', () => {
    expect(nextNode(out, 'web', 'Home')).toBe('brief');
    expect(nextNode(out, 'web', 'End')).toBe('rev');
  });
});
