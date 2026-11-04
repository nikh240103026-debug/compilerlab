import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import {
  formatGrammarProduction,
  grammarSymbolOrder,
  indexGrammar,
  sortGrammarSymbols,
} from './cfg';
import { grammarProductiveSymbols } from './diagnostics';
import { ForestBuilder } from './forest';
import {
  GRAMMAR_END_MARKER,
  MAX_PARSER_MOVES,
  type Grammar,
  type GrammarParseIssue,
  type GrammarParseOutcome,
  type GrammarParserMove,
  type GrammarParserRun,
  type GrammarParserStep,
  type GrammarPrecedence,
  type GrammarPrecedenceLevel,
  type GrammarProduction,
  type GrammarSetRow,
  type GrammarStackEntry,
  type GrammarTableCell,
} from './types';

/** a < b: a yields to b. a = b: they share a handle. a > b: a takes precedence over b. */
export type OpRelation = '<' | '=' | '>';

export interface OpPrecedenceConflict {
  readonly row: number;
  readonly column: number;
  readonly left: string;
  readonly right: string;
  readonly relations: readonly OpRelation[];
  readonly message: string;
}

export interface OpPrecedenceStep {
  readonly phase: 'leading' | 'trailing' | 'relations' | 'done';
  readonly leading: readonly GrammarSetRow[];
  readonly trailing: readonly GrammarSetRow[];
  readonly cells: readonly (readonly (readonly OpRelation[])[])[];
  readonly production: number | null;
  readonly added: readonly GrammarTableCell[];
}

export interface OpPrecedenceTable {
  readonly grammar: Grammar;
  /** Rows and columns: the grammar's terminals, then $. */
  readonly terminals: readonly string[];
  readonly leading: readonly GrammarSetRow[];
  readonly trailing: readonly GrammarSetRow[];
  /** [left][right]: the relations between these two terminals. Two or more is a conflict. */
  readonly cells: readonly (readonly (readonly OpRelation[])[])[];
  readonly conflicts: readonly OpPrecedenceConflict[];
  /** Conflicts that the precedence declarations settled, in words. */
  readonly resolved: readonly string[];
  readonly trace: Trace<OpPrecedenceStep>;
}

const RELATION_ORDER: readonly OpRelation[] = ['<', '=', '>'];
const RELATION_WORDS: Readonly<Record<OpRelation, string>> = {
  '<': 'yields precedence to',
  '=': 'has the same precedence as',
  '>': 'takes precedence over',
};

/** An operator grammar has no ε-productions, and no two nonterminals next to each other. */
function requireOperatorGrammar(grammar: Grammar): void {
  const { nonterminals } = indexGrammar(grammar);
  for (const production of grammar.productions) {
    const name = formatGrammarProduction(production);
    if (production.body.length === 0) {
      throw new EngineError({
        code: 'not_operator_grammar',
        message: `${name} is an ε-production, so this is not an operator grammar.`,
        hint: 'Operator-precedence parsing needs a grammar with no ε-productions and no two adjacent nonterminals.',
      });
    }
    for (let index = 0; index + 1 < production.body.length; index++) {
      if (
        nonterminals.has(production.body[index] as string) &&
        nonterminals.has(production.body[index + 1] as string)
      ) {
        throw new EngineError({
          code: 'not_operator_grammar',
          message: `${name} has two nonterminals next to each other, so this is not an operator grammar.`,
          hint: 'Operator-precedence parsing needs an operator between any two nonterminals, because it only compares terminals.',
        });
      }
    }
  }
}

/**
 * LEADING and TRAILING, and from them the precedence relations, as in the first edition of the
 * Dragon Book, Section 4.6. An ambiguous operator grammar gets conflicts from these rules, and
 * %left and %right declarations settle them, the same way they settle LR conflicts.
 */
