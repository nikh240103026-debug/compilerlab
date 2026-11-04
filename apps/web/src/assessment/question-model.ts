// What the engine works out about a question before anyone answers it: a table's rows and columns,
// or a parser's choice of moves. This runs in the Web Worker, and the page draws from the result.
import {
  formatGrammarProduction,
  lrBuildTable,
  lrFormatAction,
  lrFormatItem,
  ll1BuildTable,
  parseGrammar,
  type Grammar,
  type LrTable,
} from '@compilerlab/engine';
import type { PracticeProblem } from '@compilerlab/shared';
import type { TraceMoveOption } from './trace-moves';

export type TableSpec = Extract<PracticeProblem, { type: 'table' }>['table'];
export type LrSpec = Extract<TableSpec, { kind: 'lr' }>;

export interface FirstFollowModel {
  kind: 'first-follow';
  nonterminals: readonly string[];
  sets: readonly ('first' | 'follow')[];
}

export interface Ll1Model {
  kind: 'll1';
  rows: readonly string[];
  columns: readonly string[];
  /** Each production once, as the choices for a cell. */
  productions: readonly string[];
}

export interface LrModel {
  kind: 'lr';
  /** State names, which number the rows. */
  rows: readonly string[];
  actionColumns: readonly string[];
  gotoColumns: readonly string[];
  /** Numbered as the book numbers them, so r1 is the first production written. */
  productions: readonly string[];
  /** The value of each cell shown already filled in, or null for a cell to fill in. */
  given: readonly (readonly (string | null)[])[];
  /** The LR item sets, so the student and the engine use the same state numbers. */
  states: readonly { label: string; items: readonly string[] }[];
}

export type TableModel = FirstFollowModel | Ll1Model | LrModel;

export interface TraceModel {
  kind: 'trace';
  parser: 'll1' | 'lr0' | 'slr' | 'lalr' | 'lr1';
  start: string;
  nonterminals: readonly string[];
  tokens: readonly string[];
  options: readonly TraceMoveOption[];
}

export type QuestionModel = TableModel | TraceModel;

/** A sentence as the question wrote it, with spaces between its tokens. */
export function sentenceTokens(sentence: string): string[] {
  const trimmed = sentence.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

const productionLabels = (grammar: Grammar) => grammar.productions.map(formatGrammarProduction);

/** The answer key of an LR table, cell by cell. The columns are ACTION, then GOTO. */
export function lrCellValues(table: LrTable): string[][][] {
  return table.automaton.states.map((_, row) => [
    ...table.terminals.map((_terminal, column) =>
      (table.cells[row]?.[column] ?? []).map((action) => lrFormatAction(table, action)),
    ),
    ...table.nonterminals.map((_nonterminal, column) => {
      const target = table.goto[row]?.[column] ?? null;
      return target === null ? [] : [table.automaton.states[target]?.label ?? String(target)];
    }),
  ]);
}

/** Whether a cell is shown as given. `reduce` asks only about the cells that could reduce. */
export function isLrCellGiven(table: LrTable, spec: LrSpec, row: number, column: number): boolean {
  if (spec.blanks !== 'reduce') return false;
  if (column >= table.terminals.length) return true;
  const actions = table.cells[row]?.[column] ?? [];
  return actions.some((action) => action.type !== 'reduce');
}

function lrModel(spec: LrSpec): LrModel {
  const table = lrBuildTable(parseGrammar(spec.grammar), spec.parser);
  const values = lrCellValues(table);
  const grammar = table.grammar;
  return {
    kind: 'lr',
    rows: table.automaton.states.map((state) => state.label),
    actionColumns: table.terminals,
    gotoColumns: table.nonterminals,
    // Production 0 is the S' → S the engine added, so the book's numbering starts after it.
    productions: productionLabels(grammar)
      .slice(1)
      .map((label, index) => `${index + 1}. ${label}`),
    given: values.map((row, rowIndex) =>
      row.map((cell, column) =>
        isLrCellGiven(table, spec, rowIndex, column) ? cell.join(' / ') : null,
      ),
    ),
    states: table.automaton.states.map((state) => ({
      label: state.label,
      items: state.items.map((item) => lrFormatItem(grammar, item)),
    })),
  };
}

function tableModel(spec: TableSpec): TableModel | null {
  switch (spec.kind) {
    case 'first-follow':
      return {
        kind: 'first-follow',
        nonterminals: parseGrammar(spec.grammar).nonterminals,
        sets: spec.sets ?? ['first', 'follow'],
      };
    case 'll1': {
      const grammar = parseGrammar(spec.grammar);
      const table = ll1BuildTable(grammar);
      return {
        kind: 'll1',
        rows: table.nonterminals,
        columns: table.terminals,
        productions: productionLabels(grammar),
      };
    }
    case 'lr':
      return lrModel(spec);
    case 'values':
      // Nothing to compute. The page draws this from the question itself.
      return null;
  }
}

function traceModel(question: Extract<PracticeProblem, { type: 'trace' }>): TraceModel {
  const grammar = parseGrammar(question.grammar);
  const productions = productionLabels(grammar);
  const options: TraceMoveOption[] =
    question.parser === 'll1'
      ? [
          { value: 'match', label: 'Match the terminal on top of the stack' },
          ...productions.map((label) => ({ value: `expand:${label}`, label: `Expand: ${label}` })),
          { value: 'accept', label: 'Accept' },
          { value: 'error', label: 'Report a syntax error' },
        ]
      : [
          { value: 'shift', label: 'Shift the next token' },
          ...productions.map((label) => ({ value: `reduce:${label}`, label: `Reduce: ${label}` })),
          { value: 'accept', label: 'Accept' },
          { value: 'error', label: 'Report a syntax error' },
        ];
  return {
    kind: 'trace',
    parser: question.parser,
    start: grammar.start,
    nonterminals: grammar.nonterminals,
    tokens: sentenceTokens(question.input),
    options,
  };
}

/** Null when the question needs nothing from the engine. Bad grammar text throws an EngineError. */
export function buildQuestionModel(question: PracticeProblem): QuestionModel | null {
  if (question.type === 'table') return tableModel(question.table);
  if (question.type === 'trace') return traceModel(question);
  return null;
}
