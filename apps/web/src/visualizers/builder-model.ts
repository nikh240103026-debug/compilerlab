import {
  charSet,
  parseRegex,
  setContains,
  EngineError,
  type CharRange,
  type CharSet,
  type Nfa,
  type NfaTransition,
} from '@compilerlab/engine';

export interface BuilderState {
  id: string;
  label: string;
  accepting: boolean;
  x: number;
  y: number;
}

export interface BuilderTransition {
  id: string;
  from: string;
  to: string;
  /** Comma-separated symbols: a, b, ε, or a class like [0-9]. */
  label: string;
}

export interface BuilderAutomaton {
  states: BuilderState[];
  transitions: BuilderTransition[];
  startId: string | null;
}

export type AutomatonKind = 'DFA' | 'NFA' | 'ε-NFA';

export type BuildResult =
  | { ok: true; nfa: Nfa; kind: AutomatonKind; complete: boolean }
  | { ok: false; problems: string[] };

/** Reads one symbol from a label. Throws an EngineError naming what is wrong. */
export function parseSymbol(symbol: string): CharSet | null {
  if (symbol === 'ε' || symbol === 'eps' || symbol === '') return null;
  const node = parseRegex(symbol);
  if (node.type === 'empty') return null;
  if (node.type !== 'charset') {
    throw new EngineError({
      code: 'not_a_symbol',
      message: `"${symbol}" is more than one symbol.`,
      hint: 'An edge reads one symbol at a time. Separate choices with commas, as in a, b.',
    });
  }
  return node.set;
}

/** Splits on commas, except for a comma inside a [class] or written as \, */
export function splitLabel(label: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inClass = false;
  for (let i = 0; i < label.length; i++) {
    const char = label[i] as string;
    if (char === '\\') {
      current += char + (label[i + 1] ?? '');
      i++;
    } else if (char === ',' && !inClass) {
      parts.push(current);
      current = '';
    } else {
      if (char === '[') inClass = true;
      if (char === ']') inClass = false;
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function overlaps(a: CharSet, b: CharSet): boolean {
  return a.some((range: CharRange) => b.some(([low, high]) => range[0] <= high && low <= range[1]));
}

/** Turns what is on the canvas into an engine NFA, or explains why it can't yet. */
export function buildAutomaton(automaton: BuilderAutomaton): BuildResult {
  const { states, transitions, startId } = automaton;
  const problems: string[] = [];
  if (states.length === 0) {
    return { ok: false, problems: ['Add a state to get started.'] };
  }
  const index = new Map(states.map((state, i) => [state.id, i]));
  const start = startId === null ? undefined : index.get(startId);
  if (start === undefined) problems.push('Choose a start state.');
  if (!states.some((state) => state.accepting))
    problems.push('Mark at least one state as accepting.');

  const labelOf = (id: string) => states.find((state) => state.id === id)?.label ?? id;
  const built: NfaTransition[] = [];
  for (const transition of transitions) {
    const from = index.get(transition.from);
    const to = index.get(transition.to);
    if (from === undefined || to === undefined) continue;
    for (const symbol of splitLabel(transition.label)) {
      try {
        built.push({ from, to, on: parseSymbol(symbol) });
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        problems.push(
          `Edge from ${labelOf(transition.from)} to ${labelOf(transition.to)}: ${error.info.message}`,
        );
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  let kind: AutomatonKind = 'DFA';
  if (built.some(({ on }) => on === null)) {
    kind = 'ε-NFA';
  } else {
    outer: for (const [i, a] of built.entries()) {
      for (const b of built.slice(i + 1)) {
        if (a.from === b.from && overlaps(a.on as CharSet, b.on as CharSet)) {
          kind = 'NFA';
          break outer;
        }
      }
    }
  }

  // A DFA is complete when every state has a move on every symbol the automaton mentions.
  const symbols = charSet(built.flatMap(({ on }) => (on ? [...on] : [])));
  const complete =
    kind === 'DFA' &&
    states.every((_, state) =>
      symbols.every((range) =>
        built.some(({ from, on }) => from === state && on && setContains(on, range[0])),
      ),
    );

  return {
    ok: true,
    kind,
    complete,
    nfa: {
      stateCount: states.length,
      start: start as number,
      accepts: states.flatMap((state, i) => (state.accepting ? [i] : [])),
      transitions: built,
    },
  };
}

export const EMPTY_AUTOMATON: BuilderAutomaton = { states: [], transitions: [], startId: null };

/** A DFA for strings ending in abb, laid out as the minimal DFA is usually drawn. */
export const ENDS_IN_ABB: BuilderAutomaton = {
  startId: 'q0',
  states: [
    { id: 'q0', label: 'q0', accepting: false, x: 40, y: 150 },
    { id: 'q1', label: 'q1', accepting: false, x: 190, y: 150 },
    { id: 'q2', label: 'q2', accepting: false, x: 340, y: 150 },
    { id: 'q3', label: 'q3', accepting: true, x: 490, y: 150 },
  ],
  transitions: [
    { id: 'e1', from: 'q0', to: 'q0', label: 'b' },
    { id: 'e2', from: 'q0', to: 'q1', label: 'a' },
    { id: 'e3', from: 'q1', to: 'q1', label: 'a' },
    { id: 'e4', from: 'q1', to: 'q2', label: 'b' },
    { id: 'e5', from: 'q2', to: 'q1', label: 'a' },
    { id: 'e6', from: 'q2', to: 'q3', label: 'b' },
    { id: 'e7', from: 'q3', to: 'q1', label: 'a' },
    { id: 'e8', from: 'q3', to: 'q0', label: 'b' },
  ],
};

/** A small ε-NFA for a|b, to show ε-edges and choice. */
export const A_OR_B: BuilderAutomaton = {
  startId: 'q0',
  states: [
    { id: 'q0', label: 'q0', accepting: false, x: 40, y: 150 },
    { id: 'q1', label: 'q1', accepting: false, x: 190, y: 60 },
    { id: 'q2', label: 'q2', accepting: false, x: 190, y: 240 },
    { id: 'q3', label: 'q3', accepting: true, x: 340, y: 150 },
  ],
  transitions: [
    { id: 'e1', from: 'q0', to: 'q1', label: 'ε' },
    { id: 'e2', from: 'q0', to: 'q2', label: 'ε' },
    { id: 'e3', from: 'q1', to: 'q3', label: 'a' },
    { id: 'e4', from: 'q2', to: 'q3', label: 'b' },
  ],
};
