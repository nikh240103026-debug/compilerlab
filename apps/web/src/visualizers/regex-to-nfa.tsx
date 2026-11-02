import {
  isPrimedState,
  PRIMED_STATE_OFFSET,
  stateKeyLabel,
  type ThompsonState,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useMemo, useState } from 'react';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import {
  AutomatonGraph,
  edgeLabel,
  mergeEdges,
  type GraphEdge,
  type GraphNode,
} from './graph/automaton-graph';
import { layoutGraph, type GraphLayout, type Point } from './graph/layout';
import { Player } from './player/player';
import { HighlightedSource, JobResult, RegexField, type VisualizerProps } from './shared';

const PRESETS = ['(a|b)*abb', 'a|b', 'a*', 'a+b?', '(ab|c)*'];

function graphOf(state: ThompsonState): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const newStates = new Set(state.newStates);
  const newEdges = new Set(state.newTransitions);
  return {
    nodes: state.states.map((key) => ({
      key,
      label: stateKeyLabel(key),
      accepting: key === state.accept,
      start: key === state.start,
      tone: newStates.has(key) ? 'new' : 'idle',
    })),
    edges: mergeEdges(
      state.transitions.map((transition, index) => ({
        from: transition.from,
        to: transition.to,
        label: edgeLabel(transition),
        tone: newEdges.has(index) ? 'new' : 'idle',
      })),
    ),
  };
}

/** A waiting copy of a state is drawn just off the real one, then slides onto it when merged. */
function positionsWithCopies(layout: GraphLayout) {
  return (key: number): Point | undefined => {
    if (!isPrimedState(key)) return layout.positions.get(key);
    const real = layout.positions.get(key - PRIMED_STATE_OFFSET);
    return real ? { x: real.x + 30, y: real.y + 58 } : undefined;
  };
}

function Result({
  source,
  layout,
  trace,
  onUsed,
}: {
  source: string;
  layout: GraphLayout;
  trace: readonly TraceStep<ThompsonState>[];
  onUsed: (() => void) | undefined;
}) {
  const positionOf = useMemo(() => positionsWithCopies(layout), [layout]);
  const renderStage = useCallback(
    (step: TraceStep<ThompsonState>) => {
      const { nodes, edges } = graphOf(step.state);
      return (
        <>
          <HighlightedSource source={source} span={step.state.span} />
          <AutomatonGraph nodes={nodes} edges={edges} layout={layout} positionOf={positionOf} />
        </>
      );
    },
    [source, layout, positionOf],
  );
  return (
    <Player
      trace={trace}
      name="regex-to-nfa"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: layout.width,
        height: layout.height,
        render: (step) => (
          <AutomatonGraph
            {...graphOf(step.state)}
            layout={layout}
            positionOf={positionOf}
            animated={false}
          />
        ),
      }}
    />
  );
}

export default function RegexToNfa({ initial, onUsed }: VisualizerProps) {
  const [regex, setRegex] = useState(initial?.regex ?? '(a|b)*abb');
  const settled = useDebouncedValue(regex);
  const { data } = useEngineJob('thompson', { regex: settled });

  return (
    <div className="space-y-3">
      <RegexField value={regex} onChange={setRegex} presets={PRESETS} />
      <JobResult result={data} source={settled}>
        {({ nfa, trace }) => (
          <Result
            key={settled}
            source={settled}
            trace={trace}
            onUsed={onUsed}
            layout={layoutGraph(
              Array.from({ length: nfa.stateCount }, (_, i) => i),
              nfa.transitions,
              nfa.start,
            )}
          />
        )}
      </JobResult>
    </div>
  );
}
