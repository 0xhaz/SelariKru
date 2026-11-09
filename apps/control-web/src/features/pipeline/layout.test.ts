import { describe, expect, it } from 'vitest';
import { NODE_H, NODE_W, layoutGraph, nextNode, type LayoutInput } from './layout.ts';

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
  it('Home and End reach the first and last task in reading order', () => {
    expect(nextNode(out, 'web', 'Home')).toBe('brief');
    expect(nextNode(out, 'web', 'End')).toBe('rev');
  });
});
