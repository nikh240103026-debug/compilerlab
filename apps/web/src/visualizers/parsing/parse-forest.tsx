import { grammarForestRoots, type GrammarParseNode } from '@compilerlab/engine';
import { hierarchy, tree as tidyTree } from 'd3-hierarchy';
import { motion } from 'framer-motion';
import { memo, useMemo } from 'react';

const NODE_GAP = 54;
const LEVEL_GAP = 62;
const MARGIN = 34;
const CHAR_WIDTH = 7.4;

export interface ForestLayout {
  width: number;
  height: number;
  positions: ReadonlyMap<number, { x: number; y: number }>;
}

/**
 * A tidy tree layout from the finished forest, so nodes stay put while it grows. Several roots
 * hang off an invisible one, which is what a bottom-up parser has partway through.
 */
export function layoutForest(
  nodes: readonly GrammarParseNode[],
  roots: readonly number[] = grammarForestRoots(nodes),
): ForestLayout {
  const VIRTUAL_ROOT = -1;
  const labelOf = (id: number) => nodes[id]?.symbol.length ?? 1;
  const root = hierarchy<number>(VIRTUAL_ROOT, (id) =>
    id === VIRTUAL_ROOT ? roots : (nodes[id]?.children ?? []),
  );
  const placed = tidyTree<number>()
    .nodeSize([NODE_GAP, LEVEL_GAP])
    .separation((a, b) => {
      const wanted = ((labelOf(a.data) + labelOf(b.data)) * CHAR_WIDTH) / 2 + 20;
      return Math.max(a.parent === b.parent ? 1 : 1.25, wanted / NODE_GAP);
    })(root);

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  placed.each((node) => {
    if (node.data === VIRTUAL_ROOT) return;
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y - LEVEL_GAP);
  });
  if (minX === Infinity) return { width: MARGIN * 2, height: MARGIN * 2, positions: new Map() };

  const positions = new Map<number, { x: number; y: number }>();
  placed.each((node) => {
    if (node.data !== VIRTUAL_ROOT) {
      positions.set(node.data, { x: node.x - minX + MARGIN, y: node.y - LEVEL_GAP + MARGIN });
    }
  });
  return { width: maxX - minX + MARGIN * 2, height: maxY + MARGIN * 2, positions };
}

/**
 * A quick estimate of a tree's size without laying it out, used to give a whole backtracking trace
 * one export size even though the tree changes shape from step to step.
 */
export function forestExtent(nodes: readonly GrammarParseNode[]): {
  width: number;
  height: number;
} {
  let leaves = 0;
  let deepest = 0;
  const depth = new Array<number>(nodes.length).fill(0);
  for (const node of nodes) {
    const here =
      node.parent === null || node.parent >= node.id
        ? (depth[node.id] ?? 0)
        : (depth[node.parent] ?? 0) + 1;
    depth[node.id] = here;
    deepest = Math.max(deepest, here);
    if (node.children.length === 0) leaves++;
  }
  return {
    width: Math.max(1, leaves) * NODE_GAP + MARGIN * 2,
    height: deepest * LEVEL_GAP + MARGIN * 2,
  };
}

export type ForestNodeTone = 'active' | 'pending' | 'muted';

interface ForestDrawingProps {
  nodes: readonly GrammarParseNode[];
  layout: ForestLayout;
  /** Nodes with an id below this are drawn. Defaults to all. */
  nodeCount?: number;
  /** Only these are drawn, if given. Used by derivations, which reveal nodes in their own order. */
  revealed?: readonly number[];
  tone?: (id: number) => ForestNodeTone | null;
  /** Tells a nonterminal that recovery gave up on from a missing terminal, so its shape is right. */
  nonterminals?: ReadonlySet<string>;
  animated?: boolean;
  x?: number;
  y?: number;
  /** A fixed size to scale into, for exports where the tree changes shape between steps. */
  width?: number;
  height?: number;
  title?: string;
}

