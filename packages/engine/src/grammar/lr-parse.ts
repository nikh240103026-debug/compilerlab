import { EngineError } from '../core/result';
import { TraceRecorder } from '../core/trace';
import { formatGrammarProduction } from './cfg';
import { ForestBuilder } from './forest';
import type { GrammarParseOptions } from './ll1-parse';
import type { LrTable } from './lr-table';
import {
  GRAMMAR_END_MARKER,
  GRAMMAR_EPSILON,
  MAX_PARSER_MOVES,
  MAX_PARSER_STACK,
  type GrammarParseOutcome,
  type GrammarParserMove,
  type GrammarParserRun,
  type GrammarParserStep,
  type GrammarProduction,
  type GrammarStackEntry,
  type GrammarTableCell,
} from './types';

/** How many tokens phrase-level recovery may invent at one spot before it starts deleting. */
const MAX_INSERTS_IN_A_ROW = 3;

const describeToken = (token: string) =>
  token === GRAMMAR_END_MARKER ? 'the end of the input' : token;

/**
 * Dragon Book Algorithm 4.44, the LR parsing driver. It works the same with any LR table, and it
 * also builds the parse tree and the reduction sequence as it goes.
 *
 * Panic mode follows Section 4.8.3: scan down the stack for a state with a GOTO on some nonterminal
 * A, discard input until a token that can follow A, push GOTO(s, A), and carry on as if a whole A
 * had just been parsed. Whatever was popped becomes that A's children in the tree.
 *
 * Phrase-level recovery makes one small local fix. It inserts a terminal if shifting it would let
 * the current token be accepted next, and otherwise deletes the current token. The book's hand-made
 * error routines for this kind of table do much the same: "missing operand" pushes id, and
 * "unbalanced right parenthesis" deletes it.
 */
