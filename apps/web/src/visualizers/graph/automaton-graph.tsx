import {
  formatCharSet,
  formatStateSet,
  NO_TRANSITION,
  type Dfa,
  type Nfa,
  type NfaTransition,
} from '@compilerlab/engine';
import { motion } from 'framer-motion';
import { memo, useMemo } from 'react';
import { routeEdge, STATE_RADIUS, type GraphLayout, type Point } from './layout';

export type GraphTone = 'idle' | 'active' | 'new' | 'muted';

export interface GraphNode {
  key: number;
  label: string;
  accepting?: boolean;
  start?: boolean;
  tone?: GraphTone;
  /** Overrides the ring color, for example to show which partition block a state is in. */
  color?: string;
}

export interface GraphEdge {
  from: number;
  to: number;
  label: string;
  tone?: GraphTone;
}

const toneStroke = (tone: GraphTone | undefined, fallback: string) =>
  tone === 'active' || tone === 'new' ? 'var(--accent)' : fallback;

/** One drawn arrow per pair of states, with its labels joined, as textbooks draw them. */
export function mergeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.label.split(', ').includes(edge.label)) {
        existing.label = `${existing.label}, ${edge.label}`;
      }
      if (edge.tone && edge.tone !== 'idle') existing.tone = edge.tone;
    } else {
      merged.set(key, { ...edge });
    }
  }
  return [...merged.values()];
}

export const edgeLabel = ({ on }: NfaTransition) => (on ? formatCharSet(on) : 'ε');

export function nfaEdges(nfa: Pick<Nfa, 'transitions'>): GraphEdge[] {
  return mergeEdges(
    nfa.transitions.map((transition) => ({
      from: transition.from,
      to: transition.to,
      label: edgeLabel(transition),
    })),
  );
}

export function dfaEdges(dfa: Dfa): GraphEdge[] {
  return mergeEdges(
    dfa.delta.flatMap((row, from) =>
      row.flatMap((to, symbol) =>
        to === NO_TRANSITION
          ? []
          : [{ from, to, label: formatCharSet(dfa.alphabet[symbol] as Dfa['alphabet'][number]) }],
      ),
    ),
  );
}

