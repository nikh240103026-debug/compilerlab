// The parsing visualizers' jobs. These run in the Web Worker, as part of engine/jobs.ts.
import {
  EngineError,
  formatGrammar,
  grammarChartParse,
  grammarCheckSets,
  grammarCompareTrees,
  grammarDerivation,
  grammarDiagnostics,
  grammarEliminateLeftRecursion,
  grammarFindAmbiguity,
  grammarLeftFactor,
  grammarRecursiveDescent,
  grammarSets,
  ll1BuildTable,
  ll1Parse,
  lrBuildTable,
  lrParse,
  opPrecedenceBuildTable,
  opPrecedenceParse,
  parseGrammar,
  parseGrammarPrecedence,
  tokenizeGrammarInput,
  type Grammar,
  type GrammarAmbiguityResult,
  type GrammarDerivation,
  type GrammarParserRun,
  type GrammarParseTree,
  type GrammarRecovery,
  type GrammarSetAnswer,
  type GrammarSetCheck,
  type GrammarSets,
  type GrammarTransformResult,
  type GrammarTreeComparisonStep,
  type GrammarWarning,
  type Ll1Table,
  type LrBuildStep,
  type LrTable,
  type LrTableKind,
  type OpPrecedenceTable,
  type Trace,
} from '@compilerlab/engine';

/** More states than this make a page that nobody can read, or scroll without stuttering. */
const MAX_DRAWN_LR_STATES = 400;
// Long enough to find the dangling else, whose shortest witness has 9 tokens.
const WORKBENCH_AMBIGUITY_LENGTH = 10;
const WORKBENCH_AMBIGUITY_WORK = 400_000;

export type ParserMethod = 'll1' | 'backtrack' | 'lr0' | 'slr' | 'lalr' | 'lr1';

export interface GrammarWorkbenchOutput {
  grammar: Grammar;
  text: string;
  warnings: GrammarWarning[];
  sets: GrammarSets;
  leftRecursion: GrammarTransformResult;
  /** Run on the grammar left recursion elimination produced, the order the transformations go in. */
  leftFactoring: GrammarTransformResult;
  transformedText: string;
  isLl1: boolean;
  transformedIsLl1: boolean;
  ambiguity: GrammarAmbiguityResult;
}

export interface LrAutomatonOutput {
  table: LrTable;
  /** Building the automaton, then filling in the table. */
  trace: Trace<LrBuildStep>;
}

export interface ParserRunOutput {
  run: GrammarParserRun;
  ll1: Ll1Table | null;
  lr: LrTable | null;
}

export interface DerivationOutput {
  grammar: Grammar;
  tokens: readonly string[];
  /** One tree, or two if this sentence is ambiguous. Each comes with both derivations. */
  trees: readonly {
    tree: GrammarParseTree;
    leftmost: GrammarDerivation;
    rightmost: GrammarDerivation;
  }[];
}

export interface AmbiguityOutput {
  grammar: Grammar;
  result: GrammarAmbiguityResult;
  /** Set when the student asked about one sentence. */
  sentence: {
    tokens: readonly string[];
    treeCount: number;
    trees: readonly GrammarParseTree[];
    trace: Trace<GrammarTreeComparisonStep> | null;
  } | null;
}

export interface OperatorPrecedenceOutput {
  table: OpPrecedenceTable;
  run: GrammarParserRun;
}

export interface ParsingJobTypes {
  grammarWorkbench: { input: { grammar: string }; output: GrammarWorkbenchOutput };
  grammarSets: {
    input: { grammar: string };
    output: { grammar: Grammar; sets: GrammarSets };
  };
  grammarCheckSets: {
    input: { grammar: string; answers: readonly GrammarSetAnswer[] };
    output: GrammarSetCheck;
  };
  ll1Table: { input: { grammar: string }; output: Ll1Table };
  lrAutomaton: {
    input: { grammar: string; kind: LrTableKind; precedence: string };
    output: LrAutomatonOutput;
  };
  parserRun: {
    input: { grammar: string; sentence: string; method: ParserMethod; recovery: GrammarRecovery };
    output: ParserRunOutput;
  };
  parseDerivation: {
    input: { grammar: string; sentence: string };
    output: DerivationOutput;
  };
  ambiguitySearch: {
    input: { grammar: string; maxLength: number; sentence: string };
    output: AmbiguityOutput;
  };
  operatorPrecedence: {
    input: { grammar: string; precedence: string; sentence: string };
    output: OperatorPrecedenceOutput;
  };
}

