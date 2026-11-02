import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import {
  alphabetAtoms,
  formatCharSet,
  setContains,
  type CharRange,
  type CharSet,
} from '../regex/charset';
import { dfaStateName, formatStateSet, NO_TRANSITION, type Dfa, type Nfa } from './types';

export const MAX_DFA_STATES = 300;

function firstChar(atom: CharSet): number {
  return (atom[0] as CharRange)[0];
}

/** Pre-computed edge lists, so each closure does not rescan every transition. */
export interface NfaIndex {
  epsilon: number[][];
  labeled: { on: CharSet; to: number }[][];
}

export function indexNfa(nfa: Nfa): NfaIndex {
  const epsilon: number[][] = Array.from({ length: nfa.stateCount }, () => []);
  const labeled: NfaIndex['labeled'] = Array.from({ length: nfa.stateCount }, () => []);
  for (const { from, to, on } of nfa.transitions) {
    if (on) (labeled[from] as NfaIndex['labeled'][number]).push({ on, to });
    else (epsilon[from] as number[]).push(to);
  }
  return { epsilon, labeled };
}

/** All states reachable from `states` by ε-edges alone, including `states`. Sorted. */
export function epsilonClosure(index: NfaIndex, states: readonly number[]): number[] {
  const seen = new Set(states);
  const pending = [...states];
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    for (const next of index.epsilon[state] as number[]) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return [...seen].toSorted((a, b) => a - b);
}

/** All states reachable from `states` by one edge on this character. Sorted. */
export function moveOn(index: NfaIndex, states: readonly number[], codePoint: number): number[] {
  const targets = new Set<number>();
  for (const state of states) {
    for (const { on, to } of index.labeled[state] as NfaIndex['labeled'][number]) {
      if (setContains(on, codePoint)) targets.add(to);
    }
  }
  return [...targets].toSorted((a, b) => a - b);
}

export interface SubsetRow {
  name: string;
  nfaStates: number[];
  accepting: boolean;
  /** Target row per alphabet column. null means this cell is not filled in yet. */
  cells: (number | null)[];
  /** Whether every column of this row has been processed. */
  marked: boolean;
}

export interface SubsetState {
  alphabet: string[];
  rows: SubsetRow[];
  currentRow: number | null;
  currentSymbol: number | null;
  /** move(current, symbol). */
  moveSet: number[];
  /** ε-closure(moveSet). */
  closureSet: number[];
  /** NFA states to light up in the diagram. */
  highlight: number[];
}

export interface SubsetResult {
  dfa: Dfa;
  trace: Trace<SubsetState>;
}

/** Subset construction, with one trace step for each table cell filled in. */
export function subsetConstruct(nfa: Nfa, maxStates = MAX_DFA_STATES): SubsetResult {
  const index = indexNfa(nfa);
  const alphabet = alphabetAtoms(nfa.transitions.flatMap(({ on }) => (on ? [on] : [])));
  const labels = alphabet.map(formatCharSet);
  const accepts = new Set(nfa.accepts);
  const recorder = new TraceRecorder<SubsetState>();

  const rows: SubsetRow[] = [];
  const rowOf = new Map<string, number>();

  const addRow = (nfaStates: number[]): number => {
    const row = rows.length;
    if (row >= maxStates) {
      throw new EngineError({
        code: 'too_many_dfa_states',
        message: `The DFA would need more than ${maxStates} states.`,
        hint: 'Subset construction can grow exponentially, and this input does. Try a smaller expression.',
      });
    }
    rows.push(
      Object.freeze({
        name: dfaStateName(row),
        nfaStates,
        accepting: nfaStates.some((state) => accepts.has(state)),
        cells: alphabet.map(() => null),
        marked: false,
      }),
    );
    rowOf.set(nfaStates.join(','), row);
    return row;
  };

  const snapshot = (fields: Partial<SubsetState>): SubsetState => ({
    alphabet: labels,
    rows: rows.slice(),
    currentRow: null,
    currentSymbol: null,
    moveSet: [],
    closureSet: [],
    highlight: [],
    ...fields,
  });

  const startSet = epsilonClosure(index, [nfa.start]);
  addRow(startSet);
  recorder.add(
    'Start state',
    `The DFA starts in every NFA state reachable from the start state without reading input. That is ε-closure(${nfa.start}) = ${formatStateSet(startSet)}, which becomes DFA state A.`,
    snapshot({ currentRow: 0, closureSet: startSet, highlight: startSet }),
  );

  for (let current = 0; current < rows.length; current++) {
    const row = rows[current] as SubsetRow;
    for (let symbol = 0; symbol < alphabet.length; symbol++) {
      const moved = moveOn(index, row.nfaStates, firstChar(alphabet[symbol] as CharSet));
      const closure = moved.length > 0 ? epsilonClosure(index, moved) : [];
      const label = labels[symbol] as string;
      const key = closure.join(',');
      let target: number = NO_TRANSITION;
      let outcome: string;
      if (closure.length === 0) {
        outcome = `No state in ${row.name} has an edge on ${label}, so this cell stays empty. Reading ${label} here means rejection.`;
      } else {
        const existing = rowOf.get(key);
        if (existing === undefined) {
          target = addRow(closure);
          outcome = `This set is new, so it becomes DFA state ${(rows[target] as SubsetRow).name}.`;
        } else {
          target = existing;
          outcome = `This set is already state ${(rows[target] as SubsetRow).name}, so no new state is needed.`;
        }
      }
      const updatedCells = (rows[current] as SubsetRow).cells.slice();
      updatedCells[symbol] = target;
      rows[current] = Object.freeze({ ...(rows[current] as SubsetRow), cells: updatedCells });
      const reached =
        closure.length > 0
          ? `move(${row.name}, ${label}) = ${formatStateSet(moved)}, and its ε-closure is ${formatStateSet(closure)}. `
          : '';
      recorder.add(
        `${row.name} on ${label}`,
        `${reached}${outcome}`,
        snapshot({
          currentRow: current,
          currentSymbol: symbol,
          moveSet: moved,
          closureSet: closure,
          highlight: closure.length > 0 ? closure : row.nfaStates,
        }),
      );
    }
    rows[current] = Object.freeze({ ...(rows[current] as SubsetRow), marked: true });
  }

  const acceptRule = nfa.acceptRule;
  const dfa: Dfa = {
    stateCount: rows.length,
    names: rows.map((row) => row.name),
    start: 0,
    accepts: rows.flatMap((row, i) => (row.accepting ? [i] : [])),
    alphabet,
    delta: rows.map((row) => row.cells.map((cell) => cell as number)),
    sources: rows.map((row) => row.nfaStates),
    ...(acceptRule
      ? {
          acceptRule: rows.map((row) => {
            const ruleIndexes = row.nfaStates.flatMap((state) => {
              const rule = acceptRule[state];
              return rule === undefined ? [] : [rule];
            });
            return ruleIndexes.length > 0 ? Math.min(...ruleIndexes) : null;
          }),
        }
      : {}),
  };

  const acceptingNames = rows.filter((row) => row.accepting).map((row) => row.name);
  recorder.add(
    'Finished',
    `Every state has been processed, so the DFA has ${rows.length} state${rows.length === 1 ? '' : 's'}. A DFA state accepts if its set contains an accepting NFA state: ${acceptingNames.length > 0 ? acceptingNames.join(', ') : 'none here'}.`,
    snapshot({}),
  );

  return { dfa, trace: recorder.finish() };
}
