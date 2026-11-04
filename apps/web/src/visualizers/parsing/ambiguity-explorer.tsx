import {
  DEFAULT_AMBIGUITY_LENGTH,
  MAX_AMBIGUITY_LENGTH,
  type GrammarParseTree,
  type GrammarTreeComparisonSide,
  type GrammarTreeComparisonStep,
  type Trace,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { GrammarField, GrammarResult, SentenceField } from './grammar-field';
import type { AmbiguityOutput } from './jobs';
import { layoutForest, ParseForest, type ForestLayout } from './parse-forest';
import {
  AMBIGUOUS_EXPRESSION,
  BALANCED,
  DANGLING_ELSE,
  EXPRESSION,
  PALINDROMES,
  type GrammarPreset,
} from './presets';

const PRESETS = [AMBIGUOUS_EXPRESSION, DANGLING_ELSE, PALINDROMES, EXPRESSION, BALANCED];
const GAP = 24;
const FORM_HEIGHT = 24;

function TreeSide({
  title,
  tree,
  layout,
  side,
  nonterminals,
}: {
  title: string;
  tree: GrammarParseTree;
  layout: ForestLayout;
  side: GrammarTreeComparisonSide;
  nonterminals: ReadonlySet<string>;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-ink-muted">{title}</p>
      <div className="overflow-x-auto">
        <ParseForest
          nodes={tree.nodes}
          layout={layout}
          revealed={side.step.revealed}
          tone={(id) => (id === side.step.expandedNode ? 'active' : null)}
          nonterminals={nonterminals}
        />
      </div>
      <p className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre">
        {side.step.form.join(' ') || 'ε'}
      </p>
    </div>
  );
}

function TwoTrees({
  trees,
  trace,
  nonterminals,
  onUsed,
}: {
  trees: readonly [GrammarParseTree, GrammarParseTree];
  trace: Trace<GrammarTreeComparisonStep>;
  nonterminals: ReadonlySet<string>;
  onUsed: (() => void) | undefined;
}) {
  const [first, second] = trees;
  const firstLayout = useMemo(() => layoutForest(first.nodes, [first.root]), [first]);
  const secondLayout = useMemo(() => layoutForest(second.nodes, [second.root]), [second]);

  const renderStage = useCallback(
    ({ state }: TraceStep<GrammarTreeComparisonStep>) =>
      state.left && state.right ? (
        <div className="@container">
          <div className="grid gap-3 @2xl:grid-cols-2">
            <TreeSide
              title="First parse tree"
              tree={first}
              layout={firstLayout}
              side={state.left}
              nonterminals={nonterminals}
            />
            <TreeSide
              title="Second parse tree"
              tree={second}
              layout={secondLayout}
              side={state.right}
              nonterminals={nonterminals}
            />
          </div>
        </div>
      ) : null,
    [first, second, firstLayout, secondLayout, nonterminals],
  );

  const height = Math.max(firstLayout.height, secondLayout.height) + FORM_HEIGHT;
  return (
    <Player
      trace={trace}
      name="ambiguity"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: firstLayout.width + GAP + secondLayout.width,
        height,
        render: ({ state }) =>
          state.left && state.right ? (
            <>
              <ParseForest
                nodes={first.nodes}
                layout={firstLayout}
                revealed={state.left.step.revealed}
                tone={(id) => (id === state.left?.step.expandedNode ? 'active' : null)}
                nonterminals={nonterminals}
                animated={false}
              />
              <ParseForest
                nodes={second.nodes}
                layout={secondLayout}
                revealed={state.right.step.revealed}
                tone={(id) => (id === state.right?.step.expandedNode ? 'active' : null)}
                nonterminals={nonterminals}
                animated={false}
                x={firstLayout.width + GAP}
              />
              <g fontFamily="monospace" fontSize={12} fill="var(--ink)">
                <text x={8} y={height - 8}>
                  {state.left.step.form.join(' ') || 'ε'}
                </text>
                <text x={firstLayout.width + GAP + 8} y={height - 8}>
                  {state.right.step.form.join(' ') || 'ε'}
                </text>
              </g>
            </>
          ) : (
            <></>
          ),
      }}
    />
  );
}

