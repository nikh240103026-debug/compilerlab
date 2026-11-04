import {
  formatGrammarProduction,
  type GrammarParserStep,
  type GrammarParseNode,
  type GrammarProduction,
  type GrammarRecovery,
  type GrammarTableCell,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useMemo, useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { GrammarField, GrammarResult, IssueList, SentenceField } from './grammar-field';
import type { ParserMethod, ParserRunOutput } from './jobs';
import { forestExtent, layoutForest, ParseForest } from './parse-forest';
import {
  moveRows,
  MovesTable,
  ParserStack,
  parserStackSize,
  TokenTape,
  tokenTapeSize,
} from './parser-views';
import {
  BACKTRACKING,
  EXPRESSION,
  EXPRESSION_LL,
  NOT_SLR,
  TWO_C,
  type GrammarPreset,
} from './presets';
import { ll1Headers, ll1Rows, lrHeaders, lrRows } from './table-rows';
import { ParsingTable } from './tables';

const WITH_ERRORS: GrammarPreset = {
  ...EXPRESSION,
  label: 'A sentence with errors',
  sentence: 'id + * id ) id',
};

const PRESETS: readonly GrammarPreset[] = [
  EXPRESSION,
  EXPRESSION_LL,
  TWO_C,
  NOT_SLR,
  BACKTRACKING,
  WITH_ERRORS,
];

const METHODS: readonly { value: ParserMethod; label: string }[] = [
  { value: 'll1', label: 'LL(1)' },
  { value: 'slr', label: 'SLR(1)' },
  { value: 'lalr', label: 'LALR(1)' },
  { value: 'lr1', label: 'LR(1)' },
  { value: 'backtrack', label: 'Backtracking' },
];

const RECOVERIES: readonly { value: GrammarRecovery; label: string }[] = [
  { value: 'none', label: 'Stop at the first error' },
  { value: 'panic', label: 'Panic mode' },
  { value: 'phrase', label: 'Phrase level' },
];

const GAP = 8;

function Result({
  output,
  method,
  onUsed,
}: {
  output: ParserRunOutput;
  method: ParserMethod;
  onUsed: (() => void) | undefined;
}) {
  const { run, ll1, lr } = output;
  const topDown = lr === null;
  const stateLabel = useCallback(
    (state: number) => lr?.automaton.states[state]?.label ?? String(state),
    [lr],
  );
  const rows = useMemo(() => moveRows(run, stateLabel), [run, stateLabel]);
  const indexOf = useMemo(
    () => new Map<TraceStep<GrammarParserStep>, number>(run.trace.map((step, i) => [step, i])),
    [run],
  );
  const finalLayout = useMemo(() => layoutForest(run.nodes), [run]);
  const nonterminals = useMemo(() => new Set(run.grammar.nonterminals), [run]);
  const [cell, setCell] = useState<GrammarTableCell | null>(null);
  const onStep = useCallback(({ state }: TraceStep<GrammarParserStep>) => setCell(state.cell), []);

  const toneFor = useCallback(
    (state: GrammarParserStep) => {
      const top = state.stack.at(-1)?.node ?? null;
      const onStack = new Set(state.stack.flatMap(({ node }) => (node === null ? [] : [node])));
      return (id: number) =>
        id === top ? ('active' as const) : topDown && onStack.has(id) ? ('pending' as const) : null;
    },
    [topDown],
  );
  const layoutFor = useCallback(
    (nodes: readonly GrammarParseNode[] | undefined) => (nodes ? layoutForest(nodes) : finalLayout),
    [finalLayout],
  );

  const renderStage = useCallback(
    (step: TraceStep<GrammarParserStep>) => {
      const { state } = step;
      const nodes = state.nodes ?? run.nodes;
      const applied = run.output.slice(0, state.outputCount);
      return (
        <div className="@container space-y-3">
          <div>
            <p className="mb-0.5 text-xs font-medium text-ink-muted">
              Stack, with the top on the right{lr ? ', and the state under each symbol' : ''}
            </p>
            <div className="overflow-x-auto">
              <ParserStack stack={state.stack} label={stateLabel} />
            </div>
          </div>
          <div>
            <p className="mb-0.5 text-xs font-medium text-ink-muted">Input</p>
            <div className="overflow-x-auto">
              <TokenTape tokens={run.tokens} position={state.position} move={state.move} />
            </div>
          </div>
          <div className="grid gap-3 @3xl:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-1 text-xs font-medium text-ink-muted">Moves</p>
              <MovesTable rows={rows} current={indexOf.get(step) ?? 0} />
            </div>
            <div className="min-w-0 overflow-x-auto">
              <p className="mb-1 text-xs font-medium text-ink-muted">
                {topDown ? 'The parse tree, growing downward' : 'The parse tree, growing upward'}
              </p>
              <ParseForest
                nodes={nodes}
                layout={layoutFor(state.nodes)}
                nodeCount={state.nodeCount}
                tone={toneFor(state)}
                nonterminals={nonterminals}
              />
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">
              {topDown ? 'Productions used so far, a leftmost derivation' : 'Reductions so far'}
            </p>
            {applied.length > 0 ? (
              <ol className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                {applied.map((id, index) => (
                  <li key={index}>
                    {formatGrammarProduction(run.grammar.productions[id] as GrammarProduction)}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-ink-muted">None yet.</p>
            )}
          </div>
          {state.errorCount > 0 ? (
            <IssueList issues={run.errors.slice(0, state.errorCount)} />
          ) : null}
        </div>
      );
    },
    [run, rows, indexOf, lr, topDown, stateLabel, toneFor, layoutFor, nonterminals],
  );

  const exportSize = useMemo(() => {
    const stack = parserStackSize(run.trace, stateLabel);
    const tape = tokenTapeSize(run.tokens);
    let forest = { width: finalLayout.width, height: finalLayout.height };
    if (method === 'backtrack') {
      forest = { width: 0, height: 0 };
      // The tree changes shape as attempts are undone, so size for the largest one seen.
      for (const { state } of run.trace) {
        if (!state.nodes) continue;
        const extent = forestExtent(state.nodes);
        forest = {
          width: Math.max(forest.width, extent.width),
          height: Math.max(forest.height, extent.height),
        };
      }
    }
    return {
      stack,
      tape,
      forest,
      width: Math.max(stack.width, tape.width, forest.width),
      height: stack.height + tape.height + forest.height + GAP * 2,
    };
  }, [run, method, stateLabel, finalLayout]);

  const conflicts = lr ? lr.conflicts.length : ll1 ? ll1.conflicts.length : 0;
  const tableHeaders = lr ? lrHeaders(lr) : ll1 ? ll1Headers(ll1) : null;
  const tableRows = useMemo(
    () => (lr ? lrRows(lr) : ll1 ? ll1Rows(ll1, ll1.cells) : null),
    [lr, ll1],
  );

  return (
    <div className="space-y-3">
      {conflicts > 0 ? (
        <p className="rounded-md border border-warning p-2 text-sm">
          This grammar has {conflicts} conflict{conflicts === 1 ? '' : 's'} with this method, so the
          table has cells with more than one choice. The parser takes a default in those cells, and
          each step that does says so.
        </p>
      ) : null}
      <Player
        trace={run.trace}
        name="parser-stack"
        renderStage={renderStage}
        onStep={onStep}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          width: exportSize.width,
          height: exportSize.height,
          render: ({ state }) => (
            <>
              <ParserStack stack={state.stack} label={stateLabel} width={exportSize.width} />
              <TokenTape
                tokens={run.tokens}
                position={state.position}
                move={state.move}
                y={exportSize.stack.height + GAP}
              />
              <ParseForest
                nodes={state.nodes ?? run.nodes}
                layout={layoutFor(state.nodes)}
                nodeCount={state.nodeCount}
                tone={toneFor(state)}
                nonterminals={nonterminals}
                animated={false}
                y={exportSize.stack.height + exportSize.tape.height + GAP * 2}
                width={exportSize.forest.width}
                height={exportSize.forest.height}
              />
            </>
          ),
        }}
      />
      {tableHeaders && tableRows ? (
        <div>
          <p className="mb-1 text-sm font-semibold">The table it is reading</p>
          <ParsingTable
            caption="The parsing table, with the cell the parser just read highlighted"
            headers={tableHeaders}
            rows={tableRows}
            tone={(row, column) =>
              cell && cell.row === row && cell.column + 1 === column ? 'active' : null
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export default function ParserStackAnimator({ initial, onUsed }: VisualizerProps) {
  const [grammar, setGrammar] = useState(initial?.grammar ?? EXPRESSION.grammar);
  const [sentence, setSentence] = useState(initial?.sentence ?? EXPRESSION.sentence ?? '');
  const [method, setMethod] = useState<ParserMethod>(
    METHODS.find(({ value }) => value === initial?.method)?.value ?? 'slr',
  );
  const [recovery, setRecovery] = useState<GrammarRecovery>(
    RECOVERIES.find(({ value }) => value === initial?.recovery)?.value ?? 'none',
  );
  const settledGrammar = useDebouncedValue(grammar, 400);
  const settledSentence = useDebouncedValue(sentence, 400);
  const input = useMemo(
    () => ({ grammar: settledGrammar, sentence: settledSentence, method, recovery }),
    [settledGrammar, settledSentence, method, recovery],
  );
  const { data } = useEngineJob('parserRun', input);

  const pickPreset = (preset: GrammarPreset) => {
    setGrammar(preset.grammar);
    if (preset.sentence !== undefined) setSentence(preset.sentence);
    if (preset === WITH_ERRORS) setRecovery('panic');
    if (preset === BACKTRACKING) setMethod('backtrack');
    else if (preset === EXPRESSION_LL) setMethod('ll1');
    else if (method === 'backtrack' || method === 'll1') setMethod('slr');
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
          <SentenceField value={sentence} onChange={setSentence} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="parser-method"
          legend="Which parser to run"
          value={method}
          options={METHODS}
          onChange={setMethod}
        />
        {method === 'backtrack' ? null : (
          <Segmented
            name="parser-recovery"
            legend="What to do at a syntax error"
            value={recovery}
            options={RECOVERIES}
            onChange={setRecovery}
          />
        )}
      </div>
      <GrammarResult result={data} grammar={settledGrammar} sentence={settledSentence}>
        {(output) => (
          <Result
            key={`${settledGrammar}\n${settledSentence}\n${method}\n${recovery}`}
            output={output}
            method={method}
            onUsed={onUsed}
          />
        )}
      </GrammarResult>
    </div>
  );
}