const sentenceTokens = (grammar: Grammar, sentence: string) =>
  tokenizeGrammarInput(grammar, sentence).map(({ text }) => text);

export const parsingHandlers: {
  [K in keyof ParsingJobTypes]: (
    input: ParsingJobTypes[K]['input'],
  ) => ParsingJobTypes[K]['output'];
} = {
  grammarWorkbench: ({ grammar: text }) => {
    const grammar = parseGrammar(text);
    const leftRecursion = grammarEliminateLeftRecursion(grammar);
    const leftFactoring = grammarLeftFactor(leftRecursion.grammar);
    return {
      grammar,
      text: formatGrammar(grammar),
      warnings: grammarDiagnostics(grammar),
      sets: grammarSets(grammar),
      leftRecursion,
      leftFactoring,
      transformedText: formatGrammar(leftFactoring.grammar),
      isLl1: ll1BuildTable(grammar).isLl1,
      transformedIsLl1: ll1BuildTable(leftFactoring.grammar).isLl1,
      ambiguity: grammarFindAmbiguity(grammar, {
        maxLength: WORKBENCH_AMBIGUITY_LENGTH,
        maxWork: WORKBENCH_AMBIGUITY_WORK,
      }),
    };
  },
  grammarSets: ({ grammar: text }) => {
    const grammar = parseGrammar(text);
    return { grammar, sets: grammarSets(grammar) };
  },
  grammarCheckSets: ({ grammar, answers }) => grammarCheckSets(parseGrammar(grammar), answers),
  ll1Table: ({ grammar }) => ll1BuildTable(parseGrammar(grammar)),
  lrAutomaton: ({ grammar, kind, precedence }) => {
    const table = lrBuildTable(parseGrammar(grammar), kind, {
      precedence: parseGrammarPrecedence(precedence),
      maxStates: MAX_DRAWN_LR_STATES,
    });
    return { table, trace: [...table.automaton.trace, ...table.trace] };
  },
  parserRun: ({ grammar: text, sentence, method, recovery }) => {
    const grammar = parseGrammar(text);
    const tokens = sentenceTokens(grammar, sentence);
    if (method === 'backtrack') {
      return { run: grammarRecursiveDescent(grammar, tokens), ll1: null, lr: null };
    }
    if (method === 'll1') {
      const ll1 = ll1BuildTable(grammar);
      return { run: ll1Parse(ll1, tokens, { recovery }), ll1, lr: null };
    }
    const lr = lrBuildTable(grammar, method, { maxStates: MAX_DRAWN_LR_STATES });
    return { run: lrParse(lr, tokens, { recovery }), ll1: null, lr };
  },
  parseDerivation: ({ grammar: text, sentence }) => {
    const grammar = parseGrammar(text);
    const tokens = sentenceTokens(grammar, sentence);
    const { trees } = grammarChartParse(grammar, tokens);
    if (trees.length === 0) {
      throw new EngineError({
        code: 'not_in_language',
        message: `This grammar cannot derive ${tokens.join(' ') || 'the empty string'}.`,
        hint: 'Try a sentence of the language, or check the grammar. The other parsers show where a sentence goes wrong.',
      });
    }
    return {
      grammar,
      tokens,
      trees: trees.map((tree) => ({
        tree,
        leftmost: grammarDerivation(grammar, tree, 'leftmost'),
        rightmost: grammarDerivation(grammar, tree, 'rightmost'),
      })),
    };
  },
  ambiguitySearch: ({ grammar: text, maxLength, sentence }) => {
    const grammar = parseGrammar(text);
    const result = grammarFindAmbiguity(grammar, { maxLength });
    if (!sentence.trim()) return { grammar, result, sentence: null };
    const tokens = sentenceTokens(grammar, sentence);
    const { trees } = grammarChartParse(grammar, tokens);
    const [first, second] = trees;
    return {
      grammar,
      result,
      sentence: {
        tokens,
        treeCount: trees.length,
        trees,
        trace: first && second ? grammarCompareTrees(grammar, [first, second]) : null,
      },
    };
  },
  operatorPrecedence: ({ grammar: text, precedence, sentence }) => {
    const grammar = parseGrammar(text);
    const table = opPrecedenceBuildTable(grammar, parseGrammarPrecedence(precedence));
    return { table, run: opPrecedenceParse(table, sentenceTokens(grammar, sentence)) };
  },
};
