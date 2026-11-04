import type {
  GrammarParserStep,
  GrammarSetRow,
  GrammarTableCell,
  OpPrecedenceStep,
  OpPrecedenceTable,
  OpRelation,
  TraceStep,
} from '@compilerlab/engine';
import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import {
  GrammarField,
  GrammarResult,
  IssueList,
  PrecedenceField,
  ProblemList,
  SentenceField,
} from './grammar-field';
import type { OperatorPrecedenceOutput } from './jobs';
import { layoutForest, ParseForest } from './parse-forest';
import {
  moveRows,
  MovesTable,
  ParserStack,
  parserStackSize,
  TokenTape,
  tokenTapeSize,
} from './parser-views';
import { AMBIGUOUS_EXPRESSION, EXPRESSION, type GrammarPreset } from './presets';
import { measureParsingTable, ParsingSvgTable, ParsingTable, type CellTone } from './tables';

const PRESETS: readonly GrammarPreset[] = [
  EXPRESSION,
  AMBIGUOUS_EXPRESSION,
  {
    label: 'Right-associative power',
    grammar: 'E -> E + E | E ^ E | ( E ) | id',
    sentence: 'id ^ id ^ id + id',
    precedence: '%left +\n%right ^',
  },
];

const RELATION_SIGN: Readonly<Record<OpRelation, string>> = { '<': '⋖', '=': '≐', '>': '⋗' };
const GAP = 12;

type View = 'parse' | 'table';

const relationRows = (terminals: readonly string[], cells: OpPrecedenceStep['cells']): string[][] =>
  terminals.map((terminal, row) => [
    terminal,
    ...(cells[row] ?? []).map((cell) => cell.map((relation) => RELATION_SIGN[relation]).join(' ')),
  ]);

const leadingRows = (
  leading: readonly GrammarSetRow[],
  trailing: readonly GrammarSetRow[],
): string[][] =>
  leading.map((row, index) => [
    row.symbol,
    row.items.join(', '),
    (trailing[index] as GrammarSetRow).items.join(', '),
  ]);

const SET_HEADER = ['Symbol', 'LEADING', 'TRAILING'];

function TablePlayer({
  table,
  onUsed,
}: {
  table: OpPrecedenceTable;
  onUsed: (() => void) | undefined;
}) {
  const headers = useMemo(() => ['Top, then next', ...table.terminals], [table]);
  const toneFor = useCallback((state: OpPrecedenceStep) => {
    const added = new Set(state.added.map(({ row, column }) => `${row}:${column}`));
    return (row: number, column: number): CellTone => {
      if (column === 0) return null;
      if ((state.cells[row]?.[column - 1]?.length ?? 0) > 1) return 'conflict';
      return added.has(`${row}:${column - 1}`) ? 'added' : null;
    };
  }, []);
  const renderStage = useCallback(
    ({ state }: TraceStep<OpPrecedenceStep>) => (
      <div className="@container">
        <div className="grid gap-3 @2xl:grid-cols-2">
          <ParsingTable
            caption="LEADING and TRAILING for each nonterminal"
            headers={SET_HEADER}
            rows={leadingRows(state.leading, state.trailing)}
          />
          <ParsingTable
            caption="The precedence relation between each pair of terminals. The row is on the left of the relation."
            headers={headers}
            rows={relationRows(table.terminals, state.cells)}
            tone={toneFor(state)}
          />
        </div>
      </div>
    ),
    [headers, table, toneFor],
  );
  const setSize = measureParsingTable([SET_HEADER, ...leadingRows(table.leading, table.trailing)]);
  const relationSize = measureParsingTable([
    headers,
    ...relationRows(table.terminals, table.cells),
  ]);
  return (
    <Player
      trace={table.trace}
      name="precedence-table"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: Math.max(setSize.width, relationSize.width),
        height: setSize.height + GAP + relationSize.height,
        render: ({ state }) => (
          <>
            <ParsingSvgTable rows={[SET_HEADER, ...leadingRows(state.leading, state.trailing)]} />
            <ParsingSvgTable
              y={setSize.height + GAP}
              rows={[headers, ...relationRows(table.terminals, state.cells)]}
              tone={toneFor(state)}
            />
          </>
        ),
      }}
    />
  );
}

const cellTone =
  (cell: GrammarTableCell | null) =>
  (row: number, column: number): CellTone =>
    cell && cell.row === row && cell.column + 1 === column ? 'active' : null;

function treeTone(state: GrammarParserStep) {
  const top = state.stack.at(-1)?.node ?? null;
  return (id: number) => (id === top ? ('active' as const) : null);
}

