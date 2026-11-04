/*
 * The grammar and parsing engine. Everything here is plain data in and plain data out, so it can
 * cross a Web Worker boundary. Bad input throws EngineError, and `attempt()` turns that into a
 * Result. Every long-running algorithm is bounded, and says so in a readable error.
 *
 * READING A GRAMMAR
 *   parseGrammar(text)                       The format is documented at the top of cfg.ts. A symbol
 *                                            is a nonterminal exactly if it has a production.
 *   grammarFromRules(start, rules)           The same, from rules already split into symbols.
 *   formatGrammar(grammar)                   Text that parses back to the same grammar.
 *   formatGrammarProduction(production)      "E → E + T".
 *   tokenizeGrammarInput(grammar, text)      Splits a sentence into terminals, longest match first.
 *   parseGrammarPrecedence(text)             Reads %left, %right and %nonassoc lines.
 *
 * ANALYSIS
 *   grammarSets(grammar)                     Nullable, FIRST and FOLLOW, with a trace of each pass.
 *   grammarSetMaps(grammar)                  The same as Maps and Sets, with no trace.
 *   grammarFirstOfSequence(maps, symbols)    FIRST of a string of symbols.
 *   grammarCheckSets(grammar, answers)       Marks a student's sets, cell by cell.
 *   grammarDiagnostics(grammar)              Warnings: left recursion, cycles, unreachable symbols.
 *   grammarLeftRecursion(grammar)            Each left-recursive nonterminal, with its kind and path.
 *   grammarFindAmbiguity(grammar, options)   BOUNDED search for a sentence with two parse trees.
 *                                            A witness is a proof. Finding none is not, and the
 *                                            result's message says so.
 *   grammarChartParse(grammar, tokens)       Any CFG. Gives up to two trees and says exactly whether
 *                                            this one sentence is ambiguous.
 *
 * TRANSFORMATIONS, each returning { grammar, changed, notes, trace }
 *   grammarEliminateLeftRecursion(grammar)   Dragon Book Algorithm 4.19, direct and indirect.
 *   grammarLeftFactor(grammar)               Dragon Book Algorithm 4.21.
 *
 * TOP-DOWN
 *   grammarRecursiveDescent(grammar, tokens) Backtracking search, as a GrammarParserRun.
 *   ll1BuildTable(grammar)                   Table, conflicts, synch cells, and a trace.
 *   ll1Parse(table, tokens, { recovery })    Algorithm 4.34, as a GrammarParserRun.
 *
 * BOTTOM-UP. Productions use the numbers of the augmented grammar, table.grammar, where 0 is
 * S' → S, so r1 is the first production written and %prec overrides use the original numbers.
 *   lrAugmentGrammar(grammar)                Adds S' → S.
 *   lr0Closure, lr0Goto, lr1Closure, lr1Goto One step at a time, on an augmented grammar.
 *   lrBuildAutomaton(grammar, kind)          kind is 'lr0', 'lr1' or 'lalr'. States, edges, trace.
 *   lrBuildTable(grammar, kind, options)     kind is 'lr0', 'slr', 'lr1' or 'lalr'. Returns
 *                                            cells (all actions), action (the chosen one), goto,
 *                                            conflicts, shiftReduceCount, reduceReduceCount,
 *                                            resolutions, automaton and trace. Pass
 *                                            { precedence } to settle conflicts as Yacc does.
 *   lrFormatAction(table, action)            "s5", "r3" or "acc".
 *   lrFormatItem(grammar, item)              "C → · c C, c/d".
 *   lrParse(table, tokens, { recovery })     Algorithm 4.44, as a GrammarParserRun, with any table.
 *
 * OPERATOR PRECEDENCE
 *   opPrecedenceBuildTable(grammar, precedence?)   LEADING, TRAILING, relations, conflicts, trace.
 *   opPrecedenceParse(table, tokens)               A GrammarParserRun with a skeleton tree.
 *
 * PARSE TREES AND DERIVATIONS
 *   grammarDerivation(grammar, tree, order)  Leftmost or rightmost, as steps and a trace.
 *   grammarDerivationSteps(tree, order)      The steps without text.
 *   grammarCompareTrees(grammar, trees)      Two trees side by side, as leftmost derivations.
 *   grammarForestRoots(nodes, nodeCount)     Which nodes have no parent yet at a step of a run.
 *   grammarTreeYield(tree)                   The terminals of a tree, left to right.
 *
 * THE DRIVERS' SHARED RESULT, GrammarParserRun
 *   { grammar, tokens, nodes, output, errors, outcome, trace }. Each step of the trace has move,
 *   action, stack, position, nodeCount, errorCount, outputCount, production and cell. Nodes form a
 *   flat array, so a step only says how many exist. `output` is a leftmost derivation top-down, and
 *   the reduction sequence bottom-up. `recovery` is 'none', 'panic' or 'phrase'.
 *
 * BUILDING MINI-YACC OR A CONFLICT EXPLORER ON THIS
 *   const table = lrBuildTable(parseGrammar(text), 'lalr', { precedence });
 *   table.conflicts          What y.output would list, in state order, with the responsible items.
 *   table.action, table.goto A table a driver can run. Conflicts have Yacc's default resolution.
 *   table.resolutions        Conflicts that precedence settled, each with the reason.
 *   lrParse(table, tokens)   Runs it.
 * To show a state or conflict, give the `lr-automaton` visualizer the same grammar text, kind and
 * precedence lines through its `initial` props, and it numbers its states the same way. Use the
 * original text, not table.grammar, which is already augmented and would be augmented again. See
 * apps/web/src/visualizers/parsing/lr-automaton.tsx.
 */
