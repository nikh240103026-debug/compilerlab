import { hierarchy, tree as tidyTree } from 'd3-hierarchy';
import { motion } from 'framer-motion';
import { memo, useMemo, type ReactNode } from 'react';

// One tree drawing for parse trees and ASTs in Modules 3 and 4. A node can carry small chips under
// it, for attributes, types, addresses or truelists. Plain SVG, so the same drawing goes on screen
// and into exports.

export interface SyntaxNode {
  id: number;
  label: string;
  /** Interior nodes are ellipses, leaves are boxes, and ε has no outline. */
  shape: 'ellipse' | 'box' | 'plain';
  children: readonly SyntaxNode[];
}

export type NodeTone = 'active' | 'muted' | 'danger' | null;
export type ChipTone = 'active' | 'source' | 'done' | 'ready' | 'danger' | 'info' | null;

export interface TreeChip {
  key: string;
  text: string;
  tone?: ChipTone;
}

export interface TreeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyntaxTreeLayout {
  width: number;
  height: number;
  /** Every node, flat, in preorder. */
  nodes: readonly SyntaxNode[];
  positions: ReadonlyMap<number, { x: number; y: number }>;
  chipWidths: ReadonlyMap<number, number>;
}

const NODE_HEIGHT = 30;
const LEVEL_GAP = 30;
const SIBLING_GAP = 18;
const MARGIN = 44;
const NODE_CHAR = 7.4;
const CHIP_CHAR = 6.8;
const CHIP_HEIGHT = 18;
const CHIP_GAP = 2;
const CHIP_PADDING = 12;

const labelWidth = (label: string) => Math.max(32, label.length * NODE_CHAR + 16);
const chipWidth = (text: string) => text.length * CHIP_CHAR + CHIP_PADDING;

/**
 * A tidy tree, laid out once from the finished run, so nothing moves while chips fill in. Give it
 * the longest text each chip will ever show. Each row is as tall as its tallest stack of chips.
 */
export function layoutSyntaxTree(
  root: SyntaxNode,
  chipTexts: (id: number) => readonly string[] = () => [],
): SyntaxTreeLayout {
  const nodes: SyntaxNode[] = [];
  const chipWidths = new Map<number, number>();
  const chipCounts = new Map<number, number>();
  const hier = hierarchy<SyntaxNode>(root, (node) => node.children);
  hier.eachBefore((item) => {
    nodes.push(item.data);
    const texts = chipTexts(item.data.id);
    chipCounts.set(item.data.id, texts.length);
    chipWidths.set(item.data.id, Math.max(0, ...texts.map(chipWidth)));
  });

  const widthOf = (node: SyntaxNode) =>
    Math.max(labelWidth(node.label), chipWidths.get(node.id) ?? 0);
  // With a node size of 1, a separation is simply a distance in pixels.
  const placed = tidyTree<SyntaxNode>()
    .nodeSize([1, 1])
    .separation(
      (a, b) =>
        (widthOf(a.data) + widthOf(b.data)) / 2 +
        (a.parent === b.parent ? SIBLING_GAP : SIBLING_GAP * 1.5),
    )(hier);

  const rowChips: number[] = [];
  placed.each((item) => {
    const count = chipCounts.get(item.data.id) ?? 0;
    rowChips[item.depth] = Math.max(rowChips[item.depth] ?? 0, count);
  });
  const rowY: number[] = [];
  let y = MARGIN / 2 + NODE_HEIGHT / 2;
  for (let depth = 0; depth < rowChips.length; depth++) {
    rowY[depth] = y;
    y += NODE_HEIGHT + LEVEL_GAP + (rowChips[depth] ?? 0) * (CHIP_HEIGHT + CHIP_GAP);
  }
  const height = y - LEVEL_GAP - NODE_HEIGHT / 2 + MARGIN / 2;

  let minX = Infinity;
  let maxX = -Infinity;
  placed.each((item) => {
    const half = widthOf(item.data) / 2;
    minX = Math.min(minX, item.x - half);
    maxX = Math.max(maxX, item.x + half);
  });
  const positions = new Map<number, { x: number; y: number }>();
  placed.each((item) => {
    positions.set(item.data.id, {
      x: item.x - minX + MARGIN,
      y: rowY[item.depth] as number,
    });
  });
  return { width: maxX - minX + MARGIN * 2, height, nodes, positions, chipWidths };
}

/** Where a chip sits, by its place in the stack under its node. */
export function chipBox(layout: SyntaxTreeLayout, id: number, index: number): TreeBox {
  const at = layout.positions.get(id) ?? { x: 0, y: 0 };
  const width = layout.chipWidths.get(id) ?? 0;
  return {
    x: at.x - width / 2,
    y: at.y + NODE_HEIGHT / 2 + 3 + index * (CHIP_HEIGHT + CHIP_GAP),
    width,
    height: CHIP_HEIGHT,
  };
}

