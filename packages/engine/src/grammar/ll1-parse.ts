import { EngineError } from '../core/result';
import { TraceRecorder } from '../core/trace';
import { formatGrammarProduction, indexGrammar } from './cfg';
import { ForestBuilder } from './forest';
import type { Ll1Table } from './ll1';
import {
  GRAMMAR_END_MARKER,
  GRAMMAR_EPSILON,
  MAX_PARSER_MOVES,
  MAX_PARSER_STACK,
  type GrammarParseIssue,
  type GrammarParseOutcome,
  type GrammarParserMove,
  type GrammarParserRun,
  type GrammarParserStep,
  type GrammarProduction,
  type GrammarRecovery,
  type GrammarStackEntry,
  type GrammarTableCell,
} from './types';

export interface GrammarParseOptions {
  readonly recovery?: GrammarRecovery;
}

const entry = (symbol: string, node: number | null): GrammarStackEntry => ({
  symbol,
  state: null,
  node,
});

const describeToken = (token: string) =>
  token === GRAMMAR_END_MARKER ? 'the end of the input' : token;

/**
 * Dragon Book Algorithm 4.34, the table-driven predictive parser, with its parse tree growing as it
 * goes. A cell with two productions uses the first, and the step says so.
 *
 * Panic mode follows Section 4.4.5. An empty cell skips the input token. A synch cell pops the
 * nonterminal. A terminal on top that does not match is popped. Phrase-level recovery makes the same
 * moves but only one token at a time and reports each as the fix it is: a missing token, or an
 * unexpected one. It also deletes a token instead of assuming a missing one when the very next
 * token is what the parser wanted.
 */
