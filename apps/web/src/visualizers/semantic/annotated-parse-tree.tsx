import type { SddEvalResult, SddEvalState, SddToken, TraceStep } from '@compilerlab/engine';
import { useCallback, useMemo } from 'react';
import { useEngineJob } from '../engine/use-engine';
import { ProblemList } from '../parsing/grammar-field';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { ChipList, PartLabel, ScrollRegion } from './playground';
import { DESK_CALCULATOR, SDD_PRESETS } from './presets';
import {
  AttributeKinds,
  attrSlots,
  ClassificationPanel,
  cycleText,
  DependencyArrows,
  SddInputs,
  SddResult,
  SddWarnings,
  sddTreeRoot,
  showValue,
  useSddInputs,
  valueChipText,
} from './sdd-views';
import {
  shorten,
  SourceView,
  SVG_NOTE_HEIGHT,
  SvgNotes,
  svgNotesWidth,
  type SvgNote,
  type TextSpan,
} from './source-view';
import { layoutSyntaxTree, SyntaxTreeSvg, type TreeChip } from './syntax-tree';

const NOTE_LINES = 2;

/** The part of the input a node covers. An ε node covers nothing. */
function nodeSpan(run: SddEvalResult, nodeId: number | null): TextSpan | null {
  const node = nodeId === null ? undefined : run.nodes[nodeId];
  if (!node || node.to <= node.from) return null;
  return {
    start: (run.tokens[node.from] as SddToken).start,
    end: (run.tokens[node.to - 1] as SddToken).end,
  };
}

