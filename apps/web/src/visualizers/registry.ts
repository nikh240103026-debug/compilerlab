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
];

export function findVisualizer(id: string | undefined): VisualizerEntry | undefined {
  return VISUALIZERS.find((entry) => entry.id === id);
}
