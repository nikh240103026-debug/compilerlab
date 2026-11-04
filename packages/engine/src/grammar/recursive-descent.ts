import { EngineError } from '../core/result';
import { TraceRecorder } from '../core/trace';
import { formatGrammarProduction, indexGrammar } from './cfg';
import { grammarLeftRecursion } from './diagnostics';
import {
  GRAMMAR_END_MARKER,
  GRAMMAR_EPSILON,
  MAX_PARSER_MOVES,
  type Grammar,
  type GrammarParseIssue,
  type GrammarParseNode,
  type GrammarParseOutcome,
  type GrammarParserMove,
  type GrammarParserRun,
  type GrammarParserStep,
  type GrammarProduction,
  type GrammarStackEntry,
} from './types';

/** A nonterminal's procedure, frozen at the moment it was called, so it can be tried again. */
interface ChoicePoint {
  readonly symbol: string;
  readonly node: number;
  readonly alternatives: readonly GrammarProduction[];
  next: number;
  readonly stack: readonly GrammarStackEntry[];
  readonly position: number;
  readonly nodes: readonly GrammarParseNode[];
  readonly output: readonly number[];
}

const entry = (symbol: string, node: number | null): GrammarStackEntry => ({
  symbol,
  state: null,
  node,
});

/**
 * Recursive descent with backtracking, as Dragon Book 4.4.1 describes: to call a nonterminal, try
 * its productions in order, and when one fails, reset the input pointer and try the next.
 *
 * The stack here holds what is still to be matched, which is what the call stack of a real
 * recursive-descent parser holds implicitly. Backtracking is full: if a nonterminal's first
 * production succeeds but something after it fails, the search comes back and tries the next one.
 * So it finds a parse whenever one exists, at the cost of possibly exponential time, and the number
 * of moves is bounded. Left recursion would never return, so it is refused up front.
 */
