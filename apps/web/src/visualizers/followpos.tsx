import {
  formatStateSet,
  NO_TRANSITION,
  type DirectState,
  type SyntaxTreeNode,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useMemo, useState } from 'react';
import { useAiVisualizerInput } from '@/ai/context-store';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import { STATE_RADIUS } from './graph/layout';
import { measureTable, SvgTable } from './player/export-frame';
import { Player } from './player/player';
import { DataTable, JobResult, RegexField, type VisualizerProps } from './shared';

const PRESETS = ['(a|b)*abb', 'a*b', '(a|b)+c?', 'ab|ac'];
const LEAF_GAP = 76;
const LEVEL_GAP = 78;
const MARGIN = 40;

interface TreeLayout {
  width: number;
  height: number;
  positions: Map<number, { x: number; y: number }>;
}

/** Leaves go left to right in order, and each parent sits centered above its children. */
function layoutTree(nodes: readonly SyntaxTreeNode[], root: number): TreeLayout {
  const positions = new Map<number, { x: number; y: number }>();
  let nextLeaf = 0;
  let deepest = 0;
  const place = (id: number, depth: number): number => {
    deepest = Math.max(deepest, depth);
    const { children } = nodes[id] as SyntaxTreeNode;
    const y = MARGIN + depth * LEVEL_GAP;
    if (children.length === 0) {
      const x = MARGIN + 28 + nextLeaf++ * LEAF_GAP;
      positions.set(id, { x, y });
      return x;
    }
    const xs = children.map((child) => place(child, depth + 1));
    const x = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    positions.set(id, { x, y });
    return x;
  };
  place(root, 0);
  return {
    width: MARGIN * 2 + 28 + Math.max(0, nextLeaf - 1) * LEAF_GAP + 28,
    height: MARGIN * 2 + deepest * LEVEL_GAP + 20,
    positions,
  };
}

function SyntaxTree({ state, layout }: { state: DirectState; layout: TreeLayout }) {
  return (
    <svg
      role="img"
      aria-label="The syntax tree of the augmented expression, annotated with firstpos and lastpos"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      {state.nodes.flatMap((node) =>
        node.children.map((child) => {
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
      )}
      {state.nodes.map((node) => {
        const at = layout.positions.get(node.id);
        if (!at) return null;
        const active = node.id === state.activeNode;
        const radius = STATE_RADIUS - 5;
        return (
          <g key={node.id} transform={`translate(${at.x} ${at.y})`} fontFamily="monospace">
            {active ? <circle r={radius + 6} fill="var(--accent)" fillOpacity={0.22} /> : null}
            <circle
              r={radius}
              fill="var(--surface)"
              stroke={active ? 'var(--accent)' : 'var(--ink-muted)'}
              strokeWidth={active ? 2.25 : 1.5}
              strokeDasharray={node.nullable ? '3 2' : undefined}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={11}
              fontWeight={600}
              fill="var(--ink)"
            >
              {node.label}
            </text>
            {node.position !== null ? (
              <text y={radius + 13} textAnchor="middle" fontSize={11} fill="var(--accent)">
                {node.position}
              </text>
            ) : null}
            {node.firstpos ? (
              <text
                x={-radius - 3}
                y={-radius + 2}
                textAnchor="end"
                fontSize={10}
                fill="var(--ink-muted)"
              >
                {formatStateSet(node.firstpos).replace(/ /g, '')}
              </text>
            ) : null}
            {node.lastpos ? (
              <text x={radius + 3} y={-radius + 2} fontSize={10} fill="var(--ink-muted)">
                {formatStateSet(node.lastpos).replace(/ /g, '')}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function followRows(state: DirectState) {
  return state.positionLabels
    .slice(1)
    .map((label, index) => [
      `${index + 1} (${label})`,
      formatStateSet(state.followpos[index + 1] ?? []),
    ]);
}

function dstateRows(state: DirectState) {
  return state.rows.map((row, rowIndex) => [
    `${rowIndex === 0 ? '→ ' : ''}${row.accepting ? '* ' : ''}${row.name}`,
    formatStateSet(row.positions),
    ...row.cells.map((cell) => {
      if (cell === null) return '';
      return cell === NO_TRANSITION ? '–' : (state.rows[cell]?.name ?? '');
    }),
  ]);
}

function Result({
  trace,
  onUsed,
}: {
  trace: readonly TraceStep<DirectState>[];
  onUsed: (() => void) | undefined;
}) {
  const final = (trace.at(-1) as TraceStep<DirectState>).state;
  const layout = useMemo(() => layoutTree(final.nodes, final.root), [final]);

  const renderStage = useCallback(
    ({ state }: TraceStep<DirectState>) => (
      <div className="space-y-3">
        <SyntaxTree state={state} layout={layout} />
        <p className="text-xs text-ink-muted">
          Beside each node: firstpos on the left, lastpos on the right. A dashed circle is nullable.
        </p>
        <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
          <DataTable
            caption="The followpos table"
            headers={['Position', 'followpos']}
            rows={followRows(state)}
          />
          {state.rows.length > 0 ? (
            <DataTable
              caption="The DFA transition table so far"
              headers={['DFA', 'Positions', ...state.alphabet]}
              rows={dstateRows(state)}
              activeRow={state.activeRow}
              activeColumn={state.activeSymbol === null ? null : state.activeSymbol + 2}
            />
          ) : null}
        </div>
      </div>
    ),
    [layout],
  );

  const followHeader = ['Position', 'followpos'];
  const followSize = measureTable([followHeader, ...followRows(final)]);

  return (
    <Player
      trace={trace}
      name="followpos"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: Math.max(layout.width, followSize.width),
        height: layout.height + followSize.height + 12,
        render: ({ state }) => (
          <>
            <SyntaxTree state={state} layout={layout} />
            <SvgTable y={layout.height + 12} rows={[followHeader, ...followRows(state)]} />
          </>
        ),
      }}
    />
  );
}

export default function Followpos({ initial, onUsed }: VisualizerProps) {
  const [regex, setRegex] = useState(initial?.regex ?? '(a|b)*abb');
  const settled = useDebouncedValue(regex);
  const { data } = useEngineJob('direct', { regex: settled });
  useAiVisualizerInput(settled);

  return (
    <div className="space-y-3">
      <RegexField value={regex} onChange={setRegex} presets={PRESETS} />
      <JobResult result={data} source={settled}>
        {({ trace }) => <Result key={settled} trace={trace} onUsed={onUsed} />}
      </JobResult>
    </div>
  );
}
