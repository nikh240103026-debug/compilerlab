import {
  formatGrammarProduction,
  lrFormatAction,
  type Grammar,
  type GrammarProduction,
  type Ll1Table,
  type LrTable,
} from '@compilerlab/engine';

const productionText = (grammar: Grammar, id: number) =>
  formatGrammarProduction(grammar.productions[id] as GrammarProduction);

export const ll1Headers = (table: Pick<Ll1Table, 'terminals'>) => [
  'Nonterminal',
  ...table.terminals,
];

/** Table rows for LL(1). Each production gets its own line, so a conflict is easy to read. */
export function ll1Rows(
  table: Pick<Ll1Table, 'grammar' | 'nonterminals' | 'synch'>,
  cells: Ll1Table['cells'],
  showSynch = false,
): string[][] {
  return table.nonterminals.map((symbol, row) => [
    symbol,
    ...(cells[row] ?? []).map((cell, column) => {
      if (cell.length > 0) return cell.map((id) => productionText(table.grammar, id)).join('\n');
      return showSynch && table.synch[row]?.[column] ? 'synch' : '';
    }),
  ]);
}

export const lrHeaders = (table: Pick<LrTable, 'terminals' | 'nonterminals'>) => [
  'State',
  ...table.terminals,
  ...table.nonterminals,
];

/** ACTION then GOTO for each state, written the way the book writes them. */
export function lrRows(table: LrTable): string[][] {
  return table.automaton.states.map((state, row) => [
    state.label,
    ...(table.cells[row] ?? []).map((cell) =>
      cell.map((action) => lrFormatAction(table, action)).join('\n'),
    ),
    ...(table.goto[row] ?? []).map((target) =>
      target === null ? '' : (table.automaton.states[target]?.label ?? String(target)),
    ),
  ]);
}

/** The numbered productions of an augmented grammar, which an r3 in the table refers to. */
export function numberedProductions(grammar: Grammar): string[] {
  return grammar.productions.map(
    (production) => `(${production.id}) ${formatGrammarProduction(production)}`,
  );
}