export function lrParse(
  table: LrTable,
  tokens: readonly string[],
  options: GrammarParseOptions = {},
): GrammarParserRun {
  const recovery = options.recovery ?? 'none';
  const { grammar, terminals, nonterminals, action, goto: gotos } = table;
  const stateLabel = (state: number) => table.automaton.states[state]?.label ?? String(state);
  const columnOf = new Map(terminals.map((symbol, index) => [symbol, index]));
  const gotoColumnOf = new Map(nonterminals.map((symbol, index) => [symbol, index]));
  const actionAt = (state: number, terminal: string) =>
    action[state]?.[columnOf.get(terminal) ?? -1] ?? null;

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
  const stack: GrammarStackEntry[] = [{ symbol: GRAMMAR_END_MARKER, state: 0, node: null }];
  let position = 0;
  let outcome: GrammarParseOutcome | null = null;
  // Keeps recovery from looping at one spot without ever using up any input.
  let lastRecoveryAt = -1;
  let insertsHere = 0;

  const record = (
    title: string,
    explanation: string,
    move: GrammarParserMove,
    text: string,
    production: number | null = null,
    cell: GrammarTableCell | null = null,
  ) => {
    recorder.add(title, explanation, {
      move,
      action: text,
      stack: stack.slice(),
      position,
      nodeCount: forest.size,
      errorCount: issues.length,
      outputCount: output.length,
      production,
      cell,
    });
  };

  const tokenAt = (index: number) => tokens[index] ?? GRAMMAR_END_MARKER;

  const panic = (issue: (typeof issues)[number]): boolean => {
    const skipAtLeast = lastRecoveryAt === position ? 1 : 0;
    for (let depth = stack.length - 1; depth >= 0; depth--) {
      const { state } = stack[depth] as GrammarStackEntry;
      let best: { symbol: string; target: number; next: number } | null = null;
      for (const symbol of nonterminals) {
        const target = gotos[state as number]?.[gotoColumnOf.get(symbol) as number] ?? null;
        if (target === null) continue;
        for (let next = position + skipAtLeast; next <= tokens.length; next++) {
          if (actionAt(target, tokenAt(next)) !== null) {
            if (!best || next < best.next) best = { symbol, target, next };
            break;
          }
        }
      }
      if (!best) continue;

      const popped = stack.splice(depth + 1);
      const node = forest.add(best.symbol, 'error');
      forest.adopt(
        node,
        null,
        popped.flatMap((item) => (item.node === null ? [] : [item.node])),
      );
      stack.push({ symbol: best.symbol, state: best.target, node });
      const skipped = tokens.slice(position, best.next);
      position = best.next;
      lastRecoveryAt = position;
      const did = [
        popped.length > 0 ? `popped ${popped.map(({ symbol }) => symbol).join(' ')}` : '',
        skipped.length > 0 ? `skipped ${skipped.join(' ')}` : '',
        `assumed a whole ${best.symbol}`,
      ]
        .filter(Boolean)
        .join(', ');
      issue.recovery = `${did}.`;
      record(
        'Panic-mode recovery',
        `Scan down the stack for a state with a GOTO on a nonterminal: state ${stateLabel(state as number)} has one on ${best.symbol}. ${did[0]?.toUpperCase()}${did.slice(1)}, then go to state ${stateLabel(best.target)}. Parsing carries on from ${describeToken(tokenAt(position))}.`,
        'recover',
        `recover: goto ${stateLabel(best.target)} on ${best.symbol}`,
      );
      return true;
    }
    return false;
  };

  const phrase = (issue: (typeof issues)[number], lookahead: string): boolean => {
    const state = (stack.at(-1) as GrammarStackEntry).state as number;
    if (insertsHere < MAX_INSERTS_IN_A_ROW) {
      for (const terminal of terminals) {
        const shift = actionAt(state, terminal);
        if (shift?.type !== 'shift' || actionAt(shift.state, lookahead) === null) continue;
        const node = forest.add(terminal, 'error');
        stack.push({ symbol: terminal, state: shift.state, node });
        insertsHere++;
        issue.recovery = `inserted the missing ${terminal}.`;
        record(
          `Insert the missing ${terminal}`,
          `Shifting ${terminal} here would let the parser accept ${describeToken(lookahead)} next, so assume ${terminal} was left out.`,
          'recover',
          `insert ${terminal}`,
        );
        return true;
      }
    }
    if (lookahead !== GRAMMAR_END_MARKER) {
      position++;
      insertsHere = 0;
      issue.recovery = `deleted the unexpected ${lookahead}.`;
      record(
        `Delete ${lookahead}`,
        `No single missing token explains ${lookahead}, so treat it as a stray token and remove it from the input.`,
        'recover',
        `delete ${lookahead}`,
      );
      return true;
    }
    // At the end of the input there is nothing to delete, so fall back on a bigger hammer.
    return panic(issue);
  };

  record(
    'Start',
    'The stack holds state 0, and the input pointer is on the first token. At every move the parser looks up the top state and the next token in the ACTION table.',
    'start',
    '',
  );

  for (let moves = 0; outcome === null; moves++) {
    if (moves >= MAX_PARSER_MOVES || stack.length > MAX_PARSER_STACK) {
      throw new EngineError({
        code: 'parser_loop',
        message: `The parser made ${moves} moves without finishing.`,
        hint: 'A grammar with a cycle, such as A → A, can make an LR parser reduce forever. Remove the cycle.',
      });
    }
    const top = stack.at(-1) as GrammarStackEntry;
    const state = top.state as number;
    const lookahead = tokenAt(position);
    const cell: GrammarTableCell = { row: state, column: columnOf.get(lookahead) ?? -1 };
    const chosen = actionAt(state, lookahead);
    const competing = table.cells[state]?.[cell.column]?.length ?? 0;
    const clash =
      competing > 1
        ? ` This cell has ${competing} actions because of a conflict, so the parser takes the default.`
        : '';

    if (chosen === null) {
      const expected = terminals.filter((terminal) => actionAt(state, terminal) !== null);
      const message = `Syntax error at token ${position + 1}: found ${describeToken(lookahead)}, expected ${expected.map(describeToken).join(' or ') || 'nothing here'}.`;
      const issue = { position, found: lookahead, expected, message, recovery: '' };
      issues.push(issue);
      record(
        'Syntax error',
        `ACTION[${stateLabel(state)}, ${lookahead}] is empty, so this token cannot come here. ${message}`,
        recovery === 'none' ? 'reject' : 'error',
        'error',
        null,
        cell,
      );
      if (recovery === 'none') {
        outcome = 'rejected';
        continue;
      }
      const carriedOn = recovery === 'panic' ? panic(issue) : phrase(issue, lookahead);
      if (!carriedOn) {
        issue.recovery = 'could not find anywhere to carry on from.';
        record(
          'Recovery failed',
          'No state on the stack has a GOTO that leads anywhere useful with the input that is left, so the parser gives up.',
          'reject',
          'give up',
        );
        outcome = 'rejected';
      }
      continue;
    }

    if (chosen.type === 'shift') {
      const node = forest.add(lookahead, 'terminal', { token: position });
      stack.push({ symbol: lookahead, state: chosen.state, node });
      position++;
      insertsHere = 0;
      record(
        `Shift ${lookahead}`,
        `ACTION[${stateLabel(state)}, ${lookahead}] = s${stateLabel(chosen.state)}. Push ${lookahead} and go to state ${stateLabel(chosen.state)}.${clash}`,
        'shift',
        `shift ${stateLabel(chosen.state)}`,
        null,
        cell,
      );
      continue;
    }

    if (chosen.type === 'accept') {
      outcome = issues.length > 0 ? 'recovered' : 'accepted';
      record(
        outcome === 'accepted' ? 'Accept' : 'Finished, with errors',
        outcome === 'accepted'
          ? 'The stack holds the start symbol and only $ is left, so the sentence is accepted. Reading the reductions from last to first gives a rightmost derivation.'
          : `The parser reached the end, but ${issues.length} error${issues.length === 1 ? ' was' : 's were'} reported on the way, so this sentence is not actually in the language.`,
        'accept',
        outcome === 'accepted' ? 'accept' : 'stop',
        null,
        cell,
      );
      continue;
    }

    const production = grammar.productions[chosen.production] as GrammarProduction;
    const handle = production.body.length > 0 ? stack.splice(-production.body.length) : [];
    const node = forest.add(production.head, 'nonterminal');
    const children =
      production.body.length > 0
        ? handle.flatMap((item) => (item.node === null ? [] : [item.node]))
        : [forest.add(GRAMMAR_EPSILON, 'epsilon', { parent: node })];
    forest.adopt(node, production.id, children);
    output.push(production.id);
    const exposed = (stack.at(-1) as GrammarStackEntry).state as number;
    const target = gotos[exposed]?.[gotoColumnOf.get(production.head) as number] ?? null;
    if (target === null) {
      // A valid table cannot get here. Failing readably is better than carrying on with a bad stack.
      throw new EngineError({
        code: 'lr_table_broken',
        message: `This parsing table has no GOTO from state ${stateLabel(exposed)} on ${production.head}.`,
      });
    }
    stack.push({ symbol: production.head, state: target, node });
    record(
      `Reduce by ${formatGrammarProduction(production)}`,
      `ACTION[${stateLabel(state)}, ${lookahead}] = r${production.id}. ${production.body.length > 0 ? `The handle ${production.body.join(' ')} is on top of the stack, so pop ${production.body.length} entr${production.body.length === 1 ? 'y' : 'ies'}` : 'The body is empty, so nothing is popped'}. That exposes state ${stateLabel(exposed)}, and GOTO[${stateLabel(exposed)}, ${production.head}] = ${stateLabel(target)}.${clash}`,
      'reduce',
      `reduce ${formatGrammarProduction(production)}`,
      production.id,
      cell,
    );
  }

  return {
    grammar,
    tokens,
    nodes: forest.finish(),
    output,
    errors: issues,
    outcome: outcome as GrammarParseOutcome,
    trace: recorder.finish(),
  };
}