export function ll1Parse(
  table: Ll1Table,
  tokens: readonly string[],
  options: GrammarParseOptions = {},
): GrammarParserRun {
  const recovery = options.recovery ?? 'none';
  const { grammar, terminals, cells, synch } = table;
  const { nonterminals } = indexGrammar(grammar);
  const rowOf = new Map(table.nonterminals.map((symbol, index) => [symbol, index]));
  const columnOf = new Map(terminals.map((symbol, index) => [symbol, index]));
  const recorder = new TraceRecorder<GrammarParserStep>();
  const forest = new ForestBuilder();
  const output: number[] = [];
  const issues: {
    position: number;
    found: string;
    expected: string[];
    message: string;
    recovery: string;
  }[] = [];

  const root = forest.add(grammar.start, 'nonterminal');
  const stack: GrammarStackEntry[] = [entry(GRAMMAR_END_MARKER, null), entry(grammar.start, root)];
  let position = 0;
  // While true, more trouble belongs to the same error, not a new one.
  let recovering = false;
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
      errorCount: issues.length,
      outputCount: output.length,
      production,
      cell,
    });
  };

  const report = (found: string, expected: readonly string[]): string => {
    const message = `Syntax error at token ${position + 1}: found ${describeToken(found)}, expected ${expected.map(describeToken).join(' or ') || 'nothing here'}.`;
    if (!recovering) {
      issues.push({ position, found, expected: [...expected], message, recovery: '' });
      recovering = true;
    }
    return message;
  };

  const noteRecovery = (text: string) => {
    const issue = issues.at(-1);
    if (issue) issue.recovery = issue.recovery ? `${issue.recovery} Then: ${text}` : text;
  };

  const reject = (explanation: string, cell: GrammarTableCell | null) => {
    record('Syntax error', explanation, 'reject', 'error', null, cell);
    outcome = 'rejected';
  };

  record(
    'Start',
    `The stack holds ${grammar.start} on top of $, and the input pointer is on the first token. The parser only ever looks at the top of the stack and the next token.`,
    'start',
    '',
  );

  for (let moves = 0; outcome === null; moves++) {
    if (moves >= MAX_PARSER_MOVES || stack.length > MAX_PARSER_STACK) {
      throw new EngineError({
        code: 'parser_loop',
        message: `The parser made ${moves} moves without finishing, and its stack is ${stack.length} symbols deep.`,
        hint: 'Left recursion makes a table-driven LL parser expand forever without reading any input. Eliminate it first.',
      });
    }
    const top = stack.at(-1) as GrammarStackEntry;
    const lookahead = tokens[position] ?? GRAMMAR_END_MARKER;
    const nextToken = tokens[position + 1] ?? GRAMMAR_END_MARKER;

    if (stack.length === 1) {
      if (lookahead === GRAMMAR_END_MARKER) {
        outcome = issues.length > 0 ? 'recovered' : 'accepted';
        record(
          outcome === 'accepted' ? 'Accept' : 'Finished, with errors',
          outcome === 'accepted'
            ? 'The stack is down to $ and so is the input, so the sentence is accepted.'
            : `The stack is down to $ and so is the input, but ${issues.length} error${issues.length === 1 ? ' was' : 's were'} reported on the way, so this sentence is not actually in the language.`,
          'accept',
          outcome === 'accepted' ? 'accept' : 'stop',
        );
        continue;
      }
      const message = report(lookahead, [GRAMMAR_END_MARKER]);
      if (recovery === 'none') {
        reject(`The stack is empty, but ${lookahead} is still unread. ${message}`, null);
        continue;
      }
      const skipped = tokens.length - position;
      position = tokens.length;
      noteRecovery(`discarded the last ${skipped} tokens, since nothing is left to match.`);
      record(
        'Error: input left over',
        `${message} The parser has nothing left to match, so it discards the rest of the input.`,
        'recover',
        `error, skip ${skipped} token${skipped === 1 ? '' : 's'}`,
      );
      continue;
    }

    if (!nonterminals.has(top.symbol)) {
      if (top.symbol === lookahead) {
        stack.pop();
        forest.setToken(top.node as number, position);
        position++;
        recovering = false;
        record(
          `Match ${top.symbol}`,
          `The top of the stack is the terminal ${top.symbol}, and so is the next token. Pop it and move the input pointer forward.`,
          'match',
          `match ${top.symbol}`,
        );
        continue;
      }
      const message = report(lookahead, [top.symbol]);
      if (recovery === 'none') {
        reject(
          `The top of the stack is ${top.symbol}, which must match the next token. ${message}`,
          null,
        );
        continue;
      }
      if (recovery === 'phrase' && lookahead !== GRAMMAR_END_MARKER && nextToken === top.symbol) {
        noteRecovery(`deleted the unexpected ${lookahead}.`);
        position++;
        record(
          `Delete ${lookahead}`,
          `${message} The token after it is the ${top.symbol} the parser wanted, so ${lookahead} looks like a stray token. Delete it.`,
          'recover',
          `error, delete ${lookahead}`,
        );
        continue;
      }
      stack.pop();
      forest.setKind(top.node as number, 'error');
      noteRecovery(
        recovery === 'phrase'
          ? `assumed a missing ${top.symbol}.`
          : `popped ${top.symbol} from the stack.`,
      );
      record(
        recovery === 'phrase' ? `Insert the missing ${top.symbol}` : `Pop ${top.symbol}`,
        recovery === 'phrase'
          ? `${message} Assume ${top.symbol} was left out, as if it had been there, and carry on.`
          : `${message} A terminal on the stack that does not match can only be popped, as if it had been inserted.`,
        'recover',
        recovery === 'phrase' ? `error, insert ${top.symbol}` : `error, pop ${top.symbol}`,
      );
      continue;
    }

    const row = rowOf.get(top.symbol) as number;
    const column = columnOf.get(lookahead) ?? -1;
    const cell: GrammarTableCell = { row, column };
    const rowCells = cells[row] as readonly (readonly number[])[];
    const entered = rowCells[column] ?? [];
    const productionId = entered[0];

    if (productionId !== undefined) {
      const production = grammar.productions[productionId] as GrammarProduction;
      const parent = top.node as number;
      stack.pop();
      output.push(production.id);
      if (production.body.length === 0) {
        forest.adopt(parent, production.id, [forest.add(GRAMMAR_EPSILON, 'epsilon', { parent })]);
      } else {
        const children = production.body.map((symbol) =>
          forest.add(symbol, nonterminals.has(symbol) ? 'nonterminal' : 'terminal', { parent }),
        );
        forest.adopt(parent, production.id, children);
        for (let index = children.length - 1; index >= 0; index--) {
          stack.push(entry(production.body[index] as string, children[index] as number));
        }
      }
      const clash =
        entered.length > 1
          ? ` This cell has ${entered.length} productions because the grammar is not LL(1), so the parser just takes the first.`
          : '';
      record(
        `Expand ${top.symbol}`,
        `M[${top.symbol}, ${lookahead}] says to use ${formatGrammarProduction(production)}. Replace ${top.symbol} on the stack with its body, first symbol on top.${clash}`,
        'expand',
        `output ${formatGrammarProduction(production)}`,
        production.id,
        cell,
      );
      continue;
    }

    const expected = terminals.filter(
      (_, index) => (rowCells[index] as readonly number[]).length > 0,
    );
    const message = report(lookahead, expected);
    if (recovery === 'none') {
      reject(`M[${top.symbol}, ${lookahead}] is empty. ${message}`, cell);
      continue;
    }
    const isSynch = synch[row]?.[column] === true;
    if (isSynch || lookahead === GRAMMAR_END_MARKER) {
      stack.pop();
      forest.setKind(top.node as number, 'error');
      noteRecovery(
        recovery === 'phrase' ? `assumed ${top.symbol} was empty here.` : `popped ${top.symbol}.`,
      );
      record(
        recovery === 'phrase' ? `Assume ${top.symbol} is missing` : `Synch: pop ${top.symbol}`,
        isSynch
          ? `${message} ${lookahead} can follow ${top.symbol}, so ${top.symbol} looks finished or missing. Pop it and try to carry on from there.`
          : `${message} The input has ended, so there is nothing to skip. Pop ${top.symbol} and carry on.`,
        'recover',
        isSynch ? `error, synch: pop ${top.symbol}` : `error, pop ${top.symbol}`,
        null,
        cell,
      );
      continue;
    }
    noteRecovery(
      recovery === 'phrase' ? `deleted the unexpected ${lookahead}.` : `skipped ${lookahead}.`,
    );
    position++;
    record(
      recovery === 'phrase' ? `Delete ${lookahead}` : `Skip ${lookahead}`,
      `${message} ${lookahead} can neither start ${top.symbol} nor follow it, so discard it and look at the next token.`,
      'recover',
      recovery === 'phrase' ? `error, delete ${lookahead}` : `error, skip ${lookahead}`,
      null,
      cell,
    );
  }

  return {
    grammar,
    tokens,
    nodes: forest.finish(),
    output,
    errors: issues as readonly GrammarParseIssue[],
    outcome: outcome as GrammarParseOutcome,
    trace: recorder.finish(),
  };
}
