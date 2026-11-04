import {
  BaseEdge,
  Handle,
  Position,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cn } from '@/lib/cn';
import type { BuilderAutomaton } from './builder-model';
import { routeEdge, STATE_RADIUS, type Point } from './graph/layout';

// How an automaton looks on a React Flow canvas. The automata builder and the drawing questions in
// the assessment both use these, so a drawn state looks the same everywhere.

export const NODE_SIZE = STATE_RADIUS * 2;

type StateData = { label: string; accepting: boolean; start: boolean; active: boolean };
type TransitionData = { label: string; hasReverse: boolean; obstacles: readonly Point[] };
export type StateFlowNode = Node<StateData, 'state'>;
export type TransitionFlowEdge = Edge<TransitionData, 'transition'>;

function StateNode({ data }: NodeProps<StateFlowNode>) {
  const ring = data.active ? 'border-accent' : 'border-ink-muted';
  return (
    <div
      className="relative"
      style={{ width: NODE_SIZE, height: NODE_SIZE }}
      aria-label={`State ${data.label}${data.start ? ', start' : ''}${data.accepting ? ', accepting' : ''}`}
    >
      {data.active ? (
        <div className="absolute -inset-1.5 rounded-full bg-accent opacity-25" aria-hidden="true" />
      ) : null}
      {data.start ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -left-5 -translate-y-1/2 text-base leading-none text-ink-muted"
        >
          →
        </span>
      ) : null}
      {/* The ring starts a new edge, and the middle drags the state. */}
      <div className={cn('absolute inset-0 rounded-full border-2 bg-surface', ring)} />
      <Handle
        type="source"
        position={Position.Top}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          transform: 'none',
          borderRadius: '50%',
          background: 'transparent',
          border: 'none',
        }}
      />
      <div
        className={cn(
          'state-drag absolute inset-[6px] flex cursor-grab items-center justify-center rounded-full font-mono text-xs font-semibold text-ink',
          data.accepting && cn('border-2', ring),
        )}
      >
        {data.label}
      </div>
    </div>
  );
}

function centerOf(node: InternalNode) {
  const { x, y } = node.internals.positionAbsolute;
  return {
    x: x + (node.measured.width ?? NODE_SIZE) / 2,
    y: y + (node.measured.height ?? NODE_SIZE) / 2,
  };
}

function TransitionEdge({ id, source, target, data, selected }: EdgeProps<TransitionFlowEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const route = routeEdge(
    centerOf(from),
    centerOf(to),
    data?.obstacles ?? [],
    data?.hasReverse ?? false,
  );
  const color = selected ? 'var(--accent)' : 'var(--line-strong)';
  return (
    <>
      <BaseEdge
        id={id}
        path={route.path}
        interactionWidth={24}
        style={{ stroke: color, strokeWidth: selected ? 2.25 : 1.5 }}
      />
      <polygon points={route.arrow} fill={color} />
      <text
        x={route.label.x}
        y={route.label.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fontFamily="var(--font-mono)"
        fill={selected ? 'var(--accent)' : 'var(--ink-muted)'}
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

export const NODE_TYPES: NodeTypes = { state: StateNode };
export const EDGE_TYPES: EdgeTypes = { transition: TransitionEdge };

export function toFlowNodes(automaton: BuilderAutomaton): StateFlowNode[] {
  return automaton.states.map((state) => ({
    id: state.id,
    type: 'state',
    position: { x: state.x, y: state.y },
    dragHandle: '.state-drag',
    data: { label: state.label, accepting: state.accepting, start: false, active: false },
  }));
}

export function toFlowEdges(automaton: BuilderAutomaton): TransitionFlowEdge[] {
  return automaton.transitions.map((transition) => ({
    id: transition.id,
    type: 'transition',
    source: transition.from,
    target: transition.to,
    data: { label: transition.label, hasReverse: false, obstacles: [] },
  }));
}

/** What the canvas holds, in the builder model's terms. */
export function fromFlow(
  nodes: readonly StateFlowNode[],
  edges: readonly TransitionFlowEdge[],
  startId: string | null,
): BuilderAutomaton {
  return {
    startId,
    states: nodes.map((node) => ({
      id: node.id,
      label: node.data.label,
      accepting: node.data.accepting,
      x: node.position.x,
      y: node.position.y,
    })),
    transitions: edges.map((edge) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      label: edge.data?.label ?? '',
    })),
  };
}

/** Marks the start state and any lit states, for drawing. */
export function displayNodes(
  nodes: readonly StateFlowNode[],
  startId: string | null,
  active: readonly string[] = [],
): StateFlowNode[] {
  return nodes.map((node) => ({
    ...node,
    data: { ...node.data, start: node.id === startId, active: active.includes(node.id) },
  }));
}

/** Tells each edge what it has to curve around, and whether it has a partner going the other way. */
export function displayEdges(
  nodes: readonly StateFlowNode[],
  edges: readonly TransitionFlowEdge[],
): TransitionFlowEdge[] {
  const pairs = new Set(edges.map(({ source, target }) => `${source}>${target}`));
  const obstacles = nodes.map(({ position }) => ({
    x: position.x + STATE_RADIUS,
    y: position.y + STATE_RADIUS,
  }));
  return edges.map((edge) => ({
    ...edge,
    data: {
      obstacles,
      label: edge.data?.label ?? '',
      hasReverse: edge.source !== edge.target && pairs.has(`${edge.target}>${edge.source}`),
    },
  }));
}
