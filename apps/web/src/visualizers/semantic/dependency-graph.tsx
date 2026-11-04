import type {
  SddAttrInstance,
  SddDependencyEdge,
  SddEvalResult,
  SddEvalState,
  Trace,
  TraceStep,
} from '@compilerlab/engine';
import { useCallback, useMemo } from 'react';
import { useEngineJob } from '../engine/use-engine';
import { ProblemList } from '../parsing/grammar-field';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { ChipList, PartLabel, ScrollRegion } from './playground';
import { DESK_CALCULATOR, SDD_PRESETS } from './presets';
import {
  AttributeKinds,
  attrName,
  attrSlots,
  ClassificationPanel,
  cycleText,
  DependencyArrows,
  SddInputs,
  SddProblem,
  SddResult,
  SddWarnings,
  sddTreeRoot,
  useSddInputs,
  type ArrowTone,
} from './sdd-views';
import { shorten, SVG_NOTE_HEIGHT, SvgNotes, svgNotesWidth, type SvgNote } from './source-view';
import { layoutSyntaxTree, SyntaxTreeSvg, type TreeChip } from './syntax-tree';

const NOTE_LINES = 2;

/** Parses the input, builds the graph, and sorts it, then says what the order means. */
function graphTrace(run: SddEvalResult): Trace<SddEvalState> {
  const steps = run.trace.filter(({ state }) => state.phase === 'parse' || state.phase === 'graph');
  const sorting = run.trace.filter(({ state }) => state.phase === 'order');
  const last = sorting.at(-1);
  if (run.cycle || !last) return [...steps, ...sorting];
  const closing: TraceStep<SddEvalState> = {
    title: 'The evaluation order',
    explanation:
      run.order.length > 0
        ? `Every attribute is in the order, so the graph has no cycle. Evaluating them in this order always has each attribute's inputs ready. Other orders can work too, as long as every edge goes forward.`
        : 'This tree has no attributes, so there is nothing to order.',
    state: { ...last.state, currentAttr: null, currentNode: null },
  };
  return [...steps, ...sorting, closing];
}