function NodeShape({ node, tone }: { node: SyntaxNode; tone: NodeTone }) {
  const halfWidth = labelWidth(node.label) / 2;
  const glowing = tone === 'active';
  const stroke = glowing
    ? 'var(--accent)'
    : tone === 'danger'
      ? 'var(--danger)'
      : node.shape === 'box'
        ? 'var(--token-keyword)'
        : 'var(--ink-muted)';
  const ink =
    tone === 'danger'
      ? 'var(--danger)'
      : node.shape === 'box'
        ? 'var(--token-keyword)'
        : node.shape === 'plain'
          ? 'var(--ink-muted)'
          : 'var(--ink)';
  return (
    <g opacity={tone === 'muted' ? 0.55 : 1}>
      {glowing ? (
        <ellipse rx={halfWidth + 7} ry={22} fill="var(--accent)" fillOpacity={0.22} stroke="none" />
      ) : null}
      {node.shape === 'ellipse' ? (
        <ellipse
          rx={halfWidth}
          ry={NODE_HEIGHT / 2}
          fill="var(--surface)"
          stroke={stroke}
          strokeWidth={glowing ? 2.5 : 1.75}
        />
      ) : node.shape === 'box' ? (
        <rect
          x={-halfWidth}
          y={-NODE_HEIGHT / 2 + 1}
          width={halfWidth * 2}
          height={NODE_HEIGHT - 2}
          rx={4}
          fill="var(--surface)"
          stroke={stroke}
          strokeWidth={glowing ? 2.5 : 1.5}
        />
      ) : null}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={12}
        fontWeight={node.shape === 'ellipse' ? 600 : 500}
        fontFamily="monospace"
        fill={ink}
      >
        {node.label}
      </text>
    </g>
  );
}

function chipColors(tone: ChipTone) {
  switch (tone) {
    case 'active':
      return { fill: 'var(--accent-soft)', stroke: 'var(--accent)', ink: 'var(--accent)' };
    case 'source':
      return { fill: 'var(--surface-2)', stroke: 'var(--accent)', ink: 'var(--ink)' };
    case 'done':
      return { fill: 'var(--surface)', stroke: 'var(--line-strong)', ink: 'var(--ink)' };
    case 'ready':
      return { fill: 'var(--diff-add)', stroke: 'var(--success)', ink: 'var(--diff-add-ink)' };
    case 'danger':
      return { fill: 'var(--diff-remove)', stroke: 'var(--danger)', ink: 'var(--diff-remove-ink)' };
    case 'info':
      return { fill: 'var(--surface)', stroke: 'var(--info)', ink: 'var(--info)' };
    default:
      return { fill: 'var(--surface)', stroke: 'var(--line)', ink: 'var(--ink-muted)' };
  }
}

function ChipShape({ chip, box }: { chip: TreeChip; box: TreeBox }) {
  const { fill, stroke, ink } = chipColors(chip.tone ?? null);
  const glowing = chip.tone === 'active';
  return (
    <g transform={`translate(${box.x} ${box.y})`}>
      {glowing ? (
        <rect
          x={-4}
          y={-4}
          width={box.width + 8}
          height={box.height + 8}
          rx={7}
          fill="var(--accent)"
          fillOpacity={0.22}
        />
      ) : null}
      <rect
        width={box.width}
        height={box.height}
        rx={4}
        fill={fill}
        stroke={stroke}
        strokeWidth={glowing ? 1.75 : 1}
        strokeDasharray={chip.tone === 'source' ? '3 2' : undefined}
      />
      <text
        x={box.width / 2}
        y={box.height / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={11}
        fontWeight={glowing ? 600 : 400}
        fontFamily="monospace"
        fill={ink}
        xmlSpace="preserve"
      >
        {chip.text}
      </text>
    </g>
  );
}

interface SyntaxTreeProps {
  layout: SyntaxTreeLayout;
  tone?: (id: number) => NodeTone;
  /** Chips under a node. A null holds a place, so a later chip does not shift up. */
  chips?: (id: number) => readonly (TreeChip | null)[];
  /** Only these nodes are drawn, if given. */
  visible?: (id: number) => boolean;
  /** Drawn on top, such as dependency arrows. */
  overlay?: ReactNode;
  animated?: boolean;
  x?: number;
  y?: number;
  title?: string;
}

/** The tree. In an export, pass animated={false} and it draws at its natural size. */
export const SyntaxTreeSvg = memo(function SyntaxTreeSvg({
  layout,
  tone,
  chips,
  visible,
  overlay,
  animated = true,
  x,
  y,
  title,
}: SyntaxTreeProps) {
  const shown = useMemo(
    () => (visible ? layout.nodes.filter(({ id }) => visible(id)) : layout.nodes),
    [layout, visible],
  );
  const lines = shown.flatMap((node) =>
    node.children
      .filter((child) => !visible || visible(child.id))
      .map((child) => {
        const from = layout.positions.get(node.id);
        const to = layout.positions.get(child.id);
        return from && to ? (
          <line
            key={`${node.id}-${child.id}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--line-strong)"
            strokeWidth={1.25}
          />
        ) : null;
      }),
  );

  return (
    <svg
      role="img"
      aria-label={title ?? `A tree with ${shown.length} nodes.`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={animated ? '100%' : layout.width}
      height={animated ? undefined : layout.height}
      x={x}
      y={y}
      style={
        animated
          ? {
              maxWidth: layout.width * 1.25,
              // A large tree scrolls sideways in a narrow pane, so its labels stay readable.
              minWidth: Math.min(layout.width, Math.max(420, layout.width * 0.8)),
              display: 'block',
              marginInline: 'auto',
            }
          : undefined
      }
    >
      {lines}
      {shown.map((node) => {
        const at = layout.positions.get(node.id);
        if (!at) return null;
        const shape = <NodeShape node={node} tone={tone?.(node.id) ?? null} />;
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
      {chips
        ? shown.flatMap((node) =>
            chips(node.id).map((chip, index) => {
              if (!chip) return null;
              const shape = <ChipShape chip={chip} box={chipBox(layout, node.id, index)} />;
              return animated ? (
                <motion.g
                  key={`${node.id}:${chip.key}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                >
                  {shape}
                </motion.g>
              ) : (
                <g key={`${node.id}:${chip.key}`}>{shape}</g>
              );
            }),
          )
        : null}
      {overlay}
    </svg>
  );
});