export function opPrecedenceBuildTable(
  grammar: Grammar,
  precedence?: GrammarPrecedence,
): OpPrecedenceTable {
  requireOperatorGrammar(grammar);
  const { nonterminals: isNonterminal } = indexGrammar(grammar);
  const terminals = [...grammar.terminals, GRAMMAR_END_MARKER];
  const indexOf = new Map(terminals.map((symbol, index) => [symbol, index]));
  const order = grammarSymbolOrder(grammar);
  const recorder = new TraceRecorder<OpPrecedenceStep>();

  const leading = new Map(grammar.nonterminals.map((name) => [name, new Set<string>()]));
  const trailing = new Map(grammar.nonterminals.map((name) => [name, new Set<string>()]));
  const rowsOf = (sets: ReadonlyMap<string, ReadonlySet<string>>): GrammarSetRow[] =>
    grammar.nonterminals.map((symbol) => ({
      symbol,
      items: sortGrammarSymbols(order, sets.get(symbol) ?? []),
    }));

  const rows: (readonly (readonly OpRelation[])[])[] = terminals.map(() => terminals.map(() => []));
  const record = (
    phase: OpPrecedenceStep['phase'],
    title: string,
    explanation: string,
    production: number | null = null,
    added: readonly GrammarTableCell[] = [],
  ) => {
    recorder.add(title, explanation, {
      phase,
      leading: rowsOf(leading),
      trailing: rowsOf(trailing),
      cells: rows.slice(),
      production,
      added,
    });
  };

  // The LEADING terminals of A can start a string from A, with at most one nonterminal before them.
  const fixedPoint = (
    sets: Map<string, Set<string>>,
    phase: 'leading' | 'trailing',
    pick: (body: readonly string[]) => readonly [string | undefined, string | undefined],
  ) => {
    const label = phase === 'leading' ? 'LEADING' : 'TRAILING';
    let changed = true;
    while (changed) {
      changed = false;
      for (const production of grammar.productions) {
        const target = sets.get(production.head) as Set<string>;
        const [edge, next] = pick(production.body);
        const added: string[] = [];
        const add = (item: string) => {
          if (!target.has(item)) {
            target.add(item);
            added.push(item);
          }
        };
        if (edge !== undefined) {
          if (isNonterminal.has(edge)) {
            for (const item of sets.get(edge) as Set<string>) add(item);
            if (next !== undefined && !isNonterminal.has(next)) add(next);
          } else {
            add(edge);
          }
        }
        if (added.length > 0) {
          changed = true;
          record(
            phase,
            `${label}(${production.head}) grows`,
            `${formatGrammarProduction(production)}: ${label}(${production.head}) gains ${sortGrammarSymbols(order, added).join(', ')}.`,
            production.id,
          );
        }
      }
      if (!changed) {
        record(
          phase,
          `${label} is final`,
          `A full pass changed nothing, so the ${label} sets are done.`,
        );
      }
    }
  };

  record(
    'leading',
    'Compute LEADING and TRAILING',
    'LEADING(A) holds the terminals that can come first in a string from A, ignoring at most one nonterminal in front. TRAILING(A) holds the ones that can come last, ignoring at most one nonterminal behind.',
  );
  fixedPoint(leading, 'leading', (body) => [body[0], body[1]]);
  fixedPoint(trailing, 'trailing', (body) => [body.at(-1), body.at(-2)]);

  // The relations.
  const enter = (added: GrammarTableCell[], left: string, right: string, relation: OpRelation) => {
    const row = indexOf.get(left) as number;
    const column = indexOf.get(right) as number;
    const current = rows[row] as readonly (readonly OpRelation[])[];
    if ((current[column] as readonly OpRelation[]).includes(relation)) return;
    const updated = current.slice();
    updated[column] = RELATION_ORDER.filter(
      (item) => item === relation || (current[column] as readonly OpRelation[]).includes(item),
    );
    rows[row] = updated;
    added.push({ row, column });
  };

  for (const production of grammar.productions) {
    const { body } = production;
    const added: GrammarTableCell[] = [];
    for (let index = 0; index + 1 < body.length; index++) {
      const a = body[index] as string;
      const b = body[index + 1] as string;
      const aIsTerminal = !isNonterminal.has(a);
      const bIsTerminal = !isNonterminal.has(b);
      if (aIsTerminal && bIsTerminal) enter(added, a, b, '=');
      const c = body[index + 2];
      if (aIsTerminal && !bIsTerminal && c !== undefined && !isNonterminal.has(c)) {
        enter(added, a, c, '=');
      }
      if (aIsTerminal && !bIsTerminal) {
        for (const item of leading.get(b) as Set<string>) enter(added, a, item, '<');
      }
      if (!aIsTerminal && bIsTerminal) {
        for (const item of trailing.get(a) as Set<string>) enter(added, item, b, '>');
      }
    }
    if (added.length > 0) {
      record(
        'relations',
        `Relations from ${formatGrammarProduction(production)}`,
        "Terminals with only a nonterminal between them are in the same handle, so they relate by =. A terminal right before a nonterminal yields to that nonterminal's LEADING set. The TRAILING set of a nonterminal takes precedence over a terminal right after it.",
        production.id,
        added,
      );
    }
  }
  const endAdded: GrammarTableCell[] = [];
  for (const item of leading.get(grammar.start) as Set<string>) {
    enter(endAdded, GRAMMAR_END_MARKER, item, '<');
  }
  for (const item of trailing.get(grammar.start) as Set<string>) {
    enter(endAdded, item, GRAMMAR_END_MARKER, '>');
  }
  record(
    'relations',
    'Relations with $',
    `$ acts as an operator of the very lowest precedence on both ends: it yields to everything in LEADING(${grammar.start}), and everything in TRAILING(${grammar.start}) takes precedence over it.`,
    null,
    endAdded,
  );

  // Settle what the declarations can settle.
  const levelOf = new Map<string, { level: number; assoc: GrammarPrecedenceLevel['assoc'] }>();
  precedence?.levels.forEach(({ assoc, terminals: names }, level) => {
    for (const name of names) levelOf.set(name, { level, assoc });
  });
  const resolved: string[] = [];
  const conflicts: OpPrecedenceConflict[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, column) => {
      if (cell.length < 2) return;
      const left = terminals[rowIndex] as string;
      const right = terminals[column] as string;
      const a = levelOf.get(left);
      const b = levelOf.get(right);
      if (a && b) {
        let winner: OpRelation | null;
        if (a.level > b.level) winner = '>';
        else if (a.level < b.level) winner = '<';
        else if (a.assoc === 'left') winner = '>';
        else if (a.assoc === 'right') winner = '<';
        else winner = null;
        const updated = (rows[rowIndex] as readonly (readonly OpRelation[])[]).slice();
        updated[column] = winner ? [winner] : [];
        rows[rowIndex] = updated;
        resolved.push(
          winner
            ? `${left} ${winner} ${right}: ${left} ${RELATION_WORDS[winner]} ${right}, ${a.level === b.level ? `because they are %${a.assoc}` : 'by their declared levels'}.`
            : `${left} and ${right} are %nonassoc, so writing them together is an error.`,
        );
        return;
      }
      conflicts.push({
        row: rowIndex,
        column,
        left,
        right,
        relations: cell,
        message: `${left} and ${right} are related by both ${cell.join(' and ')}, so this is not an operator-precedence grammar as it stands. Declaring their precedence with %left or %right settles it.`,
      });
    });
  });

  record(
    'done',
    conflicts.length > 0 ? 'The table has conflicts' : 'The table is ready',
    conflicts.length > 0
      ? `${conflicts.length} pair${conflicts.length === 1 ? ' has' : 's have'} more than one relation. The parser will use the first one, so it may not parse as you intended.`
      : resolved.length > 0
        ? `Every pair has at most one relation, after the declarations settled ${resolved.length} conflict${resolved.length === 1 ? '' : 's'}.`
        : 'Every pair of terminals has at most one relation, so this is an operator-precedence grammar.',
  );

  return {
    grammar,
    terminals,
    leading: rowsOf(leading),
    trailing: rowsOf(trailing),
    cells: rows,
    conflicts,
    resolved,
    trace: recorder.finish(),
  };
}