function Result({ output, onUsed }: { output: SddEvalResult; onUsed: (() => void) | undefined }) {
  const { attrs, edges, cycle } = output;
  const root = useMemo(() => sddTreeRoot(output), [output]);
  const slots = useMemo(() => attrSlots(attrs), [attrs]);
  const steps = useMemo(() => graphTrace(output), [output]);
  const layout = useMemo(
    () =>
      layoutSyntaxTree(root, (id) =>
        (slots.byNode.get(id) ?? []).map((attr) => `${attrName(attr)} (${attrs.length})`),
      ),
    [root, slots, attrs],
  );

  const cycleEdges = useMemo(() => {
    const keys = new Set<string>();
    if (cycle) {
      cycle.forEach((id, index) => {
        keys.add(`${id}>${cycle[(index + 1) % cycle.length] as number}`);
      });
    }
    return keys;
  }, [cycle]);

  const chipText = useCallback((attr: SddAttrInstance, state: SddEvalState): string => {
    const name = attrName(attr);
    const place = state.order.indexOf(attr.id);
    if (place >= 0) return `#${place + 1} ${name}`;
    const waiting = state.inDegree[attr.id] ?? 0;
    return waiting > 0 ? `${name} (${waiting})` : name;
  }, []);

  const chipsFor = useCallback(
    (state: SddEvalState) =>
      (id: number): readonly (TreeChip | null)[] =>
        (slots.byNode.get(id) ?? []).map((attr) => {
          if (attr.id >= state.attrCount) return null;
          const tone = state.cycle?.includes(attr.id)
            ? ('danger' as const)
            : attr.id === state.currentAttr
              ? ('active' as const)
              : state.ready.includes(attr.id)
                ? ('ready' as const)
                : state.order.includes(attr.id)
                  ? ('done' as const)
                  : null;
          return { key: String(attr.id), text: chipText(attr, state), tone };
        }),
    [slots, chipText],
  );

  const arrowTone = useCallback(
    (state: SddEvalState) =>
      (edge: SddDependencyEdge): ArrowTone => {
        if (state.cycle && cycleEdges.has(`${edge.from}>${edge.to}`)) return 'danger';
        if (state.phase === 'graph') return edge.to === state.currentAttr ? 'active' : 'muted';
        if (edge.from === state.currentAttr) return 'active';
        return state.order.includes(edge.from) ? 'removed' : 'muted';
      },
    [cycleEdges],
  );

  const overlayFor = useCallback(
    (state: SddEvalState) => (
      <DependencyArrows
        layout={layout}
        attrs={attrs}
        slots={slots}
        edges={edges.slice(0, state.edgeCount)}
        toneOf={arrowTone(state)}
      />
    ),
    [layout, attrs, slots, edges, arrowTone],
  );

  const toneFor = useCallback(
    (state: SddEvalState) => (id: number) =>
      id === state.currentNode ? ('active' as const) : null,
    [],
  );

  const labelsOf = useCallback(
    (ids: readonly number[]) => ids.map((id) => (attrs[id] as SddAttrInstance).label),
    [attrs],
  );

  const notesFor = useCallback(
    (state: SddEvalState): SvgNote[] => [
      {
        text: state.cycle
          ? `Cycle: ${shorten(cycleText(state.cycle, attrs), 80)}`
          : `Order: ${shorten(labelsOf(state.order).join(', ') || 'none yet', 80)}`,
        bold: true,
        ...(state.cycle ? { fill: 'var(--danger)' } : {}),
      },
      {
        text:
          state.ready.length > 0 ? `Ready: ${shorten(labelsOf(state.ready).join(', '), 80)}` : ' ',
      },
    ],
    [attrs, labelsOf],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<SddEvalState>) => (
      <div className="space-y-3">
        <ScrollRegion label="The dependency graph, drawn over the parse tree">
          <SyntaxTreeSvg
            layout={layout}
            tone={toneFor(state)}
            chips={chipsFor(state)}
            overlay={overlayFor(state)}
            title={`The dependency graph over the parse tree: ${state.attrCount} attributes and ${state.edgeCount} edges so far.`}
          />
        </ScrollRegion>
        <p className="text-xs text-ink-muted">
          An arrow means the attribute it points to needs the one it leaves. #3 means third in the
          order. (2) means it still waits for two inputs. Green is ready now.
        </p>
        {state.phase === 'order' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <PartLabel>Ready, with nothing left to wait for</PartLabel>
              <ChipList
                label="Attributes that are ready"
                empty="Nothing is ready."
                items={state.ready.map((id) => ({
                  key: String(id),
                  text: (attrs[id] as SddAttrInstance).label,
                  tone: 'added' as const,
                }))}
              />
            </div>
            <div>
              <PartLabel>The topological order so far</PartLabel>
              <ChipList
                label="The topological order"
                items={state.order.map((id, index) => ({
                  key: String(id),
                  text: `${index + 1}. ${(attrs[id] as SddAttrInstance).label}`,
                  active: id === state.currentAttr,
                }))}
              />
            </div>
          </div>
        ) : null}
      </div>
    ),
    [attrs, layout, toneFor, chipsFor, overlayFor],
  );

  const noteWidth = useMemo(
    () => Math.max(...steps.map(({ state }) => svgNotesWidth(notesFor(state)))),
    [steps, notesFor],
  );

  return (
    <div className="space-y-3">
      <SddWarnings warnings={output.warnings} />
      <Player
        trace={steps}
        name="dependency-graph"
        renderStage={renderStage}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          width: Math.max(layout.width, noteWidth),
          height: layout.height + SVG_NOTE_HEIGHT * NOTE_LINES,
          render: ({ state }) => (
            <>
              <SyntaxTreeSvg
                layout={layout}
                tone={toneFor(state)}
                chips={chipsFor(state)}
                overlay={overlayFor(state)}
                animated={false}
              />
              <SvgNotes notes={notesFor(state)} y={layout.height} x={8} />
            </>
          ),
        }}
      />
      <ProblemList
        label="A cycle: no evaluation order exists"
        problems={
          cycle
            ? [
                {
                  key: 'cycle',
                  message: `The sort stopped early, because each of these waits for the next: ${cycleText(cycle, attrs)}.`,
                },
              ]
            : []
        }
        question={(message) => `My dependency graph has a cycle. ${message} How do I fix it?`}
      />
    </div>
  );
}

/**
 * The dependency graph over the parse tree, a topological order by Kahn's algorithm, any cycle, and
 * whether the definition is S-attributed or L-attributed. That verdict needs no input, so it stays
 * on screen even while the input does not parse.
 */
export default function DependencyGraph({ initial, onUsed }: VisualizerProps) {
  const { spec, setSpec, text, setText, settledSpec, settledText, input } = useSddInputs(
    initial,
    DESK_CALCULATOR,
  );
  const analysisInput = useMemo(() => ({ spec: settledSpec }), [settledSpec]);
  const { data: analysis } = useEngineJob('sddAnalyze', analysisInput);
  const { data } = useEngineJob('sddEvaluate', input);
  const definitionFailed = analysis?.ok === false;

  return (
    <div className="space-y-3">
      <SddInputs spec={spec} onSpec={setSpec} text={text} onText={setText} presets={SDD_PRESETS} />
      {analysis?.ok ? (
        <>
          <ClassificationPanel classification={analysis.value.classification} detailed />
          <AttributeKinds attributes={analysis.value.attributes} />
        </>
      ) : null}
      {definitionFailed ? (
        <SddProblem error={analysis.error} spec={settledSpec} text={settledText} />
      ) : (
        <SddResult result={data} spec={settledSpec} text={settledText}>
          {(output) => (
            <Result key={`${settledSpec}\n${settledText}`} output={output} onUsed={onUsed} />
          )}
        </SddResult>
      )}
    </div>
  );
}
