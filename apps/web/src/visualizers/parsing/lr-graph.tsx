import type { LrAutomaton, LrBuildStep } from '@compilerlab/engine';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState } from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useSettings } from '@/hooks/use-settings';
import { resolveTheme } from '@/lib/apply-settings';
import { cn } from '@/lib/cn';
import {
  ITEM_HEADER_HEIGHT,
  ITEM_LINE_HEIGHT,
  routeBoxEdge,
  type Box,
  type ItemLine,
  type ItemSetLayout,
} from './lr-layout';

/** What is lit up in the automaton. Shared by the live graph and the exported drawing. */
export interface LrHighlights {
  /** The state the student picked, or a deep link asked for. */
  selected: number | null;
  /** States with a conflict. */
  conflicts: ReadonlySet<number>;
}

type ItemSetData = {
  label: string;
  lines: readonly ItemLine[];
  accept: boolean;
  start: boolean;
  shown: boolean;
  active: boolean;
  selected: boolean;
  conflict: boolean;
  width: number;
  height: number;
};
type ItemSetNodeType = Node<ItemSetData, 'itemSet'>;
type ItemEdgeData = { label: string; active: boolean };
type ItemEdgeType = Edge<ItemEdgeData, 'item'>;

/** The canvas is a scaled drawing, so its sizes are pixels that ignore the app's font setting. */
function ItemSetNode({ data }: NodeProps<ItemSetNodeType>) {
  const ring = data.conflict ? 'var(--danger)' : data.active ? 'var(--accent)' : 'var(--ink-muted)';
  return (
    <div
      className={cn(
        'h-full w-full rounded-md border-2 bg-surface',
        data.conflict ? 'border-danger' : data.active ? 'border-accent' : 'border-line-strong',
        data.selected && 'outline-2 outline-offset-2 outline-accent',
      )}
      style={
        data.active || data.selected
          ? { boxShadow: '0 0 0 7px color-mix(in srgb, var(--accent) 22%, transparent)' }
          : undefined
      }
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none' }}
      />
      <div
        className="flex items-center gap-[6px] border-b border-line px-[8px]"
        style={{ height: ITEM_HEADER_HEIGHT }}
      >
        <span
          aria-hidden="true"
          className="flex size-[22px] items-center justify-center rounded-full border-2 font-mono text-[10px] font-semibold text-ink"
          style={{
            borderColor: ring,
            // The accept state is double-ringed, like every other accepting state in the course.
            ...(data.accept ? { outline: `1.5px solid ${ring}`, outlineOffset: 1.5 } : {}),
          }}
        >
          {data.label}
        </span>
        <span className="font-mono text-[11px] font-semibold text-ink">
          {data.start ? 'start' : data.accept ? 'accept' : ''}
        </span>
        {data.conflict ? (
          <span className="ml-auto text-[11px] font-semibold text-danger">conflict</span>
        ) : null}
      </div>
      <ul className="px-[8px] py-[4px] font-mono text-[12px] whitespace-pre text-ink">
        {data.lines.map((line) => (
          <li
            key={line.text}
            style={{ height: ITEM_LINE_HEIGHT }}
            className={line.kernel ? 'font-semibold' : 'text-ink-muted'}
          >
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function boxOf(node: InternalNode): Box {
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, width: node.measured.width ?? 0, height: node.measured.height ?? 0 };
}

function ItemEdge({ id, source, target, data }: EdgeProps<ItemEdgeType>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const route = routeBoxEdge(boxOf(from), boxOf(to), source === target);
  const active = data?.active ?? false;
  const color = active ? 'var(--accent)' : 'var(--line-strong)';
  return (
    <>
      <BaseEdge
        id={id}
        path={route.path}
        interactionWidth={0}
        style={{ stroke: color, strokeWidth: active ? 2.25 : 1.5 }}
      />
      <polygon points={route.arrow} fill={color} />
      <text
        x={route.label.x}
        y={route.label.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fontWeight={active ? 600 : 400}
        fontFamily="var(--font-mono)"
        fill={active ? 'var(--accent)' : 'var(--ink-muted)'}
        stroke="var(--surface)"
        strokeWidth={4}
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {data?.label}
      </text>
    </>
  );
}

const NODE_TYPES: NodeTypes = { itemSet: ItemSetNode };
const EDGE_TYPES: EdgeTypes = { item: ItemEdge };

/** Merges parallel edges, so two symbols between the same two states share one arrow. */
function mergedEdges(automaton: LrAutomaton, edgeCount: number, stateCount: number) {
  const merged = new Map<string, { from: number; to: number; labels: string[]; shown: boolean }>();
  automaton.edges.forEach((edge, index) => {
    const key = `${edge.from}>${edge.to}`;
    const shown = index < edgeCount && edge.from < stateCount && edge.to < stateCount;
    const existing = merged.get(key);
    if (existing) {
      if (shown) {
        existing.labels.push(edge.symbol);
        existing.shown = true;
      }
    } else {
      merged.set(key, { from: edge.from, to: edge.to, labels: shown ? [edge.symbol] : [], shown });
    }
  });
  return [...merged.values()];
}

/**
 * The automaton on a React Flow canvas: drag the boxes, pan and zoom. It keeps every box in place
 * from the start, and hides the ones not built yet, so nothing shifts while the automaton grows.
 */
export function LrFlowGraph({
  automaton,
  layout,
  step,
  highlights,
  onSelect,
}: {
  automaton: LrAutomaton;
  layout: ItemSetLayout;
  step: LrBuildStep;
  highlights: LrHighlights;
  onSelect: (state: number | null) => void;
}) {
  const { settings } = useSettings();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [nodes, setNodes] = useState<ItemSetNodeType[]>(() =>
    automaton.states.map((state) => {
      const box = layout.boxes.get(state.id) as Box;
      return {
        id: String(state.id),
        type: 'itemSet' as const,
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        data: {
          label: state.label,
          lines: layout.lines.get(state.id) ?? [],
          accept: state.id === automaton.acceptState,
          start: state.id === 0,
          shown: true,
          active: false,
          selected: false,
          conflict: false,
          width: box.width,
          height: box.height,
        },
      };
    }),
  );

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => {
        const id = Number(node.id);
        const shown = id < step.stateCount;
        return {
          ...node,
          selectable: shown,
          draggable: shown,
          focusable: shown,
          // Hidden with CSS and not with `hidden`, so every box is measured and the view stays put.
          style: shown ? {} : { visibility: 'hidden' as const, pointerEvents: 'none' as const },
          ariaLabel: `State ${node.data.label}. ${node.data.lines.map(({ text }) => text).join('; ')}`,
          data: {
            ...node.data,
            shown,
            active: step.activeState === id || step.target === id,
            selected: highlights.selected === id,
            // A conflict only shows once this state's row of the table has been filled in.
            conflict: id < step.filledRows && highlights.conflicts.has(id),
          },
        };
      }),
    [nodes, step, highlights],
  );

  const displayEdges = useMemo<ItemEdgeType[]>(
    () =>
      mergedEdges(automaton, step.edgeCount, step.stateCount).map((edge) => ({
        id: `${edge.from}>${edge.to}`,
        type: 'item',
        source: String(edge.from),
        target: String(edge.to),
        hidden: !edge.shown,
        selectable: false,
        focusable: false,
        data: {
          label: edge.labels.join(', '),
          active:
            step.activeState === edge.from && step.target === edge.to && step.activeSymbol !== null,
        },
      })),
    [automaton, step],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<ItemSetNodeType>[]) => setNodes((all) => applyNodeChanges(changes, all)),
    [],
  );

  return (
    <div
      className="h-[30rem] overflow-hidden rounded-md border border-line bg-surface"
      role="group"
      aria-label="The LR automaton. Drag a box to move it, and click one to see its row. The state list below does the same without a mouse."
    >
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelect(Number(node.id))}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        edgesFocusable={false}
        colorMode={resolveTheme(settings.theme, prefersDark)}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.75}
        deleteKeyCode={null}
      >
        <Background gap={20} size={1} color="var(--line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** The same automaton in plain SVG, for exported frames. */
export function LrAutomatonSvg({
  automaton,
  layout,
  step,
  highlights,
}: {
  automaton: LrAutomaton;
  layout: ItemSetLayout;
  step: LrBuildStep;
  highlights: LrHighlights;
}) {
  const edges = mergedEdges(automaton, step.edgeCount, step.stateCount).filter(
    ({ shown }) => shown,
  );
  return (
    <g fontFamily="monospace">
      {edges.map((edge) => {
        const route = routeBoxEdge(
          layout.boxes.get(edge.from) as Box,
          layout.boxes.get(edge.to) as Box,
          edge.from === edge.to,
        );
        const active =
          step.activeState === edge.from && step.target === edge.to && step.activeSymbol !== null;
        const color = active ? 'var(--accent)' : 'var(--line-strong)';
        return (
          <g key={`${edge.from}>${edge.to}`}>
            <path d={route.path} fill="none" stroke={color} strokeWidth={active ? 2.25 : 1.5} />
            <polygon points={route.arrow} fill={color} />
            <text
              x={route.label.x}
              y={route.label.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={12}
              fill={active ? 'var(--accent)' : 'var(--ink-muted)'}
              stroke="var(--surface)"
              strokeWidth={4}
              paintOrder="stroke"
            >
              {edge.labels.join(', ')}
            </text>
          </g>
        );
      })}
      {automaton.states
        .filter(({ id }) => id < step.stateCount)
        .map((state) => {
          const box = layout.boxes.get(state.id) as Box;
          const active = step.activeState === state.id || step.target === state.id;
          const conflict = state.id < step.filledRows && highlights.conflicts.has(state.id);
          const lit = active || highlights.selected === state.id;
          const stroke = conflict ? 'var(--danger)' : lit ? 'var(--accent)' : 'var(--line-strong)';
          const ring = conflict ? 'var(--danger)' : lit ? 'var(--accent)' : 'var(--ink-muted)';
          return (
            <g key={state.id} transform={`translate(${box.x} ${box.y})`}>
              {lit ? (
                <rect
                  x={-7}
                  y={-7}
                  width={box.width + 14}
                  height={box.height + 14}
                  rx={10}
                  fill="var(--accent)"
                  fillOpacity={0.22}
                />
              ) : null}
              <rect
                width={box.width}
                height={box.height}
                rx={6}
                fill="var(--surface)"
                stroke={stroke}
                strokeWidth={2}
              />
              <circle cx={18} cy={15} r={11} fill="none" stroke={ring} strokeWidth={2} />
              {state.id === automaton.acceptState ? (
                <circle cx={18} cy={15} r={14} fill="none" stroke={ring} strokeWidth={1.5} />
              ) : null}
              <text
                x={18}
                y={15}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={state.label.length > 2 ? 8 : 10}
                fontWeight={600}
                fill="var(--ink)"
              >
                {state.label}
              </text>
              {conflict ? (
                <text
                  x={box.width - 8}
                  y={15}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--danger)"
                >
                  conflict
                </text>
              ) : null}
              {(layout.lines.get(state.id) ?? []).map((line, index) => (
                <text
                  key={line.text}
                  x={8}
                  y={ITEM_HEADER_HEIGHT + 13 + index * ITEM_LINE_HEIGHT}
                  fontSize={12}
                  xmlSpace="preserve"
                  fontWeight={line.kernel ? 600 : 400}
                  fill={line.kernel ? 'var(--ink)' : 'var(--ink-muted)'}
                >
                  {line.text}
                </text>
              ))}
            </g>
          );
        })}
    </g>
  );
}
