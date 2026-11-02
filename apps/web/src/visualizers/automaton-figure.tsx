import { useMemo } from 'react';
import { useEngineJob } from './engine/use-engine';
import type { Machine } from './engine/jobs';
import { AutomatonGraph, dfaEdges, nfaEdges, type GraphNode } from './graph/automaton-graph';
import { layoutGraph } from './graph/layout';
import { JobResult } from './shared';

/**
 * A diagram in a lesson. The engine computes it from the expression, so a figure can never
 * disagree with the algorithm the lesson describes.
 */
export default function AutomatonFigure({
  regex,
  show = 'dfa',
  caption,
}: {
  regex: string;
  show?: Machine;
  caption?: string;
}) {
  const input = useMemo(() => ({ regex, show }), [regex, show]);
  const { data } = useEngineJob('figure', input);
  return (
    <figure className="my-4 rounded-md border border-line bg-surface p-2">
      <JobResult result={data} source={regex}>
        {({ nfa, dfa }) => {
          const nodes: GraphNode[] = nfa
            ? Array.from({ length: nfa.stateCount }, (_, key) => ({
                key,
                label: String(key),
                start: key === nfa.start,
                accepting: nfa.accepts.includes(key),
              }))
            : (dfa?.names ?? []).map((label, key) => ({
                key,
                label,
                start: key === dfa?.start,
                accepting: dfa?.accepts.includes(key) ?? false,
              }));
          const edges = nfa ? nfaEdges(nfa) : dfa ? dfaEdges(dfa) : [];
          const layout = layoutGraph(
            nodes.map((node) => node.key),
            edges,
            nfa?.start ?? dfa?.start ?? 0,
          );
          return <AutomatonGraph nodes={nodes} edges={edges} layout={layout} />;
        }}
      </JobResult>
      {caption ? (
        <figcaption className="mt-1 text-center text-xs text-ink-muted">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
