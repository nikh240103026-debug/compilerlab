import type { VisualizerId } from '@compilerlab/shared/constants';
import type { ComponentType } from 'react';
import type { VisualizerProps } from './shared';

export interface VisualizerEntry {
  id: VisualizerId;
  title: string;
  description: string;
  /** The course module this belongs to. */
  moduleNumber: number;
  /** Each visualizer is its own chunk, so nothing heavy loads until it is opened. */
  load: () => Promise<{ default: ComponentType<VisualizerProps> }>;
}

export const VISUALIZERS: readonly VisualizerEntry[] = [
  {
    id: 'token-stream',
    title: 'Token stream player',
    description: 'Watch a scanner read real code, apply longest match, and emit tokens.',
    moduleNumber: 1,
    load: () => import('./token-stream'),
  },
  {
    id: 'input-buffer',
    title: 'Input buffering',
    description: 'See the buffer pair, its sentinels, and the lexemeBegin and forward pointers.',
    moduleNumber: 1,
    load: () => import('./input-buffer'),
  },
  {
    id: 'automata-builder',
    title: 'Automata builder',
    description: 'Drag states, draw edges, test strings, and check your work against a regex.',
    moduleNumber: 1,
    load: () => import('./automata-builder'),
  },
  {
    id: 'automaton-run',
    title: 'Automaton simulator',
    description: 'Run a string on an NFA, a DFA, or the minimal DFA, one character at a time.',
    moduleNumber: 1,
    load: () => import('./automaton-run'),
  },
  {
    id: 'regex-to-nfa',
    title: 'Regex to NFA',
    description: "Build an NFA from a regular expression with Thompson's construction.",
    moduleNumber: 1,
    load: () => import('./regex-to-nfa'),
  },
  {
    id: 'subset-construction',
    title: 'Subset construction',
    description: 'Fill in a DFA transition table from an NFA, one cell at a time.',
    moduleNumber: 1,
    load: () => import('./subset-construction'),
  },
  {
    id: 'dfa-minimization',
    title: 'DFA minimization',
    description:
      "Split states into groups with Hopcroft's algorithm until only real differences remain.",
    moduleNumber: 1,
    load: () => import('./dfa-minimization'),
  },
  {
    id: 'followpos',
    title: 'Regex to DFA directly',
    description:
      'Skip the NFA: compute nullable, firstpos, lastpos and followpos from the syntax tree.',
    moduleNumber: 1,
    load: () => import('./followpos'),
  },
  {
    id: 'grammar-workbench',
    title: 'Grammar workbench',
    description:
      'Edit a grammar and see its warnings, left recursion removed, left factoring, FIRST and FOLLOW.',
    moduleNumber: 2,
    load: () => import('./parsing/grammar-workbench'),
  },
  {
    id: 'first-follow',
    title: 'FIRST and FOLLOW practice',
    description: 'Fill in the sets yourself, have them checked, then watch how they are computed.',
    moduleNumber: 2,
    load: () => import('./parsing/first-follow-fill'),
  },
  {
    id: 'll1-table',
    title: 'LL(1) parsing table',
    description: 'Fill in the table one production at a time, with conflicts highlighted.',
    moduleNumber: 2,
    load: () => import('./parsing/ll1-table'),
  },
  {
    id: 'lr-automaton',
    title: 'LR automaton',
    description:
      'Build the item sets and the table for SLR, LR(1) and LALR, and find the conflicts.',
    moduleNumber: 2,
    load: () => import('./parsing/lr-automaton'),
  },
  {
    id: 'parser-stack',
    title: 'Parser stack animator',
    description:
      'Watch an LL or LR parser work through a sentence, with its stack, input tape and parse tree.',
    moduleNumber: 2,
    load: () => import('./parsing/parser-stack'),
  },
  {
    id: 'parse-tree-derivation',
    title: 'Parse tree and derivation',
    description: 'See one parse tree grow beside its leftmost and rightmost derivations.',
    moduleNumber: 2,
    load: () => import('./parsing/parse-tree-derivation'),
  },
  {
    id: 'ambiguity-explorer',
    title: 'Ambiguity explorer',
    description: 'Search for a sentence with two parse trees, and compare the two side by side.',
    moduleNumber: 2,
    load: () => import('./parsing/ambiguity-explorer'),
  },
  {
    id: 'operator-precedence',
    title: 'Operator-precedence parsing',
    description: 'Build a table of precedence relations and parse by comparing terminals.',
    moduleNumber: 2,
    load: () => import('./parsing/operator-precedence'),
  },
  {
    id: 'annotated-parse-tree',
    title: 'Annotated parse tree',
    description: 'Enter a syntax-directed definition and watch attributes fill in on the tree.',
    moduleNumber: 3,
    load: () => import('./semantic/annotated-parse-tree'),
  },
  {
    id: 'dependency-graph',
    title: 'Attribute dependency graph',
    description:
      'See the evaluation order, any cycles, and whether a definition is S- or L-attributed.',
    moduleNumber: 3,
    load: () => import('./semantic/dependency-graph'),
  },
  {
    id: 'scope-stack',
    title: 'Scope stack and symbol tables',
    description: 'Follow declarations and lookups through scoped stacks, hash tables and trees.',
    moduleNumber: 3,
    load: () => import('./semantic/scope-stack'),
  },
];

export function findVisualizer(id: string | undefined): VisualizerEntry | undefined {
  return VISUALIZERS.find((entry) => entry.id === id);
}