export function grammarRecursiveDescent(
  grammar: Grammar,
  tokens: readonly string[],
): GrammarParserRun {
  const recursion = grammarLeftRecursion(grammar);
  const first = recursion[0];
  if (first) {
    throw new EngineError({
      code: 'left_recursive',
      message: `${first.symbol} is left recursive, so its procedure would call itself forever without reading any input.`,
      hint: 'Eliminate left recursion first. The grammar workbench can do it for you.',
    });
  }

  const { nonterminals, byHead } = indexGrammar(grammar);
  const recorder = new TraceRecorder<GrammarParserStep>();
  const root: GrammarParseNode = {
    id: 0,
    symbol: grammar.start,
    kind: 'nonterminal',
    production: null,
    children: [],
    parent: null,
    token: null,
  };

  let nodes: readonly GrammarParseNode[] = [root];
  let stack: readonly GrammarStackEntry[] = [
    entry(GRAMMAR_END_MARKER, null),
    entry(grammar.start, 0),
  ];
  let position = 0;
  let output: readonly number[] = [];
  let moves = 0;
  const choices: ChoicePoint[] = [];
  // The farthest the parser got, which is the most useful place to blame if all attempts fail.
  let furthest = 0;
  const expectedThere = new Set<string>();

  const record = (
    title: string,
    explanation: string,
    move: GrammarParserMove,
    action: string,
    production: number | null = null,
    errorCount = 0,
  ) => {
    recorder.add(title, explanation, {
      move,
      action,
      stack,
      position,
      nodeCount: nodes.length,
      errorCount,
      outputCount: output.length,
      production,
      cell: null,
      nodes,
    });
  };

  const noteFailure = (expected: string) => {
    if (position > furthest) {
      furthest = position;
      expectedThere.clear();
    }
    if (position === furthest) expectedThere.add(expected);
  };

  /** Restarts a choice point with one of its productions: the heart of backtracking. */
  const tryAlternative = (choice: ChoicePoint, production: GrammarProduction) => {
    const parent = choice.nodes[choice.node] as GrammarParseNode;
    const bodySymbols = production.body.length > 0 ? production.body : [GRAMMAR_EPSILON];
    const children = bodySymbols.map((symbol, offset): GrammarParseNode => ({
      id: choice.nodes.length + offset,
      symbol,
      kind:
        production.body.length === 0
          ? 'epsilon'
          : nonterminals.has(symbol)
            ? 'nonterminal'
            : 'terminal',
      production: null,
      children: [],
      parent: choice.node,
      token: null,
    }));
    const updated = choice.nodes.slice();
    updated[choice.node] = {
      ...parent,
      production: production.id,
      children: children.map(({ id }) => id),
    };
    nodes = [...updated, ...children];
    stack = [
      ...choice.stack,
      ...children
        .filter(({ kind }) => kind !== 'epsilon')
        .reverse()
        .map(({ id, symbol }) => entry(symbol, id)),
    ];
    position = choice.position;
    output = [...choice.output, production.id];
  };

  /** Finds the most recent choice with an untried production. False if there are none left. */
  const backtrack = (reason: string): boolean => {
    for (let choice = choices.at(-1); choice; choice = choices.at(-1)) {
      const production = choice.alternatives[choice.next];
      if (production) {
        choice.next++;
        tryAlternative(choice, production);
        record(
          `Backtrack: try ${choice.symbol} again`,
          `${reason} Go back to the last choice: reset the input pointer to token ${choice.position + 1}, undo everything since, and try the next production of ${choice.symbol}, ${formatGrammarProduction(production)}.`,
          'backtrack',
          `retry ${formatGrammarProduction(production)}`,
          production.id,
        );
        return true;
      }
      choices.pop();
      nodes = choice.nodes;
      stack = [...choice.stack, entry(choice.symbol, choice.node)];
      position = choice.position;
      output = choice.output;
      record(
        `${choice.symbol} has no productions left`,
        `${reason} Every production of ${choice.symbol} has been tried from token ${choice.position + 1}, so ${choice.symbol} itself fails here. Its caller has to try something else.`,
        'backtrack',
        `${choice.symbol} fails`,
      );
      reason = `${choice.symbol} failed.`;
    }
    return false;
  };

  record(
    'Call the start symbol',
    `A recursive-descent parser has one procedure for each nonterminal. Parsing starts by calling ${grammar.start}, with the input pointer on the first token.`,
    'start',
    `call ${grammar.start}`,
  );

  let outcome: GrammarParseOutcome | null = null;
  const errors: GrammarParseIssue[] = [];

  while (outcome === null) {
    if (++moves > MAX_PARSER_MOVES) {
      throw new EngineError({
        code: 'backtracking_too_long',
        message: `Backtracking took over ${MAX_PARSER_MOVES} moves without finishing.`,
        hint: 'Backtracking can take exponential time. Try a shorter sentence, or left factor the grammar so fewer alternatives have to be tried.',
      });
    }
    const top = stack.at(-1) as GrammarStackEntry;
    const lookahead = tokens[position] ?? GRAMMAR_END_MARKER;

    let failure: string | null = null;
    if (stack.length === 1) {
      if (position >= tokens.length) {
        record(
          'Accept',
          'Nothing is left to match and all the input has been read. The tree on screen is the parse.',
          'accept',
          'accept',
        );
        outcome = 'accepted';
        continue;
      }
      noteFailure(GRAMMAR_END_MARKER);
      failure = `The grammar is finished, but ${lookahead} is still unread.`;
    } else if (nonterminals.has(top.symbol)) {
      const alternatives = byHead.get(top.symbol) as readonly GrammarProduction[];
      const production = alternatives[0] as GrammarProduction;
      const choice: ChoicePoint = {
        symbol: top.symbol,
        node: top.node as number,
        alternatives,
        next: 1,
        stack: stack.slice(0, -1),
        position,
        nodes,
        output,
      };
      choices.push(choice);
      tryAlternative(choice, production);
      record(
        `Call ${top.symbol}`,
        `Try the ${alternatives.length > 1 ? 'first' : 'only'} production of ${top.symbol}: ${formatGrammarProduction(production)}.${alternatives.length > 1 ? ` Remember token ${position + 1}, in case we have to come back.` : ''}`,
        'expand',
        formatGrammarProduction(production),
        production.id,
      );
      continue;
    } else if (top.symbol === lookahead) {
      const node = nodes[top.node as number] as GrammarParseNode;
      const updated = nodes.slice();
      updated[node.id] = { ...node, token: position };
      nodes = updated;
      stack = stack.slice(0, -1);
      position++;
      record(
        `Match ${top.symbol}`,
        `The next symbol to match is ${top.symbol}, and so is the next token, so move the input pointer forward.`,
        'match',
        `match ${top.symbol}`,
      );
      continue;
    } else {
      noteFailure(top.symbol);
      failure = `This production needs ${top.symbol}, but the next token is ${lookahead}.`;
    }

    if (!backtrack(failure)) {
      const found = tokens[furthest] ?? GRAMMAR_END_MARKER;
      const expected = [...expectedThere];
      const message = `Syntax error at token ${furthest + 1}: found ${found === GRAMMAR_END_MARKER ? 'the end of the input' : found}, expected ${expected.join(' or ')}.`;
      errors.push({ position: furthest, found, expected, message, recovery: '' });
      record(
        'Reject',
        `Every possibility has been tried and none of them works, so this sentence is not in the language. ${message}`,
        'reject',
        'reject',
        null,
        1,
      );
      outcome = 'rejected';
    }
  }

  return {
    grammar,
    tokens,
    nodes,
    output,
    errors,
    outcome,
    trace: recorder.finish(),
  };
}
