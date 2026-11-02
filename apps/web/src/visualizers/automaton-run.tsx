import type { SimulationState, TraceStep } from '@compilerlab/engine';
import { useCallback, useId, useMemo, useState } from 'react';
import { Input } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import type { JobOutput, Machine } from './engine/jobs';
import { AutomatonGraph, dfaEdges, nfaEdges, type GraphNode } from './graph/automaton-graph';
import { layoutGraph } from './graph/layout';
import { Player } from './player/player';
import { JobResult, RegexField, type VisualizerProps } from './shared';
import { Tape, tapeSize } from './tape';

const MACHINE_OPTIONS = [
  { value: 'nfa', label: 'NFA' },
  { value: 'dfa', label: 'DFA' },
  { value: 'minimal', label: 'Minimal DFA' },
] as const;

function Result({
  output,
  onUsed,
}: {
  output: JobOutput<'run'>;
  onUsed: (() => void) | undefined;
}) {
  const { nfa, dfa, simulation } = output;
  const base = useMemo<GraphNode[]>(() => {
    if (nfa) {
      return Array.from({ length: nfa.stateCount }, (_, key) => ({
        key,
        label: String(key),
        start: key === nfa.start,
        accepting: nfa.accepts.includes(key),
      }));
    }
    if (!dfa) return [];
    return dfa.names.map((label, key) => ({
      key,
      label,
      start: key === dfa.start,
      accepting: dfa.accepts.includes(key),
    }));
  }, [nfa, dfa]);
  const edges = useMemo(() => (nfa ? nfaEdges(nfa) : dfa ? dfaEdges(dfa) : []), [nfa, dfa]);
  const layout = useMemo(
    () =>
      layoutGraph(
        base.map((node) => node.key),
        edges,
        nfa?.start ?? dfa?.start ?? 0,
      ),
    [base, edges, nfa, dfa],
  );

  const nodesFor = useCallback(
    (state: SimulationState): GraphNode[] => {
      const lit = new Set(state.active);
      return base.map((node) => ({ ...node, tone: lit.has(node.key) ? 'active' : 'idle' }));
    },
    [base],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<SimulationState>) => (
      <div className="space-y-2">
        <Tape state={state} />
        <AutomatonGraph nodes={nodesFor(state)} edges={edges} layout={layout} />
      </div>
    ),
    [edges, layout, nodesFor],
  );

  const first = simulation.trace[0] as TraceStep<SimulationState>;
  const tape = tapeSize(first.state.input.length);

  return (
    <Player
      trace={simulation.trace}
      name="automaton-run"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: Math.max(layout.width, tape.width),
        height: layout.height + tape.height,
        render: ({ state }) => (
          <>
            <Tape state={state} />
            <AutomatonGraph
              nodes={nodesFor(state)}
              edges={edges}
              layout={layout}
              animated={false}
              y={tape.height}
            />
          </>
        ),
      }}
    />
  );
}

export default function AutomatonRun({ initial, onUsed }: VisualizerProps) {
  const [regex, setRegex] = useState(initial?.regex ?? '(a|b)*abb');
  const [text, setText] = useState(initial?.text ?? 'aabb');
  const [machine, setMachine] = useState<Machine>(
    initial?.machine === 'nfa' || initial?.machine === 'minimal' ? initial.machine : 'dfa',
  );
  const settledRegex = useDebouncedValue(regex);
  const settledText = useDebouncedValue(text);
  const { data } = useEngineJob('run', { regex: settledRegex, text: settledText, machine });
  const textId = useId();

  return (
    <div className="space-y-3">
      <RegexField value={regex} onChange={setRegex} presets={['(a|b)*abb', 'a*b', '[0-9]+']} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1">
          <label htmlFor={textId} className="mb-1 block text-sm font-medium">
            Input string
          </label>
          <Input
            id={textId}
            value={text}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <Segmented
          name="machine"
          legend="Which machine to run"
          value={machine}
          options={MACHINE_OPTIONS}
          onChange={setMachine}
        />
      </div>
      <JobResult result={data} source={settledRegex}>
        {(output) => (
          <Result
            key={`${settledRegex}\n${settledText}\n${machine}`}
            output={output}
            onUsed={onUsed}
          />
        )}
      </JobResult>
    </div>
  );
}