function Result({ output, onUsed }: { output: AmbiguityOutput; onUsed: (() => void) | undefined }) {
  const { grammar, result, sentence } = output;
  const nonterminals = useMemo(() => new Set(grammar.nonterminals), [grammar]);
  const { bound } = result;
  const askedTrees = sentence?.trees;
  const askedPair =
    sentence?.trace && askedTrees?.[0] && askedTrees[1]
      ? { trees: [askedTrees[0], askedTrees[1]] as const, trace: sentence.trace }
      : null;
  const pair =
    askedPair ?? (result.witness ? { trees: result.witness.trees, trace: result.trace } : null);
  const lone = sentence?.treeCount === 1 ? askedTrees?.[0] : undefined;
  const loneLayout = useMemo(() => (lone ? layoutForest(lone.nodes, [lone.root]) : null), [lone]);
  const shownSentence = sentence?.tokens.join(' ') || 'the empty string';

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md bg-surface-2 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={result.witness ? 'danger' : 'neutral'}>
            {result.witness ? 'Ambiguous: proved' : 'None found: this is not a proof'}
          </Badge>
        </div>
        <p>{result.message}</p>
        <p className="text-xs text-ink-muted">
          Search limits: strings of up to {bound.maxLength} tokens, at most{' '}
          {bound.maxSentences.toLocaleString()} remembered strings, and at most{' '}
          {bound.maxWork.toLocaleString()} search steps. Ambiguity cannot be decided by any program
          in general, so every search like this one has to stop somewhere.
        </p>
      </div>

      {sentence ? (
        <p role="status" className="rounded-md border border-line p-2 text-sm">
          {sentence.treeCount === 0
            ? `This grammar cannot derive ${shownSentence}.`
            : sentence.treeCount === 1
              ? `${shownSentence} has exactly one parse tree. This answer is exact, for this one sentence, but other sentences could still be ambiguous.`
              : `${shownSentence} has at least two parse trees, shown below. This answer is exact, and it proves the grammar is ambiguous.`}
        </p>
      ) : null}

      {lone && loneLayout ? (
        <div className="rounded-md border border-line p-2">
          <p className="mb-1 text-xs font-medium text-ink-muted">Its only parse tree</p>
          <ParseForest
            nodes={lone.nodes}
            layout={loneLayout}
            nonterminals={nonterminals}
            title={`The only parse tree of ${shownSentence}`}
          />
        </div>
      ) : null}

      {pair ? (
        <TwoTrees
          key={pair.trace.length + (askedPair ? 'asked' : 'found')}
          trees={pair.trees}
          trace={pair.trace}
          nonterminals={nonterminals}
          onUsed={onUsed}
        />
      ) : (
        <Player
          trace={result.trace}
          name="ambiguity"
          renderStage={() => (
            <p className="p-2 text-sm text-ink-muted">
              There is no pair of trees to show. Raise the length limit to search further, or type a
              sentence above to check that one exactly.
            </p>
          )}
          {...(onUsed ? { onInteract: onUsed } : {})}
        />
      )}
    </div>
  );
}

export default function AmbiguityExplorer({ initial, onUsed }: VisualizerProps) {
  const [grammar, setGrammar] = useState(initial?.grammar ?? AMBIGUOUS_EXPRESSION.grammar);
  const [sentence, setSentence] = useState(initial?.sentence ?? '');
  const [maxLength, setMaxLength] = useState(DEFAULT_AMBIGUITY_LENGTH);
  const lengthId = useId();
  const settledGrammar = useDebouncedValue(grammar, 400);
  const settledSentence = useDebouncedValue(sentence, 400);
  const settledLength = useDebouncedValue(maxLength, 300);
  const input = useMemo(
    () => ({ grammar: settledGrammar, sentence: settledSentence, maxLength: settledLength }),
    [settledGrammar, settledSentence, settledLength],
  );
  const { data } = useEngineJob('ambiguitySearch', input);

  const pickPreset = (preset: GrammarPreset) => {
    setGrammar(preset.grammar);
    setSentence('');
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
          <div className="space-y-3">
            <div>
              <label htmlFor={lengthId} className="mb-1 block text-sm font-medium">
                Search sentences of up to {maxLength} tokens
              </label>
              <input
                id={lengthId}
                type="range"
                className="h-5 w-full"
                min={1}
                max={MAX_AMBIGUITY_LENGTH}
                value={maxLength}
                aria-valuetext={`${maxLength} tokens`}
                onChange={(event) => setMaxLength(Number(event.target.value))}
              />
              <p className="mt-0.5 text-xs text-ink-muted">
                A longer limit can find more, but takes longer, and the search stops itself if it
                gets too big.
              </p>
            </div>
            <SentenceField
              value={sentence}
              onChange={setSentence}
              label="Or check one sentence (optional)"
              hint="This checks every way of parsing that one sentence, so its answer is exact."
            />
          </div>
        </div>
      </div>
      <GrammarResult result={data} grammar={settledGrammar} sentence={settledSentence}>
        {(output) => (
          <Result
            key={`${settledGrammar}\n${settledSentence}\n${settledLength}`}
            output={output}
            onUsed={onUsed}
          />
        )}
      </GrammarResult>
    </div>
  );
}