export function describeGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const start = nodes.find((node) => node.start);
  const accepting = nodes.filter((node) => node.accepting).map((node) => node.label);
  return [
    `A state diagram with ${nodes.length} states and ${edges.length} transitions.`,
    start ? `It starts in state ${start.label}.` : '',
    accepting.length > 0 ? `Accepting: ${formatStateSet(accepting)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const TEXT_STYLE = { fontFamily: 'var(--font-mono)' };

function Edge({ edge, route }: { edge: GraphEdge; route: ReturnType<typeof routeEdge> }) {
  const stroke = toneStroke(edge.tone, 'var(--line-strong)');
  const emphasized = edge.tone === 'active' || edge.tone === 'new';
  return (
    <g opacity={edge.tone === 'muted' ? 0.35 : 1}>
      <path d={route.path} fill="none" stroke={stroke} strokeWidth={emphasized ? 2.25 : 1.5} />
      <polygon points={route.arrow} fill={stroke} />
      <text
        x={route.label.x}
        y={route.label.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fontWeight={emphasized ? 600 : 400}
        fill={emphasized ? 'var(--accent)' : 'var(--ink-muted)'}
        stroke="var(--surface)"
        strokeWidth={4}
        paintOrder="stroke"
        style={TEXT_STYLE}
      >
        {edge.label}
      </text>
    </g>
  );
}

function StateShape({ node }: { node: GraphNode }) {
  const stroke = toneStroke(node.tone, node.color ?? 'var(--ink-muted)');
  const glowing = node.tone === 'active' || node.tone === 'new';
  return (
    <g opacity={node.tone === 'muted' ? 0.35 : 1}>
      {glowing ? (
        <circle r={STATE_RADIUS + 7} fill="var(--accent)" fillOpacity={0.22} stroke="none" />
      ) : null}
      <circle
        r={STATE_RADIUS}
        fill="var(--surface)"
        stroke={stroke}
        strokeWidth={glowing || node.color ? 2.5 : 1.75}
      />
      {node.accepting ? (
        <circle r={STATE_RADIUS - 4.5} fill="none" stroke={stroke} strokeWidth={1.5} />
      ) : null}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={node.label.length > 4 ? 10 : 13}
        fontWeight={600}
        fill="var(--ink)"
        style={TEXT_STYLE}
      >
        {node.label}
      </text>
    </g>
  );
}

function StartArrow({ at }: { at: Point }) {
  const tip = at.x - STATE_RADIUS - 1;
  return (
    <g>
      <path d={`M${tip - 28},${at.y} H${tip - 6}`} stroke="var(--ink-muted)" strokeWidth={1.5} />
      <polygon
        points={`${tip},${at.y} ${tip - 8},${at.y - 4} ${tip - 8},${at.y + 4}`}
        fill="var(--ink-muted)"
      />
    </g>
  );
}

export interface AutomatonGraphProps {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  layout: GraphLayout;
  /** Where to draw a state the final layout does not know, such as a waiting copy. */
  positionOf?: (key: number) => Point | undefined;
  /** Static frames, used for exports, skip the entry animation. */
  animated?: boolean;
  /** For nesting inside an exported frame. */
  x?: number;
  y?: number;
  title?: string;
}

/** Plain SVG, so the same drawing can be shown on screen and exported as an image. */
export const AutomatonGraph = memo(function AutomatonGraph({
  nodes,
  edges,
  layout,
  positionOf,
  animated = true,
  x,
  y,
  title,
}: AutomatonGraphProps) {
  const where = useMemo(
    () =>
      (key: number): Point =>
        positionOf?.(key) ?? layout.positions.get(key) ?? { x: 0, y: 0 },
    [layout, positionOf],
  );
  const routes = useMemo(() => {
    const obstacles = nodes.map((node) => where(node.key));
    const pairs = new Set(edges.map(({ from, to }) => `${from}>${to}`));
    return edges.map((edge) =>
      routeEdge(where(edge.from), where(edge.to), obstacles, pairs.has(`${edge.to}>${edge.from}`)),
    );
  }, [nodes, edges, where]);
  const description = useMemo(() => describeGraph(nodes, edges), [nodes, edges]);
  const start = nodes.find((node) => node.start);

  return (
    <svg
      role="img"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={animated ? '100%' : layout.width}
      height={animated ? undefined : layout.height}
      x={x}
      y={y}
      aria-label={title ?? description}
      style={
        animated
          ? {
              // Small automata should not balloon to fill a wide pane.
              maxWidth: layout.width * 1.25,
              // A large automaton scrolls sideways in a narrow pane, so its labels stay readable.
              minWidth: Math.min(layout.width, Math.max(420, layout.width * 0.7)),
              display: 'block',
              marginInline: 'auto',
            }
          : undefined
      }
    >
      {edges.map((edge, index) =>
        animated ? (
          <motion.g
            key={`${edge.from}>${edge.to}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            <Edge edge={edge} route={routes[index] as ReturnType<typeof routeEdge>} />
          </motion.g>
        ) : (
          <Edge
            key={`${edge.from}>${edge.to}`}
            edge={edge}
            route={routes[index] as ReturnType<typeof routeEdge>}
          />
        ),
      )}
      {start ? <StartArrow at={where(start.key)} /> : null}
      {nodes.map((node) => {
        const { x: nodeX, y: nodeY } = where(node.key);
        return animated ? (
          <g
            key={node.key}
            style={{
              transform: `translate(${nodeX}px, ${nodeY}px)`,
              transition: 'transform var(--duration-base) var(--ease-standard)',
            }}
          >
            <motion.g
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.2 }}
            >
              <StateShape node={node} />
            </motion.g>
          </g>
        ) : (
          <g key={node.key} transform={`translate(${nodeX} ${nodeY})`}>
            <StateShape node={node} />
          </g>
        );
      })}
    </svg>
  );
});