export {
  GRAMMAR_END_MARKER,
  GRAMMAR_EPSILON,
  MAX_GRAMMAR_BODY,
  MAX_GRAMMAR_INPUT_TOKENS,
  MAX_GRAMMAR_PRODUCTIONS,
  MAX_GRAMMAR_TEXT,
  MAX_PARSER_MOVES,
  MAX_PARSER_STACK,
} from './types';
export type {
  Grammar,
  GrammarParseIssue,
  GrammarParseNode,
  GrammarParseNodeKind,
  GrammarParseOutcome,
  GrammarParserMove,
  GrammarParserRun,
  GrammarParserStep,
  GrammarParseTree,
  GrammarPrecedence,
  GrammarPrecedenceLevel,
  GrammarProduction,
  GrammarRecovery,
  GrammarSetRow,
  GrammarStackEntry,
  GrammarTableCell,
  GrammarWarning,
} from './types';

export {
  formatGrammar,
  formatGrammarBody,
  formatGrammarProduction,
  GRAMMAR_INPUT_ERROR_CODES,
  grammarFromRules,
  parseGrammar,
  parseGrammarPrecedence,
  tokenizeGrammarInput,
} from './cfg';
export type { GrammarInputToken, GrammarRule } from './cfg';

export { grammarForestRoots, grammarTreeYield } from './forest';

export {
  grammarCheckSets,
  grammarFirstOfSequence,
  grammarParseSetText,
  grammarSetMaps,
  grammarSetRows,
  grammarSets,
} from './sets';
export type {
  GrammarSetAnswer,
  GrammarSetCheck,
  GrammarSetKind,
  GrammarSetMaps,
  GrammarSets,
  GrammarSetsPhase,
  GrammarSetsState,
  GrammarSetVerdict,
} from './sets';

export {
  grammarCycles,
  grammarDiagnostics,
  grammarLeftRecursion,
  grammarProductiveSymbols,
  grammarReachableSymbols,
} from './diagnostics';
export type { GrammarLeftRecursion, GrammarLeftRecursionKind } from './diagnostics';

export { grammarEliminateLeftRecursion, grammarLeftFactor } from './transform';
export type { GrammarRuleRow, GrammarTransformResult, GrammarTransformStep } from './transform';

export { grammarChartParse, MAX_CHART_TOKENS } from './chart';
export type { GrammarChartResult } from './chart';

export { grammarDerivation, grammarDerivationSteps } from './derivation';
export type {
  GrammarDerivation,
  GrammarDerivationOrder,
  GrammarDerivationStep,
} from './derivation';

export {
  DEFAULT_AMBIGUITY_LENGTH,
  grammarCompareTrees,
  grammarFindAmbiguity,
  MAX_AMBIGUITY_LENGTH,
} from './ambiguity';
export type {
  GrammarAmbiguityOptions,
  GrammarAmbiguityResult,
  GrammarAmbiguityStop,
  GrammarAmbiguityWitness,
  GrammarTreeComparisonSide,
  GrammarTreeComparisonStep,
} from './ambiguity';

export { grammarRecursiveDescent } from './recursive-descent';

export { ll1BuildTable } from './ll1';
export type { Ll1Conflict, Ll1ConflictKind, Ll1Table, Ll1TableStep } from './ll1';
export { ll1Parse } from './ll1-parse';
export type { GrammarParseOptions } from './ll1-parse';

export {
  lr0Closure,
  lr0Goto,
  lr1Closure,
  lr1Goto,
  lrAugmentGrammar,
  lrBuildAutomaton,
  lrFormatItem,
  MAX_LR_STATES,
} from './lr-items';
export type {
  LrAutomaton,
  LrAutomatonKind,
  LrBuildStep,
  LrEdge,
  LrItem,
  LrState,
  LrTransition,
} from './lr-items';

export { lrBuildTable, lrFormatAction } from './lr-table';
export type {
  LrAction,
  LrConflict,
  LrConflictKind,
  LrPrecedenceResolution,
  LrTable,
  LrTableKind,
  LrTableOptions,
} from './lr-table';
export { lrParse } from './lr-parse';

export { opPrecedenceBuildTable, opPrecedenceParse } from './op-precedence';
export type {
  OpPrecedenceConflict,
  OpPrecedenceStep,
  OpPrecedenceTable,
  OpRelation,
} from './op-precedence';