/**
 * The operator-precedence parser. It compares only the topmost terminal on the stack with the next
 * token: < or = means shift, and > means the handle is complete. To find where a handle starts, it
 * pops until the topmost terminal yields to the terminal popped last.
 *
 * All nonterminals look alike to this parser, so a handle matches a production by its terminals
 * and the positions of its nonterminals. Unit productions like E → T have no terminal to act on, so
 * they never get used. That is why this parser builds a skeleton of the full parse tree.
 */
export function opPrecedenceParse(
  table: OpPrecedenceTable,
  tokens: readonly string[],
): GrammarParserRun {
  const { grammar, terminals, cells } = table;
  const { nonterminals: isNonterminal, byHead } = indexGrammar(grammar);
  const indexOf = new Map(terminals.map((symbol, index) => [symbol, index]));
  const recorder = new TraceRecorder<GrammarParserStep>();
  const forest = new ForestBuilder();
  const output: number[] = [];
  const errors: GrammarParseIssue[] = [];
  const stack: GrammarStackEntry[] = [{ symbol: GRAMMAR_END_MARKER, state: null, node: null }];
  let position = 0;
  let outcome: GrammarParseOutcome | null = null;

  const record = (
    title: string,
    explanation: string,
    move: GrammarParserMove,
    action: string,
    production: number | null = null,
    cell: GrammarTableCell | null = null,
  ) => {
    recorder.add(title, explanation, {
      move,
      action,
      stack: stack.slice(),
      position,
      nodeCount: forest.size,
      errorCount: errors.length,
      outputCount: output.length,
      production,
      cell,
    });
  };

  const relationBetween = (left: string, right: string) =>
    cells[indexOf.get(left) ?? -1]?.[indexOf.get(right) ?? -1]?.[0];
  const cellOf = (left: string, right: string): GrammarTableCell => ({
    row: indexOf.get(left) ?? -1,
    column: indexOf.get(right) ?? -1,
  });
  /** Where the topmost terminal sits on the stack, at or below `from`. */
  const terminalAtOrBelow = (from: number) => {
    let at = from;
    while (at > 0 && isNonterminal.has((stack[at] as GrammarStackEntry).symbol)) at--;
    return at;
  };
  const expectedAfter = (left: string) =>
    terminals.filter((_, column) => (cells[indexOf.get(left) ?? -1]?.[column]?.length ?? 0) > 0);

  const fail = (
    found: string,
    expected: readonly string[],
    message: string,
    cell: GrammarTableCell | null,
  ) => {
    errors.push({ position, found, expected, message, recovery: '' });
    record('Syntax error', message, 'reject', 'error', null, cell);
    outcome = 'rejected';
  };

  const matchHandle = (handle: readonly GrammarStackEntry[]): GrammarProduction | undefined =>
    grammar.productions.find(
      ({ body }) =>
        body.length === handle.length &&
        body.every((symbol, index) => {
          const entry = handle[index] as GrammarStackEntry;
          return isNonterminal.has(symbol)
            ? isNonterminal.has(entry.symbol)
            : symbol === entry.symbol;
        }),
    );

  /** Nonterminals that can stand for the start symbol once unit productions are skipped. */
  const unitReach = new Set([grammar.start]);
  for (const name of unitReach) {
    for (const { body } of byHead.get(name) ?? []) {
      const only = body[0];
      if (body.length === 1 && only !== undefined && isNonterminal.has(only)) unitReach.add(only);
    }
  }

  record(
    'Start',
    'The stack holds $, and the input pointer is on the first token. The parser compares the topmost terminal on the stack with the next token, ignoring nonterminals.',
    'start',
    '',
  );

  const productive = grammarProductiveSymbols(grammar);
  if (!productive.has(grammar.start)) {
    fail(
      tokens[0] ?? GRAMMAR_END_MARKER,
      [],
      `${grammar.start} derives no string of terminals, so no sentence can be accepted.`,
      null,
    );
  }

  for (let moves = 0; outcome === null; moves++) {
    if (moves >= MAX_PARSER_MOVES) {
      throw new EngineError({
        code: 'parser_loop',
        message: `The parser made ${moves} moves without finishing.`,
        hint: 'Try a shorter sentence.',
      });
    }
    const topTerminalAt = terminalAtOrBelow(stack.length - 1);
    const a = (stack[topTerminalAt] as GrammarStackEntry).symbol;
    const b = tokens[position] ?? GRAMMAR_END_MARKER;

    if (a === GRAMMAR_END_MARKER && b === GRAMMAR_END_MARKER) {
      const finished = stack[1];
      if (stack.length === 2 && finished && unitReach.has(finished.symbol)) {
        outcome = 'accepted';
        record(
          'Accept',
          `Only $ and one nonterminal are left on the stack, and only $ in the input, so the sentence is accepted.`,
          'accept',
          'accept',
        );
      } else {
        fail(
          b,
          [],
          stack.length === 1
            ? 'The input is empty, and an operator grammar cannot derive the empty string.'
            : 'The input is used up, but what is on the stack cannot stand for the start symbol.',
          null,
        );
      }
      continue;
    }

    const relation = relationBetween(a, b);
    const cell = cellOf(a, b);
    if (relation === undefined) {
      fail(
        b,
        expectedAfter(a),
        `No precedence relation exists between ${a} and ${b}, so ${b} cannot come here. Syntax error at token ${position + 1}.`,
        cell,
      );
      continue;
    }

    if (relation === '<' || relation === '=') {
      const node = forest.add(b, 'terminal', { token: position });
      stack.push({ symbol: b, state: null, node });
      position++;
      record(
        `Shift ${b}`,
        `${a} ${relation} ${b}: ${a} ${RELATION_WORDS[relation]} ${b}, so the handle is not finished. Push ${b}.`,
        'shift',
        `${a} ${relation} ${b}: shift`,
        null,
        cell,
      );
      continue;
    }

    // a > b: the handle ends here. Walk down to the terminal that yields to the last one popped.
    let lastTerminal = topTerminalAt;
    let handleStart = -1;
    for (;;) {
      const below = terminalAtOrBelow(lastTerminal - 1);
      const between = relationBetween(
        (stack[below] as GrammarStackEntry).symbol,
        (stack[lastTerminal] as GrammarStackEntry).symbol,
      );
      if (between === '<') {
        handleStart = below + 1;
        break;
      }
      if (between !== '=' || below === 0) break;
      lastTerminal = below;
    }
    if (handleStart === -1) {
      fail(
        b,
        [],
        `The handle ending at ${a} has no clear start: nothing below it on the stack yields to it. Syntax error at token ${position + 1}.`,
        cell,
      );
      continue;
    }

    const handle = stack.slice(handleStart);
    const production = matchHandle(handle);
    if (!production) {
      const shown = handle.map(({ symbol }) => symbol).join(' ');
      fail(
        b,
        [],
        `${shown} looks like a handle, because ${a} > ${b}, but no production has that shape. An operand is probably missing. Syntax error at token ${position + 1}.`,
        cell,
      );
      continue;
    }
    stack.splice(handleStart);
    const node = forest.add(production.head, 'nonterminal');
    forest.adopt(
      node,
      production.id,
      handle.flatMap((item) => (item.node === null ? [] : [item.node])),
    );
    output.push(production.id);
    stack.push({ symbol: production.head, state: null, node });
    record(
      `Reduce by ${formatGrammarProduction(production)}`,
      `${a} > ${b}: ${a} ${RELATION_WORDS['>']} ${b}, so the handle is complete. It runs down the stack until a terminal yields to the one above it. It matches ${formatGrammarProduction(production)}.`,
      'reduce',
      `${a} > ${b}: reduce ${formatGrammarProduction(production)}`,
      production.id,
      cell,
    );
  }

  return {
    grammar,
    tokens,
    nodes: forest.finish(),
    output,
    errors,
    outcome: outcome as GrammarParseOutcome,
    trace: recorder.finish(),
  };
}
