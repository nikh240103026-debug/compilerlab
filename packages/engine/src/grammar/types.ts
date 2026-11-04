import type { Trace } from '../core/trace';

/** The empty string, written the way the book writes it. */
export const GRAMMAR_EPSILON = 'ε';
/** The end-of-input marker that follows every sentence. */
export const GRAMMAR_END_MARKER = '$';

export const MAX_GRAMMAR_TEXT = 20_000;
export const MAX_GRAMMAR_PRODUCTIONS = 300;
export const MAX_GRAMMAR_BODY = 64;
/** The longest sentence a parser will animate. */
export const MAX_GRAMMAR_INPUT_TOKENS = 300;
/** A parser that makes this many moves is stopped, so a bad table can never hang the page. */
export const MAX_PARSER_MOVES = 5_000;
export const MAX_PARSER_STACK = 2_000;

export interface GrammarProduction {
  /** Its index in `Grammar.productions`. */
  readonly id: number;
  readonly head: string;
  /** An empty body is an ε-production. */
  readonly body: readonly string[];
}

export interface GrammarWarning {
  readonly code: string;
  readonly message: string;
  readonly symbols: readonly string[];
}

/**
 * A context-free grammar. A symbol is a nonterminal exactly when it has a production, and every
 * other symbol is a terminal.
 */
export interface Grammar {
  readonly start: string;
  /** In order of first appearance as a head. */
  readonly nonterminals: readonly string[];
  /** In order of first appearance in a body. Never includes $ or ε. */
  readonly terminals: readonly string[];
  readonly productions: readonly GrammarProduction[];
  /** Things the text parser noticed that are legal but probably not what was meant. */
  readonly warnings: readonly GrammarWarning[];
}

/** One row of a FIRST, FOLLOW, LEADING or TRAILING table. */
export interface GrammarSetRow {
  readonly symbol: string;
  readonly items: readonly string[];
}

export type GrammarParseNodeKind = 'nonterminal' | 'terminal' | 'epsilon' | 'error';

/**
 * A node of a parse tree or forest. Nodes live in a flat array and refer to each other by index,
 * so a trace can share one array and only say how many of its nodes exist at each step.
 */
export interface GrammarParseNode {
  readonly id: number;
  readonly symbol: string;
  /** `error` marks a symbol that error recovery assumed, popped or stood in for. */
  readonly kind: GrammarParseNodeKind;
  /** The production that expanded this node, in the numbering of the run's grammar. */
  readonly production: number | null;
  readonly children: readonly number[];
  readonly parent: number | null;
  /** For a terminal: which input token it matched. */
  readonly token: number | null;
}

export interface GrammarParseTree {
  readonly nodes: readonly GrammarParseNode[];
  readonly root: number;
}

/**
 * What a driver does at a syntax error. `panic` discards input and stack until it can carry on.
 * `phrase` makes one small local fix, inserting or deleting a token, as Dragon Book 4.4.5 and
 * 4.8.3 describe.
 */
export type GrammarRecovery = 'none' | 'panic' | 'phrase';

export type GrammarParserMove =
  | 'start'
  | 'expand'
  | 'match'
  | 'shift'
  | 'reduce'
  | 'accept'
  | 'error'
  | 'recover'
  | 'reject'
  | 'backtrack';

export interface GrammarStackEntry {
  /** A grammar symbol, or $ at the bottom of the stack. */
  readonly symbol: string;
  /** The LR state for this entry. Null in the top-down parsers. */
  readonly state: number | null;
  /** The parse tree node for this entry. Null for $. */
  readonly node: number | null;
}

/** Row and column of a parsing table, counting from 0 among the data cells. */
export interface GrammarTableCell {
  readonly row: number;
  readonly column: number;
}

/** One move of any driver. The stack is listed bottom first, so the top is last. */
export interface GrammarParserStep {
  readonly move: GrammarParserMove;
  /** Short text for the Action column of a moves table, such as "shift 5". */
  readonly action: string;
  readonly stack: readonly GrammarStackEntry[];
  /** The next unread token. Equal to the token count when only $ is left. */
  readonly position: number;
  /** Nodes with an id below this exist at this step. */
  readonly nodeCount: number;
  readonly errorCount: number;
  /** How many items of the run's output exist at this step. */
  readonly outputCount: number;
  readonly production: number | null;
  readonly cell: GrammarTableCell | null;
  /** Only backtracking sets this, because only there can the tree shrink. */
  readonly nodes?: readonly GrammarParseNode[];
}

export interface GrammarParseIssue {
  /** Which token, counting from 0. */
  readonly position: number;
  readonly found: string;
  readonly expected: readonly string[];
  readonly message: string;
  /** What recovery did about it. Empty if the parser just stopped. */
  readonly recovery: string;
}

export type GrammarParseOutcome = 'accepted' | 'recovered' | 'rejected';

/** The shared result of the LL, LR, operator-precedence and backtracking drivers. */
export interface GrammarParserRun {
  /** The grammar whose production numbers this run uses. LR runs use the augmented grammar. */
  readonly grammar: Grammar;
  readonly tokens: readonly string[];
  readonly nodes: readonly GrammarParseNode[];
  /**
   * Productions in the order the parser applied them. Top-down that is a leftmost derivation,
   * and bottom-up it is the reduction sequence, a rightmost derivation in reverse.
   */
  readonly output: readonly number[];
  readonly errors: readonly GrammarParseIssue[];
  readonly outcome: GrammarParseOutcome;
  readonly trace: Trace<GrammarParserStep>;
}

/** Operator precedence declarations, as %left, %right and %nonassoc write them. */
export interface GrammarPrecedenceLevel {
  readonly assoc: 'left' | 'right' | 'nonassoc';
  readonly terminals: readonly string[];
}

export interface GrammarPrecedence {
  /** Lowest precedence first, the same order as a Yacc file. */
  readonly levels: readonly GrammarPrecedenceLevel[];
  /**
   * %prec overrides, by production id in the grammar given to the table builder. Without one, a
   * production takes the precedence of its last terminal.
   */
  readonly productions?: readonly { readonly production: number; readonly terminal: string }[];
}
