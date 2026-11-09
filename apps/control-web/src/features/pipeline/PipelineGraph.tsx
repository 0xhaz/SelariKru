import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { toneGlyph, type Tone } from '@selarikru/ui';
import { roleName } from '../team/TeamSignals.tsx';
import { NODE_H, NODE_W, edgePath, layoutGraph, nextNode } from './layout.ts';
import { STAGES, stageIndex, stageLabel, type EdgeState, type PipelineEdge, type PipelineRow } from './model.ts';

const HEADER_H = 32;
const TONE_TEXT: Readonly<Record<Tone, string>> = { neutral: 'text-muted', active: 'text-active', success: 'text-success', warning: 'text-warning', danger: 'text-danger' };
const TONE_RAIL: Readonly<Record<Tone, string>> = { neutral: 'border-l-line-strong', active: 'border-l-active', success: 'border-l-success', warning: 'border-l-warning', danger: 'border-l-danger' };
const EDGE_STYLE: Readonly<Record<EdgeState, { color: string; dash: string | undefined; marker: string }>> = {
  met: { color: 'var(--color-line-strong)', dash: undefined, marker: 'pl-arrow-met' },
  waiting: { color: 'var(--color-muted)', dash: '6 5', marker: 'pl-arrow-waiting' },
  stale: { color: 'var(--color-warning)', dash: '2 4', marker: 'pl-arrow-stale' },
  unknown: { color: 'var(--color-warning)', dash: '2 4', marker: 'pl-arrow-stale' },
  cycle: { color: 'var(--color-danger)', dash: undefined, marker: 'pl-arrow-cycle' },
};
const MARKERS: readonly { id: string; color: string }[] = [
  { id: 'pl-arrow-met', color: 'var(--color-line-strong)' }, { id: 'pl-arrow-waiting', color: 'var(--color-muted)' }, { id: 'pl-arrow-stale', color: 'var(--color-warning)' },
  { id: 'pl-arrow-cycle', color: 'var(--color-danger)' }, { id: 'pl-arrow-critical', color: 'var(--color-active)' },
];

const hasUnknownDeps = (row: PipelineRow): boolean => row.predecessors === null || row.predecessors.some((p) => p.edge === 'unknown');

/** What a sighted reader gets from position and edges, as text inside the node button, so the graph has a complete non-visual path. */
function nodeDescription(row: PipelineRow, highlighted: string | null): string {
  const needs = row.predecessors === null ? 'Dependencies not known yet.' : row.predecessors.length === 0 ? 'No dependencies.' : `Depends on ${row.predecessors.map((p) => `${p.title} (${p.status.toLowerCase()})`).join(', ')}.`;
  const feeds = row.dependents.length === 0 ? '' : ` Needed by ${row.dependents.map((d) => d.title).join(', ')}.`;
  return [`${stageLabel(row.stage)} stage.`, row.reason ?? '', needs + feeds, row.critical ? 'On the longest unfinished chain.' : '', highlighted ?? ''].filter(Boolean).join(' ');
}

