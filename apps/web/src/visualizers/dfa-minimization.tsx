import type { Dfa, MinimizeState, TraceStep } from '@compilerlab/engine';
import { useCallback, useMemo, useState } from 'react';
import { useAiVisualizerInput } from '@/ai/context-store';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import { AutomatonGraph, dfaEdges, type GraphNode } from './graph/automaton-graph';
import { layoutGraph } from './graph/layout';
import { measureTable, SvgTable } from './player/export-frame';
import { Player } from './player/player';
import { categoricalColor, JobResult, RegexField, type VisualizerProps } from './shared';

const PRESETS = ['(a|b)*abb', 'a*|a*b', '(a|b)(a|b)', 'ab|ac'];

function layoutOf(dfa: Dfa) {
  return layoutGraph(
    Array.from({ length: dfa.stateCount }, (_, i) => i),
    dfaEdges(dfa),
    dfa.start,
  );
}

function plainNodes(dfa: Dfa): GraphNode[] {
  return dfa.names.map((label, key) => ({
    key,
    label,
    start: key === dfa.start,
    accepting: dfa.accepts.includes(key),
  }));
}

function blockRows(state: MinimizeState) {
  return [
    ['Block', 'States'],
    ...state.blocks.map((block, index) => [
      String(index + 1),
      block.states.map((key) => state.names[key]).join(', '),
    ]),
  ];
}

function Result({
  source,
  minimal,
  trace,
  onUsed,
}: {
  source: Dfa;
  minimal: Dfa;
  trace: readonly TraceStep<MinimizeState>[];
  onUsed: (() => void) | undefined;
}) {
  const layout = useMemo(() => layoutOf(source), [source]);
  const edges = useMemo(() => dfaEdges(source), [source]);
  const minimalLayout = useMemo(() => layoutOf(minimal), [minimal]);
  const minimalEdges = useMemo(() => dfaEdges(minimal), [minimal]);

  const nodesFor = useCallback(
    (state: MinimizeState): GraphNode[] => {
      const blockOf = new Map(
        state.blocks.flatMap((block) => block.states.map((key) => [key, block.id] as const)),
      );
      const lit = new Set(state.preimage);
      return plainNodes(source).map((node) => ({
        ...node,
        color: categoricalColor(blockOf.get(node.key) ?? 0),
        tone: lit.has(node.key) ? 'active' : 'idle',
      }));
    },
    [source],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<MinimizeState>) => {
      const splitter = new Set(state.splitter ?? []);
      return (
        <div className="space-y-3">
          <AutomatonGraph
            nodes={nodesFor(state)}
            edges={edges}
            layout={layout}
            title="The DFA, with each state colored by its block"
          />
          <ul aria-label="The current partition" className="flex flex-wrap gap-2">
            {state.blocks.map((block) => (
              <li
                key={block.id}
                className="rounded-md border-2 px-2 py-1 font-mono text-[0.8125rem]"
                style={{ borderColor: categoricalColor(block.id) }}
              >
                {'{'}
                {block.states.map((key, index) => (
                  <span key={key} className={splitter.has(key) ? 'font-bold text-accent' : ''}>
                    {index > 0 ? ', ' : ''}
                    {state.names[key]}
                  </span>
                ))}
                {'}'}
              </li>
            ))}
          </ul>
          {state.done ? (
            <div>
              <p className="mb-1 text-sm font-semibold">The minimal DFA</p>
              <AutomatonGraph
                nodes={plainNodes(minimal)}
                edges={minimalEdges}
                layout={minimalLayout}
                title="The minimal DFA"
              />
            </div>
          ) : null}
        </div>
      );
    },
    [edges, layout, minimal, minimalEdges, minimalLayout, nodesFor],
  );

  const lastState = (trace.at(-1) as TraceStep<MinimizeState>).state;
  const tableSize = measureTable(blockRows(lastState));

  return (
    <Player
      trace={trace}
      name="dfa-minimization"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: Math.max(layout.width, tableSize.width),
        height: layout.height + tableSize.height + 12,
        render: ({ state }) => (
          <>
            <AutomatonGraph
              nodes={nodesFor(state)}
              edges={edges}
              layout={layout}
              animated={false}
            />
            <SvgTable y={layout.height + 12} rows={blockRows(state)} />
          </>
        ),
      }}
    />
  );
}

export default function DfaMinimization({ initial, onUsed }: VisualizerProps) {
  const [regex, setRegex] = useState(initial?.regex ?? '(a|b)*abb');
  const settled = useDebouncedValue(regex);
  const { data } = useEngineJob('minimize', { regex: settled });
  useAiVisualizerInput(settled);

  return (
    <div className="space-y-3">
      <RegexField value={regex} onChange={setRegex} presets={PRESETS} />
      <JobResult result={data} source={settled}>
        {({ source, minimal, trace }) => (
          <Result key={settled} source={source} minimal={minimal} trace={trace} onUsed={onUsed} />
        )}
      </JobResult>
    </div>
  );
}