function NodeShape({
  node,
  tone,
  nonterminals,
}: {
  node: GrammarParseNode;
  tone: ForestNodeTone | null;
  nonterminals: ReadonlySet<string> | undefined;
}) {
  const glowing = tone === 'active';
  const label = node.symbol;
  const halfWidth = Math.max(16, (label.length * CHAR_WIDTH) / 2 + 8);
  const isNonterminal =
    node.kind === 'nonterminal' ||
    (node.kind === 'error' && (node.children.length > 0 || nonterminals?.has(label) === true));
  // Nodes come from the finished run, so one that will fail later is not marked until it does.
  const isError = node.kind === 'error' && tone !== 'pending' && tone !== 'active';
  const stroke = glowing
    ? 'var(--accent)'
    : isError
      ? 'var(--danger)'
      : isNonterminal
        ? 'var(--ink-muted)'
        : 'var(--token-keyword)';
  const dash = isError || tone === 'pending' ? '4 3' : undefined;
  return (
    <g opacity={tone === 'muted' || tone === 'pending' ? 0.6 : 1}>
      {glowing ? (
        <ellipse rx={halfWidth + 7} ry={23} fill="var(--accent)" fillOpacity={0.22} stroke="none" />
      ) : null}
      {node.kind === 'epsilon' ? null : isNonterminal ? (
        <ellipse
          rx={halfWidth}
          ry={16}
          fill="var(--surface)"
          stroke={stroke}
          strokeWidth={glowing ? 2.5 : 1.75}
          strokeDasharray={dash}
        />
      ) : (
        <rect
          x={-halfWidth}
          y={-14}
          width={halfWidth * 2}
          height={28}
          rx={4}
          fill="var(--surface)"
          stroke={stroke}
          strokeWidth={glowing ? 2.5 : 1.5}
          strokeDasharray={dash}
        />
      )}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={12}
        fontWeight={isNonterminal ? 600 : 500}
        fontFamily="monospace"
        fill={
          node.kind === 'epsilon'
            ? 'var(--ink-muted)'
            : isError
              ? 'var(--danger)'
              : isNonterminal
                ? 'var(--ink)'
                : 'var(--token-keyword)'
        }
      >
        {label}
      </text>
    </g>
  );
}

/** A parse tree or forest in plain SVG, so the same drawing goes on screen and into exports. */
export const ParseForest = memo(function ParseForest({
  nodes,
  layout,
  nodeCount = nodes.length,
  revealed,
  tone,
  nonterminals,
  animated = true,
  x,
  y,
  width,
  height,
  title,
}: ForestDrawingProps) {
  const visible = useMemo(() => {
    const shown = revealed ? new Set(revealed) : null;
    return nodes.filter((node) => (shown ? shown.has(node.id) : node.id < nodeCount));
  }, [nodes, nodeCount, revealed]);
  const visibleIds = useMemo(() => new Set(visible.map(({ id }) => id)), [visible]);

  const edges = visible.flatMap((node) =>
    node.children
      .filter((child) => visibleIds.has(child))
      .map((child) => {
        const from = layout.positions.get(node.id);
        const to = layout.positions.get(child);
        return from && to ? (
          <line
            key={`${node.id}-${child}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--line-strong)"
            strokeWidth={1.5}
          />
        ) : null;
      }),
  );

  return (
    <svg
      role="img"
      aria-label={title ?? `A parse tree with ${visible.length} nodes so far.`}
      viewBox={`0 0 ${Math.max(1, layout.width)} ${Math.max(1, layout.height)}`}
      width={animated ? '100%' : (width ?? layout.width)}
      height={animated ? undefined : (height ?? layout.height)}
      x={x}
      y={y}
      style={
        animated
          ? {
              maxWidth: layout.width * 1.25,
              minWidth: Math.min(layout.width, 420),
              display: 'block',
              marginInline: 'auto',
            }
          : undefined
      }
    >
      {edges}
      {visible.map((node) => {
        const at = layout.positions.get(node.id);
        if (!at) return null;
        const shape = (
          <NodeShape node={node} tone={tone?.(node.id) ?? null} nonterminals={nonterminals} />
        );
        return (
          <g key={node.id} transform={`translate(${at.x} ${at.y})`}>
            {animated ? (
              <motion.g
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.2 }}
              >
                {shape}
              </motion.g>
            ) : (
              shape
            )}
          </g>
        );
      })}
    </svg>
  );
});