function GraphNode({ row, layoutNode, selected, connected, tabbable, highlight, onOpen, onKey, setRef }: {
  row: PipelineRow; layoutNode: { x: number; y: number }; selected: boolean; connected: boolean; tabbable: boolean; highlight: string | null;
  onOpen: (id: string) => void; onKey: (e: KeyboardEvent<HTMLButtonElement>) => void; setRef: (el: HTMLButtonElement | null) => void;
}) {
  const border = selected ? 'border-active ring-2 ring-active' : row.inCycle ? 'border-danger' : highlight ? 'border-warning outline-2 outline-dashed outline-offset-2 outline-warning' : connected ? 'border-line-strong' : 'border-line';
  const checks = row.checkCount > 0 ? `${row.checkCount} ${row.checkCount === 1 ? 'check' : 'checks'}` : null;
  const footer = [checks, row.why.held ? `Held ${row.age}` : null].filter(Boolean).join(' · ') || 'No checks yet';
  const unknownDeps = hasUnknownDeps(row);
  return (
    <li className="absolute" style={{ left: layoutNode.x, top: layoutNode.y + HEADER_H, width: NODE_W, height: NODE_H }}>
      <button
        ref={setRef}
        type="button"
        data-testid="graph-node"
        data-task-id={row.taskId}
        data-open-task={row.taskId}
        data-selected={selected}
        data-eligible={highlight !== null}
        aria-haspopup="dialog"
        aria-current={selected ? 'true' : undefined}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onOpen(row.taskId)}
        onKeyDown={onKey}
        className={`flex h-full w-full flex-col justify-between overflow-hidden rounded-chip border border-l-4 bg-panel p-2 text-left hover:bg-panel-2 ${border} ${TONE_RAIL[row.state.tone]}`}
      >
        <span className="min-w-0">
          <span className="line-clamp-2 text-sm font-semibold leading-snug text-fg" title={row.title}>{row.title}</span>
          <span className="mt-0.5 block truncate text-sm text-muted">{roleName(row.role)} · rev {row.revision}</span>
        </span>
        <span className="min-w-0">
          <span className={`flex items-start gap-1.5 text-sm font-medium leading-snug ${TONE_TEXT[row.state.tone]}`}><span aria-hidden="true" className="mt-1 text-glyph">{toneGlyph(row.state.tone)}</span><span className="min-w-0 flex-1">{row.state.label}</span>{row.critical ? <span className="shrink-0 font-normal text-active">Chain</span> : null}</span>
          <span className={`block text-sm leading-snug text-muted ${unknownDeps ? '' : 'truncate'}`}>{highlight ? <span className="text-warning">Eligible once verified</span> : unknownDeps ? <span className="text-warning" data-testid="node-unknown-deps">Dependencies unknown</span> : footer}</span>
        </span>
        <span className="sr-only">{nodeDescription(row, highlight)}</span>
      </button>
    </li>
  );
}

export interface GraphProps {
  readonly rows: readonly PipelineRow[];
  readonly edges: readonly PipelineEdge[];
  readonly selectedId: string | null;
  readonly highlight: readonly string[];
  readonly onSelect: (id: string) => void;
  readonly onOpen: (id: string) => void;
}