function Result({
  output,
  text,
  onUsed,
}: {
  output: SddEvalResult;
  text: string;
  onUsed: (() => void) | undefined;
}) {
  const { attrs, edges, trace, cycle } = output;
  const root = useMemo(() => sddTreeRoot(output), [output]);
  const slots = useMemo(() => attrSlots(attrs), [attrs]);
  const layout = useMemo(
    () =>
      layoutSyntaxTree(root, (id) =>
        (slots.byNode.get(id) ?? []).map((attr) => valueChipText(attr, output.values[attr.id])),
      ),
    [root, slots, output],
  );

  // The graph and the sort have their own visualizer, so this one goes straight to the values.
  const steps = useMemo(
    () =>
      trace.filter(
        ({ state }) =>
          state.phase === 'parse' ||
          state.phase === 'evaluate' ||
          state.phase === 'finished' ||
          state.cycle !== null,
      ),
    [trace],
  );

  const chipsFor = useCallback(
    (state: SddEvalState) =>
      (id: number): readonly (TreeChip | null)[] =>
        (slots.byNode.get(id) ?? []).map((attr) => {
          if (attr.id >= state.attrCount) return null;
          const value = state.values[attr.id] ?? null;
          const reads = edges.some(
            (edge) => edge.from === attr.id && edge.to === state.currentAttr,
          );
          const tone = state.cycle?.includes(attr.id)
            ? ('danger' as const)
            : attr.id === state.currentAttr
              ? ('active' as const)
              : reads
                ? ('source' as const)
                : value !== null
                  ? ('done' as const)
                  : null;
          return {
            key: `${attr.id}:${showValue(value)}`,
            text: valueChipText(attr, value),
            tone,
          };
        }),
    [slots, edges],
  );

  const toneFor = useCallback(
    (state: SddEvalState) => (id: number) =>
      id === state.currentNode ? ('active' as const) : null,
    [],
  );

  const overlayFor = useCallback(
    (state: SddEvalState) =>
      state.currentAttr === null ? null : (
        <DependencyArrows
          layout={layout}
          attrs={attrs}
          slots={slots}
          edges={edges}
          toneOf={(edge) => (edge.to === state.currentAttr ? 'active' : null)}
        />
      ),
    [layout, attrs, slots, edges],
  );

  const notesFor = useCallback(
    (state: SddEvalState): SvgNote[] => {
      const attr = state.currentAttr === null ? undefined : attrs[state.currentAttr];
      return [
        { text: attr?.ruleText ? `Rule: ${shorten(attr.ruleText, 70)}` : ' ', bold: true },
        {
          text:
            state.effects.length > 0
              ? `Side effects so far: ${shorten(state.effects.join('; '), 70)}`
              : ' ',
        },
      ];
    },
    [attrs],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<SddEvalState>) => {
      const attr = state.currentAttr === null ? undefined : attrs[state.currentAttr];
      return (
        <div className="space-y-3">
          <div>
            <PartLabel>Input, with the current node&apos;s part highlighted</PartLabel>
            <SourceView source={text} span={nodeSpan(output, state.currentNode)} label="Input" />
          </div>
          <ScrollRegion label="The parse tree, with its attributes">
            <SyntaxTreeSvg
              layout={layout}
              tone={toneFor(state)}
              chips={chipsFor(state)}
              overlay={overlayFor(state)}
              title={`The annotated parse tree. ${state.order.length} of ${attrs.length} attributes are in the order.`}
            />
          </ScrollRegion>
          {attr?.ruleText ? (
            <p className="rounded-sm bg-surface-2 px-2 py-1 text-sm">
              <span className="text-ink-muted">Rule: </span>
              <code className="font-mono text-[0.8125rem] break-words">{attr.ruleText}</code>
              {attr.production !== null ? (
                <span className="text-xs text-ink-muted">
                  {' '}
                  from {output.spec.productions[attr.production]?.text}
                </span>
              ) : null}
            </p>
          ) : null}
          {state.phase === 'evaluate' || state.phase === 'finished' ? (
            <div>
              <PartLabel>Evaluation order, with the values so far</PartLabel>
              <ChipList
                label="Attributes in evaluation order"
                items={state.order
                  .filter((id) => state.values[id] !== null || id === state.currentAttr)
                  .map((id) => {
                    const item = attrs[id];
                    return {
                      key: String(id),
                      text:
                        item?.kind === 'effect'
                          ? shorten(item.label, 28)
                          : `${item?.label} = ${shorten(showValue(state.values[id]), 28)}`,
                      active: id === state.currentAttr,
                    };
                  })}
              />
            </div>
          ) : null}
          {state.effects.length > 0 ? (
            <div>
              <PartLabel>Side effects, in the order they ran</PartLabel>
              <ChipList
                label="Side effects"
                items={state.effects.map((effect, index) => ({
                  key: String(index),
                  text: effect,
                }))}
              />
            </div>
          ) : null}
        </div>
      );
    },
    [attrs, output, text, layout, toneFor, chipsFor, overlayFor],
  );

  const noteWidth = useMemo(
    () => Math.max(...steps.map(({ state }) => svgNotesWidth(notesFor(state)))),
    [steps, notesFor],
  );

  return (
    <div className="space-y-3">
      <SddWarnings warnings={output.warnings} />
      <ClassificationPanel classification={output.classification} />
      <AttributeKinds attributes={output.attributes} />
      <Player
        trace={steps}
        name="annotated-parse-tree"
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
        label="This definition has a cycle"
        problems={
          cycle
            ? [
                {
                  key: 'cycle',
                  message: `Each of these waits for the next, so no order can evaluate them: ${cycleText(cycle, attrs)}.`,
                },
              ]
            : []
        }
        question={(message) => `My syntax-directed definition has a problem. ${message} Why?`}
      />
      <ProblemList
        label="Attributes with no value"
        problems={output.problems.map((message, index) => ({ key: String(index), message }))}
        question={(message) => `My syntax-directed definition has this problem: ${message} Why?`}
      />
    </div>
  );
}

/** Enter an SDD and an input, then watch the attributes fill in on the tree, in evaluation order. */
export default function AnnotatedParseTree({ initial, onUsed }: VisualizerProps) {
  const { spec, setSpec, text, setText, settledSpec, settledText, input } = useSddInputs(
    initial,
    DESK_CALCULATOR,
  );
  const { data } = useEngineJob('sddEvaluate', input);

  return (
    <div className="space-y-3">
      <SddInputs spec={spec} onSpec={setSpec} text={text} onText={setText} presets={SDD_PRESETS} />
      <SddResult result={data} spec={settledSpec} text={settledText}>
        {(output) => (
          <Result
            key={`${settledSpec}\n${settledText}`}
            output={output}
            text={settledText}
            onUsed={onUsed}
          />
        )}
      </SddResult>
    </div>
  );
}