function ParsePlayer({
  output,
  onUsed,
}: {
  output: OperatorPrecedenceOutput;
  onUsed: (() => void) | undefined;
}) {
  const { table, run } = output;
  const headers = useMemo(() => ['Top, then next', ...table.terminals], [table]);
  const rows = useMemo(() => relationRows(table.terminals, table.cells), [table]);
  const moves = useMemo(() => moveRows(run), [run]);
  const indexOf = useMemo(
    () => new Map<TraceStep<GrammarParserStep>, number>(run.trace.map((step, i) => [step, i])),
    [run],
  );
  const layout = useMemo(() => layoutForest(run.nodes), [run]);
  const nonterminals = useMemo(() => new Set(run.grammar.nonterminals), [run]);

  const renderStage = useCallback(
    (step: TraceStep<GrammarParserStep>) => {
      const { state } = step;
      return (
        <div className="@container space-y-3">
          <div>
            <p className="mb-0.5 text-xs font-medium text-ink-muted">
              Stack, with the top on the right
            </p>
            <div className="overflow-x-auto">
              <ParserStack stack={state.stack} />
            </div>
          </div>
          <div>
            <p className="mb-0.5 text-xs font-medium text-ink-muted">Input</p>
            <div className="overflow-x-auto">
              <TokenTape tokens={run.tokens} position={state.position} move={state.move} />
            </div>
          </div>
          <div className="grid gap-3 @3xl:grid-cols-2">
            <div className="min-w-0 space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">
                  Precedence relations: top terminal on the left, next token above
                </p>
                <ParsingTable
                  caption="The precedence relations, with the pair just compared highlighted"
                  headers={headers}
                  rows={rows}
                  tone={cellTone(state.cell)}
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">Moves</p>
                <MovesTable rows={moves} current={indexOf.get(step) ?? 0} />
              </div>
            </div>
            <div className="min-w-0 overflow-x-auto">
              <p className="mb-1 text-xs font-medium text-ink-muted">
                The skeleton parse tree. Unit productions like E → T never get used.
              </p>
              <ParseForest
                nodes={run.nodes}
                layout={layout}
                nodeCount={state.nodeCount}
                tone={treeTone(state)}
                nonterminals={nonterminals}
              />
            </div>
          </div>
          {state.errorCount > 0 ? (
            <IssueList issues={run.errors.slice(0, state.errorCount)} />
          ) : null}
        </div>
      );
    },
    [run, headers, rows, moves, indexOf, layout, nonterminals],
  );

  const stack = parserStackSize(run.trace, String);
  const tape = tokenTapeSize(run.tokens);
  const relationSize = measureParsingTable([headers, ...rows]);
  const width = Math.max(stack.width, tape.width, relationSize.width, layout.width);

  return (
    <Player
      trace={run.trace}
      name="operator-precedence"
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width,
        height: stack.height + tape.height + relationSize.height + layout.height + GAP * 3,
        render: ({ state }) => (
          <>
            <ParserStack stack={state.stack} width={width} />
            <TokenTape
              tokens={run.tokens}
              position={state.position}
              move={state.move}
              y={stack.height + GAP}
            />
            <ParsingSvgTable
              y={stack.height + tape.height + GAP * 2}
              rows={[headers, ...rows]}
              tone={cellTone(state.cell)}
            />
            <ParseForest
              nodes={run.nodes}
              layout={layout}
              nodeCount={state.nodeCount}
              tone={treeTone(state)}
              nonterminals={nonterminals}
              animated={false}
              y={stack.height + tape.height + relationSize.height + GAP * 3}
            />
          </>
        ),
      }}
    />
  );
}

function Result({
  output,
  onUsed,
}: {
  output: OperatorPrecedenceOutput;
  onUsed: (() => void) | undefined;
}) {
  const [view, setView] = useState<View>('parse');
  const { table } = output;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="precedence-view"
          legend="What to step through"
          value={view}
          options={[
            { value: 'parse', label: 'Parse the sentence' },
            { value: 'table', label: 'Build the table' },
          ]}
          onChange={setView}
        />
        <Badge tone={table.conflicts.length === 0 ? 'success' : 'danger'}>
          {table.conflicts.length === 0
            ? 'At most one relation per pair'
            : `${table.conflicts.length} conflict${table.conflicts.length === 1 ? '' : 's'}`}
        </Badge>
      </div>
      {view === 'parse' ? (
        <ParsePlayer output={output} onUsed={onUsed} />
      ) : (
        <TablePlayer table={table} onUsed={onUsed} />
      )}
      <ProblemList
        label="Conflicts"
        problems={table.conflicts.map((conflict) => ({
          key: `${conflict.row}:${conflict.column}`,
          message: conflict.message,
        }))}
        question={(message) =>
          `My operator-precedence table has this conflict: ${message} Why, and how do I fix it?`
        }
      />
      {table.resolved.length > 0 ? (
        <div className="rounded-md bg-surface-2 p-2 text-sm">
          <p className="font-medium">Settled by your declarations</p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-ink-muted">
            {table.resolved.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default function OperatorPrecedence({ initial, onUsed }: VisualizerProps) {
  const [grammar, setGrammar] = useState(initial?.grammar ?? AMBIGUOUS_EXPRESSION.grammar);
  const [precedence, setPrecedence] = useState(
    initial?.precedence ?? AMBIGUOUS_EXPRESSION.precedence ?? '',
  );
  const [sentence, setSentence] = useState(
    initial?.sentence ?? AMBIGUOUS_EXPRESSION.sentence ?? '',
  );
  const settledGrammar = useDebouncedValue(grammar, 400);
  const settledPrecedence = useDebouncedValue(precedence, 400);
  const settledSentence = useDebouncedValue(sentence, 400);
  const input = useMemo(
    () => ({
      grammar: settledGrammar,
      precedence: settledPrecedence,
      sentence: settledSentence,
    }),
    [settledGrammar, settledPrecedence, settledSentence],
  );
  const { data } = useEngineJob('operatorPrecedence', input);

  const pickPreset = (preset: GrammarPreset) => {
    setGrammar(preset.grammar);
    setPrecedence(preset.precedence ?? '');
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
            rows={4}
          />
          <div className="space-y-3">
            <PrecedenceField value={precedence} onChange={setPrecedence} />
            <SentenceField value={sentence} onChange={setSentence} />
          </div>
        </div>
      </div>
      <GrammarResult
        result={data}
        grammar={settledGrammar}
        sentence={settledSentence}
        precedence={settledPrecedence}
      >
        {(output) => (
          <Result
            key={`${settledGrammar}\n${settledPrecedence}\n${settledSentence}`}
            output={output}
            onUsed={onUsed}
          />
        )}
      </GrammarResult>
    </div>
  );
}