export function PipelineGraph({ rows, edges, selectedId, highlight, onSelect, onOpen }: GraphProps) {
  const shown = useMemo(() => new Set(rows.map((r) => r.taskId)), [rows]);
  const visibleEdges = useMemo(() => edges.filter((e) => shown.has(e.from) && shown.has(e.to)), [edges, shown]);
  const layout = useMemo(() => layoutGraph({ nodes: rows.map((r) => ({ id: r.taskId, column: stageIndex(r.stage) })), edges: visibleEdges }), [rows, visibleEdges]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const byId = useMemo(() => new Map(rows.map((r) => [r.taskId, r])), [rows]);
  const connected = useMemo(() => (selectedId === null ? new Set<string>() : new Set(visibleEdges.flatMap((e) => (e.from === selectedId ? [e.to] : e.to === selectedId ? [e.from] : [])))), [visibleEdges, selectedId]);
  const tabbableId = selectedId !== null && shown.has(selectedId) ? selectedId : (layout.nodes[0]?.id ?? null);

  const onKey = (id: string) => (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const to = nextNode(layout, id, e.key);
    if (!to) return;
    onSelect(to);
    buttons.current.get(to)?.focus();
  };

  const scroller = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  // A horizontal scrollbar can be invisible, so a clipped stage has to say that more follows.
  useEffect(() => {
    const measure = (): void => {
      const el = scroller.current;
      setOverflows(el !== null && el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [layout.width]);

  const totalHeight = layout.height + HEADER_H;
  const stageX = (index: number): { x: number; width: number } => layout.columns.find((c) => c.index === index) ?? { x: 0, width: 0 };

  return (
    <div data-testid="pipeline-graph">
    <div ref={scroller} className="overflow-x-auto pb-2">
      <div className="relative" style={{ width: layout.width, height: totalHeight }}>
        {layout.columns.map((c) => (
          <div key={c.index} className="absolute top-0 border-b border-line-strong pb-1 text-sm font-semibold text-fg" style={{ left: c.x, width: c.width }}>{STAGES[c.index]!.label}</div>
        ))}
        <svg aria-hidden="true" className="absolute left-0" style={{ top: HEADER_H }} width={layout.width} height={layout.height} fill="none">
          <defs>
            {MARKERS.map((m) => (
              <marker key={m.id} id={m.id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill={m.color} /></marker>
            ))}
          </defs>
          {/* A null is not "no dependencies": a dotted stub marks that something may arrive here. */}
          {layout.nodes.filter((n) => n.x > 0 && hasUnknownDeps(byId.get(n.id)!)).map((n) => (
            <g key={`stub-${n.id}`} data-testid="graph-unknown-stub">
              <path d={`M ${n.x - 40} ${n.y + NODE_H / 2} L ${n.x} ${n.y + NODE_H / 2}`} stroke="var(--color-warning)" strokeWidth="1.5" strokeDasharray="2 4" markerEnd="url(#pl-arrow-stale)" />
              <text x={n.x - 24} y={n.y + NODE_H / 2 - 7} fontSize="14" fill="var(--color-warning)" stroke="var(--color-panel)" strokeWidth="4" paintOrder="stroke">?</text>
            </g>
          ))}
          {layout.edges.map((e, i) => {
            const meta = visibleEdges[i]!;
            const style = EDGE_STYLE[meta.state];
            const emphasized = selectedId !== null && (e.from === selectedId || e.to === selectedId);
            const critical = meta.critical === true && meta.state !== 'cycle';
            const color = critical ? 'var(--color-active)' : style.color;
            const marker = critical ? 'pl-arrow-critical' : style.marker;
            const mid = e.points[Math.floor(e.points.length / 2)]!;
            return (
              <g key={`${e.from}-${e.to}`} data-testid="graph-edge" data-state={meta.state} data-critical={meta.critical === true}>
                <path d={edgePath(e.points)} stroke={color} strokeWidth={critical || emphasized ? 2.5 : 1.5} strokeDasharray={style.dash} markerEnd={`url(#${marker})`} />
                {meta.label ? <text x={mid.x + 4} y={mid.y - 6} fontSize="13" fill={style.color} stroke="var(--color-panel)" strokeWidth="4" paintOrder="stroke">{meta.label}</text> : null}
              </g>
            );
          })}
        </svg>
        <ul aria-label="Tasks by stage. Arrow keys follow dependencies; Enter inspects." className="m-0 list-none p-0">
          {layout.nodes.map((n) => {
            const row = byId.get(n.id)!;
            return (
              <GraphNode
                key={n.id}
                row={row}
                layoutNode={n}
                selected={selectedId === n.id}
                connected={connected.has(n.id)}
                tabbable={tabbableId === n.id}
                highlight={highlight.includes(n.id) ? 'Eligible once this approval is given and the task verifies.' : null}
                onOpen={onOpen}
                onKey={onKey(n.id)}
                setRef={(el) => { if (el) buttons.current.set(n.id, el); else buttons.current.delete(n.id); }}
              />
            );
          })}
        </ul>
      </div>
    </div>
    {overflows ? <p className="mt-1 text-sm text-muted" data-testid="graph-scroll-hint">More stages to the right. Scroll sideways, or use the arrow keys.</p> : null}
    </div>
  );
}

export function GraphLegend() {
  const item = (dash: string | undefined, color: string, label: string, width = 1.5) => (
    <li className="flex items-center gap-1.5">
      <svg aria-hidden="true" width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke={color} strokeWidth={width} strokeDasharray={dash} /></svg>
      {label}
    </li>
  );
  return (
    <ul aria-label="Edge meanings" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" data-testid="graph-legend">
      {item(undefined, 'var(--color-line-strong)', 'Dependency met')}
      {item('6 5', 'var(--color-muted)', 'Waiting')}
      {item('2 4', 'var(--color-warning)', 'Stale or unknown')}
      {item(undefined, 'var(--color-active)', 'Longest chain (heavier line)', 2.5)}
    </ul>
  );
}
