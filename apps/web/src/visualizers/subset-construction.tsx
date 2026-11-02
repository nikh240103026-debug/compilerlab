import {
  formatStateSet,
  NO_TRANSITION,
  type Nfa,
  type SubsetState,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useMemo, useState } from 'react';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import { AutomatonGraph, nfaEdges, type GraphNode } from './graph/automaton-graph';
import { layoutGraph } from './graph/layout';
import { measureTable, SvgTable } from './player/export-frame';
import { Player } from './player/player';
import { DataTable, JobResult, RegexField, type VisualizerProps } from './shared';

const PRESETS = ['(a|b)*abb', 'a(b|c)*', '(a|b)*a(a|b)', 'a*b*'];

function tableRows(state: SubsetState) {
  return state.rows.map((row, rowIndex) => [
    `${rowIndex === 0 ? '→ ' : ''}${row.accepting ? '* ' : ''}${row.name}`,
    formatStateSet(row.nfaStates),
    ...row.cells.map((cell) => {
      if (cell === null) return '';
      return cell === NO_TRANSITION ? '–' : (state.rows[cell]?.name ?? '');
    }),
  ]);
}

function Result({
  nfa,
  trace,
  onUsed,
}: {
  nfa: Nfa;
  trace: readonly TraceStep<SubsetState>[];
  onUsed: (() => void) | undefined;
}) {
  const layout = useMemo(
    () =>
      layoutGraph(
        Array.from({ length: nfa.stateCount }, (_, i) => i),
        nfa.transitions,
        nfa.start,
      ),
    [nfa],
  );
  const edges = useMemo(() => nfaEdges(nfa), [nfa]);

  const nodesFor = useCallback(
    (state: SubsetState): GraphNode[] => {
      const lit = new Set(state.highlight);
      return Array.from({ length: nfa.stateCount }, (_, key) => ({
        key,
        label: String(key),
        start: key === nfa.start,
        accepting: nfa.accepts.includes(key),
        tone: lit.has(key) ? 'active' : 'idle',
      }));
    },
    [nfa],
  );

  const renderStage = useCallback(
    (step: TraceStep<SubsetState>) => {
      const { state } = step;
      return (
        <div className="space-y-3">
          <AutomatonGraph
            nodes={nodesFor(state)}
            edges={edges}
            layout={layout}
            title="The NFA, with the current set of states lit up"
          />
          <DataTable
            caption="The DFA transition table so far"
            headers={['DFA', 'NFA states', ...state.alphabet]}
            rows={tableRows(state)}
            activeRow={state.currentRow}
            activeColumn={state.currentSymbol === null ? null : state.currentSymbol + 2}
          />
        </div>
      );
    },
    [edges, layout, nodesFor],
  );

  const finalState = (trace.at(-1) as TraceStep<SubsetState>).state;
  const header = ['DFA', 'NFA states', ...finalState.alphabet];
  const tableSize = measureTable([header, ...tableRows(finalState)]);

  return (
    <Player
      trace={trace}
      name="subset-construction"
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
            <SvgTable
              y={layout.height + 12}
              rows={[header, ...tableRows(state)]}
              active={
                state.currentRow !== null && state.currentSymbol !== null
                  ? [state.currentRow + 1, state.currentSymbol + 2]
                  : null
              }
            />
          </>
        ),
      }}
    />
  );
}

export default function SubsetConstruction({ initial, onUsed }: VisualizerProps) {
  const [regex, setRegex] = useState(initial?.regex ?? '(a|b)*abb');
  const settled = useDebouncedValue(regex);
  const { data } = useEngineJob('subset', { regex: settled });

  return (
    <div className="space-y-3">
      <RegexField value={regex} onChange={setRegex} presets={PRESETS} />
      <JobResult result={data} source={settled}>
        {({ nfa, trace }) => <Result key={settled} nfa={nfa} trace={trace} onUsed={onUsed} />}
      </JobResult>
    </div>
  );
}
