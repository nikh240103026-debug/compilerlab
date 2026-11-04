/** The book's grammars, so a student can start from a known answer. */
export interface GrammarPreset {
  label: string;
  grammar: string;
  sentence?: string;
  precedence?: string;
}

export const EXPRESSION: GrammarPreset = {
  label: 'Expressions',
  grammar: 'E -> E + T | T\nT -> T * F | F\nF -> ( E ) | id',
  sentence: 'id + id * id',
};

export const EXPRESSION_LL: GrammarPreset = {
  label: 'Expressions, LL(1)',
  grammar: "E -> T E'\nE' -> + T E' | ε\nT -> F T'\nT' -> * F T' | ε\nF -> ( E ) | id",
  sentence: 'id + id * id',
};

export const AMBIGUOUS_EXPRESSION: GrammarPreset = {
  label: 'Ambiguous expressions',
  grammar: 'E -> E + E | E * E | ( E ) | id',
  sentence: 'id + id * id',
  precedence: '%left +\n%left *',
};

export const DANGLING_ELSE: GrammarPreset = {
  label: 'Dangling else',
  grammar: 'S -> i E t S | i E t S e S | a\nE -> b',
  sentence: 'i b t i b t a e a',
};

export const TWO_C: GrammarPreset = {
  label: 'S → C C',
  grammar: 'S -> C C\nC -> c C | d',
  sentence: 'c d d',
};

export const NOT_SLR: GrammarPreset = {
  label: 'Not SLR',
  grammar: 'S -> L = R | R\nL -> * R | id\nR -> L',
  sentence: '* id = id',
};

export const NOT_LALR: GrammarPreset = {
  label: 'LR(1), not LALR',
  grammar: 'S -> a A d | b B d | a B e | b A e\nA -> c\nB -> c',
  sentence: 'a c d',
};

export const BACKTRACKING: GrammarPreset = {
  label: 'S → c A d',
  grammar: 'S -> c A d\nA -> a b | a',
  sentence: 'c a d',
};

export const INDIRECT_RECURSION: GrammarPreset = {
  label: 'Indirect left recursion',
  grammar: 'S -> A a | b\nA -> A c | S d | ε',
  sentence: 'b d a',
};

export const BALANCED: GrammarPreset = {
  label: 'Balanced brackets',
  grammar: 'S -> ( S ) S | ε',
  sentence: '( ( ) ) ( )',
};

export const PALINDROMES: GrammarPreset = {
  label: 'S → S S',
  grammar: 'S -> S S | a',
  sentence: 'a a a',
};
