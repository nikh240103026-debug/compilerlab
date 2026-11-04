import type { GrammarDerivationOrder, GrammarDerivationStep, TraceStep } from '@compilerlab/engine';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/cn';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { GrammarField, GrammarResult, SentenceField } from './grammar-field';
import type { DerivationOutput } from './jobs';
import { layoutForest, ParseForest } from './parse-forest';
import {
  AMBIGUOUS_EXPRESSION,
  BALANCED,
  EXPRESSION,
  EXPRESSION_LL,
  TWO_C,
  type GrammarPreset,
} from './presets';

const PRESETS = [EXPRESSION, EXPRESSION_LL, TWO_C, BALANCED, AMBIGUOUS_EXPRESSION];
const LINE_HEIGHT = 20;
const CHAR_WIDTH = 7.6;
const GAP = 24;

function FormLine({
  step,
  prefix,
  current,
}: {
  step: GrammarDerivationStep;
  prefix: string;
  current: boolean;
}) {
  return (
    <li className={cn('rounded-sm px-1', current && 'bg-accent-soft')}>
      <span className="text-ink-muted">{prefix}</span>
      {step.form.length === 0 ? <span className="text-ink-muted">ε</span> : null}
      {step.form.map((symbol, index) => {
        const isNew = current && index >= step.changedFrom && index < step.changedTo;
        return (
          <Fragment key={index}>
            {index > 0 ? ' ' : ''}
            <span className={isNew ? 'font-semibold text-accent' : undefined}>{symbol}</span>
          </Fragment>
        );
      })}
    </li>
  );
}

function Result({
  output,
  onUsed,
}: {
  output: DerivationOutput;
  onUsed: (() => void) | undefined;
}) {
  const [order, setOrder] = useState<GrammarDerivationOrder>('leftmost');
  const [which, setWhich] = useState(0);
  const chosen = output.trees[which] ?? (output.trees[0] as DerivationOutput['trees'][number]);
  const derivation = order === 'leftmost' ? chosen.leftmost : chosen.rightmost;
  const { tree } = chosen;
  const layout = useMemo(() => layoutForest(tree.nodes, [tree.root]), [tree]);
  const nonterminals = useMemo(() => new Set(output.grammar.nonterminals), [output]);
  const arrow = order === 'leftmost' ? '⇒lm ' : '⇒rm ';

  const toneOf = useCallback(
    (step: GrammarDerivationStep) => (id: number) =>
      id === step.expandedNode ? ('active' as const) : null,
    [],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<{ index: number }>) => {
      const step = derivation.steps[state.index] as GrammarDerivationStep;
      return (
        <div className="@container">
          <div className="grid gap-3 @2xl:grid-cols-2">
            <div className="min-w-0 overflow-x-auto">
              <p className="mb-1 text-xs font-medium text-ink-muted">Parse tree</p>
              <ParseForest
                nodes={tree.nodes}
                layout={layout}
                revealed={step.revealed}
                tone={toneOf(step)}
                nonterminals={nonterminals}
              />
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-xs font-medium text-ink-muted">
                {order === 'leftmost' ? 'Leftmost' : 'Rightmost'} derivation
              </p>
              <ol className="space-y-0.5 overflow-x-auto font-mono text-[0.8125rem] whitespace-pre">
                {derivation.steps.slice(0, state.index + 1).map((line, index) => (
                  <FormLine
                    key={index}
                    step={line}
                    prefix={index === 0 ? '' : arrow}
                    current={index === state.index}
                  />
                ))}
              </ol>
            </div>
          </div>
        </div>
      );
    },
    [derivation, tree, layout, order, arrow, toneOf, nonterminals],
  );

  const longest = Math.max(
    ...derivation.steps.map(({ form }) => form.join(' ').length + arrow.length),
  );
  const listWidth = longest * CHAR_WIDTH + 16;
  const listHeight = derivation.steps.length * LINE_HEIGHT + 16;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="derivation-order"
          legend="Which derivation to show"
          value={order}
          options={[
            { value: 'leftmost', label: 'Leftmost' },
            { value: 'rightmost', label: 'Rightmost' },
          ]}
          onChange={setOrder}
        />
        {output.trees.length > 1 ? (
          <>
            <Segmented
              name="derivation-tree"
              legend="Which parse tree to show"
              value={String(which)}
              options={[
                { value: '0', label: 'First tree' },
                { value: '1', label: 'Second tree' },
              ]}
              onChange={(value) => setWhich(Number(value))}
            />
            <Badge tone="danger">This sentence has more than one parse tree</Badge>
          </>
        ) : null}
      </div>
      <p className="text-sm text-ink-muted">
        Both orders build the same tree. They only differ in which nonterminal gets expanded first.
      </p>
      <Player
        key={`${order}:${which}`}
        trace={derivation.trace}
        name={`${order}-derivation`}
        renderStage={renderStage}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          width: layout.width + GAP + listWidth,
          height: Math.max(layout.height, listHeight),
          render: ({ state }) => {
            const step = derivation.steps[state.index] as GrammarDerivationStep;
            return (
              <>
                <ParseForest
                  nodes={tree.nodes}
                  layout={layout}
                  revealed={step.revealed}
                  tone={toneOf(step)}
                  nonterminals={nonterminals}
                  animated={false}
                />
                <g
                  transform={`translate(${layout.width + GAP} 0)`}
                  fontFamily="monospace"
                  fontSize={13}
                >
                  {derivation.steps.slice(0, state.index + 1).map((line, index) => (
                    <text
                      key={index}
                      y={18 + index * LINE_HEIGHT}
                      fill={index === state.index ? 'var(--accent)' : 'var(--ink)'}
                      fontWeight={index === state.index ? 700 : 400}
                      xmlSpace="preserve"
                    >
                      {`${index === 0 ? '' : arrow}${line.form.join(' ') || 'ε'}`}
                    </text>
                  ))}
                </g>
              </>
            );
          },
        }}
      />
    </div>
  );
}

export default function ParseTreeDerivation({ initial, onUsed }: VisualizerProps) {
  const [grammar, setGrammar] = useState(initial?.grammar ?? EXPRESSION.grammar);
  const [sentence, setSentence] = useState(initial?.sentence ?? EXPRESSION.sentence ?? '');
  const settledGrammar = useDebouncedValue(grammar, 400);
  const settledSentence = useDebouncedValue(sentence, 400);
  const input = useMemo(
    () => ({ grammar: settledGrammar, sentence: settledSentence }),
    [settledGrammar, settledSentence],
  );
  const { data } = useEngineJob('parseDerivation', input);

  const pickPreset = (preset: GrammarPreset) => {
    setGrammar(preset.grammar);
    if (preset.sentence !== undefined) setSentence(preset.sentence);
  };

  return (
    <div className="space-y-3">
      <div className="@container">
        <div className="grid gap-3 @2xl:grid-cols-2">
          <GrammarField
            value={grammar}
            onChange={setGrammar}
            presets={PRESETS}
            onPreset={pickPreset}
          />
          <SentenceField
            value={sentence}
            onChange={setSentence}
            hint="Any grammar works here, even a left-recursive or ambiguous one, because this uses a general parser."
          />
        </div>
      </div>
      <GrammarResult result={data} grammar={settledGrammar} sentence={settledSentence}>
        {(output) => (
          <Result key={`${settledGrammar}\n${settledSentence}`} output={output} onUsed={onUsed} />
        )}
      </GrammarResult>
    </div>
  );
}
