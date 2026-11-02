import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import {
  alphabetAtoms,
  formatCharSet,
  setContains,
  type CharRange,
  type CharSet,
} from '../regex/charset';
import type { RegexNode } from '../regex/parser';
import { MAX_DFA_STATES } from './subset';
import { dfaStateName, formatStateSet, NO_TRANSITION, type Dfa } from './types';

export interface SyntaxTreeNode {
  id: number;
  /** cat, or, star, plus, opt, ε, a position's symbol, or #. */
  label: string;
  children: number[];
  /** The position number, for leaves that consume a symbol. */
  position: number | null;
  nullable: boolean | null;
  firstpos: number[] | null;
  lastpos: number[] | null;
}

export interface DirectRow {
  name: string;
  positions: number[];
  accepting: boolean;
  cells: (number | null)[];
}

export type DirectPhase = 'annotate' | 'followpos' | 'dstates' | 'done';

export interface DirectState {
  phase: DirectPhase;
  nodes: SyntaxTreeNode[];
  root: number;
  /** Symbol label per position. Index 0 is unused, because positions start at 1. */
  positionLabels: string[];
  /** followpos[p] per position. Index 0 is unused. */
  followpos: number[][];
  alphabet: string[];
  rows: DirectRow[];
  activeNode: number | null;
  activeRow: number | null;
  activeSymbol: number | null;
}

export interface DirectResult {
  dfa: Dfa;
  trace: Trace<DirectState>;
}

const sortedUnion = (...lists: readonly number[][]): number[] =>
  [...new Set(lists.flat())].toSorted((a, b) => a - b);

/** Builds a DFA straight from the regex using followpos, with no NFA in between. */
export function regexToDfaDirect(root: RegexNode): DirectResult {
  const recorder = new TraceRecorder<DirectState>();
  const nodes: SyntaxTreeNode[] = [];
  const positionSets: (CharSet | null)[] = [null];
  const positionLabels: string[] = [''];

  const addNode = (node: Omit<SyntaxTreeNode, 'id'>): number => {
    nodes.push(Object.freeze({ ...node, id: nodes.length }) as SyntaxTreeNode);
    return nodes.length - 1;
  };
  const addLeaf = (label: string, set: CharSet | null): number => {
    const position = positionLabels.length;
    positionLabels.push(label);
    positionSets.push(set);
    return addNode({
      label,
      children: [],
      position,
      nullable: null,
      firstpos: null,
      lastpos: null,
    });
  };

  const convert = (node: RegexNode): number => {
    const parent = (label: string, ...children: number[]) =>
      addNode({ label, children, position: null, nullable: null, firstpos: null, lastpos: null });
    switch (node.type) {
      case 'empty':
        return parent('ε');
      case 'charset':
        return addLeaf(formatCharSet(node.set), node.set);
      case 'union': {
        const left = convert(node.left);
        return parent('or', left, convert(node.right));
      }
      case 'concat': {
        const left = convert(node.left);
        return parent('cat', left, convert(node.right));
      }
      case 'star':
        return parent('star', convert(node.child));
      case 'plus':
        return parent('plus', convert(node.child));
      case 'optional':
        return parent('opt', convert(node.child));
    }
  };

  // Augment r to (r)#, so accepting is the same as having # among the positions.
  const inner = convert(root);
  const end = addLeaf('#', null);
  const endPosition = positionLabels.length - 1;
  const rootId = addNode({
    label: 'cat',
    children: [inner, end],
    position: null,
    nullable: null,
    firstpos: null,
    lastpos: null,
  });

  const followpos: number[][] = positionLabels.map(() => []);
  const atoms = alphabetAtoms(positionSets.flatMap((set) => (set ? [set] : [])));
  const alphabet = atoms.map(formatCharSet);
  const rows: DirectRow[] = [];

  const snapshot = (phase: DirectPhase, fields: Partial<DirectState> = {}): DirectState => ({
    phase,
    nodes: nodes.slice(),
    root: rootId,
    positionLabels,
    followpos: followpos.slice(),
    alphabet,
    rows: rows.slice(),
    activeNode: null,
    activeRow: null,
    activeSymbol: null,
    ...fields,
  });

  recorder.add(
    'Augment the expression',
    `Add an end marker to get (r)#. Each symbol leaf gets a position number, ${endPosition} in all. A DFA state accepts exactly when it contains the position of #, which is ${endPosition}.`,
    snapshot('annotate'),
  );

  // Children come before their parents in `nodes`, so one pass is a bottom-up walk.
  const rootIndex = rootId;
  for (let id = 0; id <= rootIndex; id++) {
    const node = nodes[id] as SyntaxTreeNode;
    const child = (i: number) => nodes[node.children[i] as number] as SyntaxTreeNode;
    let nullable: boolean;
    let firstpos: number[];
    let lastpos: number[];
    let why: string;
    // Leaves are checked by position, because a symbol's label could be any character.
    switch (node.position === null ? node.label : 'leaf') {
      case 'ε':
        nullable = true;
        firstpos = [];
        lastpos = [];
        why = 'An ε leaf matches the empty string and uses no position.';
        break;
      case 'or':
        nullable = (child(0).nullable as boolean) || (child(1).nullable as boolean);
        firstpos = sortedUnion(child(0).firstpos as number[], child(1).firstpos as number[]);
        lastpos = sortedUnion(child(0).lastpos as number[], child(1).lastpos as number[]);
        why = 'An or node is nullable if either child is, and its sets are the union of both.';
        break;
      case 'cat':
        nullable = (child(0).nullable as boolean) && (child(1).nullable as boolean);
        firstpos = child(0).nullable
          ? sortedUnion(child(0).firstpos as number[], child(1).firstpos as number[])
          : (child(0).firstpos as number[]);
        lastpos = child(1).nullable
          ? sortedUnion(child(0).lastpos as number[], child(1).lastpos as number[])
          : (child(1).lastpos as number[]);
        why = `A cat node is nullable only if both children are. Its firstpos includes the right child only if the left child can match nothing${child(0).nullable ? ', which it can here' : ", which it can't here"}.`;
        break;
      case 'star':
      case 'opt':
        nullable = true;
        firstpos = child(0).firstpos as number[];
        lastpos = child(0).lastpos as number[];
        why = `A ${node.label} node can match nothing, so it is nullable, and it has the same firstpos and lastpos as its child.`;
        break;
      case 'plus':
        nullable = child(0).nullable as boolean;
        firstpos = child(0).firstpos as number[];
        lastpos = child(0).lastpos as number[];
        why =
          'A plus node is nullable only if its child is, and it has the same sets as its child.';
        break;
      default:
        nullable = false;
        firstpos = [node.position as number];
        lastpos = [node.position as number];
        why = `A leaf must consume its symbol, so it is not nullable, and its only position is ${node.position}.`;
    }
    nodes[id] = Object.freeze({ ...node, nullable, firstpos, lastpos });
    recorder.add(
      `Annotate ${node.label}`,
      `${why} nullable = ${nullable}, firstpos = ${formatStateSet(firstpos)}, lastpos = ${formatStateSet(lastpos)}.`,
      snapshot('annotate', { activeNode: id }),
    );
  }

  const addFollow = (from: readonly number[], to: readonly number[]) => {
    for (const position of from) {
      followpos[position] = sortedUnion(followpos[position] as number[], [...to]);
    }
  };

  for (let id = 0; id <= rootIndex; id++) {
    const node = nodes[id] as SyntaxTreeNode;
    if (node.position !== null) continue;
    if (node.label === 'cat') {
      const left = nodes[node.children[0] as number] as SyntaxTreeNode;
      const right = nodes[node.children[1] as number] as SyntaxTreeNode;
      addFollow(left.lastpos as number[], right.firstpos as number[]);
      recorder.add(
        'followpos at a cat node',
        `Anything that ends the left child can be followed by anything that starts the right child. Each position in ${formatStateSet(left.lastpos as number[])} gets ${formatStateSet(right.firstpos as number[])} added to its followpos.`,
        snapshot('followpos', { activeNode: id }),
      );
    } else if (node.label === 'star' || node.label === 'plus') {
      addFollow(node.lastpos as number[], node.firstpos as number[]);
      recorder.add(
        `followpos at a ${node.label} node`,
        `The repeat can run again, so anything that ends it can be followed by anything that starts it. Each position in ${formatStateSet(node.lastpos as number[])} gets ${formatStateSet(node.firstpos as number[])} added to its followpos.`,
        snapshot('followpos', { activeNode: id }),
      );
    }
  }

  const rowOf = new Map<string, number>();
  const addRow = (positions: number[]): number => {
    if (rows.length >= MAX_DFA_STATES) {
      throw new EngineError({
        code: 'too_many_dfa_states',
        message: `The DFA would need more than ${MAX_DFA_STATES} states.`,
        hint: 'Try a smaller expression.',
      });
    }
    rows.push(
      Object.freeze({
        name: dfaStateName(rows.length),
        positions,
        accepting: positions.includes(endPosition),
        cells: atoms.map(() => null),
      }),
    );
    rowOf.set(positions.join(','), rows.length - 1);
    return rows.length - 1;
  };

  const rootFirst = (nodes[rootId] as SyntaxTreeNode).firstpos as number[];
  addRow(rootFirst);
  recorder.add(
    'Start state',
    `The DFA starts with firstpos of the root, ${formatStateSet(rootFirst)}: the positions that could match the first character. This is state A.`,
    snapshot('dstates', { activeRow: 0 }),
  );

  for (let current = 0; current < rows.length; current++) {
    for (let symbol = 0; symbol < atoms.length; symbol++) {
      const row = rows[current] as DirectRow;
      const atom = atoms[symbol] as CharSet;
      const code = (atom[0] as CharRange)[0];
      const matching = row.positions.filter((position) => {
        const set = positionSets[position];
        return set ? setContains(set, code) : false;
      });
      const next = sortedUnion(...matching.map((position) => followpos[position] as number[]));
      const label = alphabet[symbol] as string;
      let target: number = NO_TRANSITION;
      let outcome: string;
      if (next.length === 0) {
        outcome = `No position in ${row.name} leads anywhere on ${label}, so this cell stays empty.`;
      } else {
        const existing = rowOf.get(next.join(','));
        const isNew = existing === undefined;
        target = isNew ? addRow(next) : existing;
        outcome = `The union of their followpos sets is ${formatStateSet(next)}, which ${isNew ? 'is new, so it becomes' : 'is already'} state ${(rows[target] as DirectRow).name}.`;
      }
      const cells = (rows[current] as DirectRow).cells.slice();
      cells[symbol] = target;
      rows[current] = Object.freeze({ ...(rows[current] as DirectRow), cells });
      recorder.add(
        `${row.name} on ${label}`,
        `${matching.length > 0 ? `In ${row.name}, ${matching.length === 1 ? 'position' : 'positions'} ${matching.join(', ')} ${matching.length === 1 ? 'matches' : 'match'} ${label}. ` : ''}${outcome}`,
        snapshot('dstates', { activeRow: current, activeSymbol: symbol }),
      );
    }
  }

  const dfa: Dfa = {
    stateCount: rows.length,
    names: rows.map((row) => row.name),
    start: 0,
    accepts: rows.flatMap((row, i) => (row.accepting ? [i] : [])),
    alphabet: atoms,
    delta: rows.map((row) => row.cells.map((cell) => cell as number)),
    sources: rows.map((row) => row.positions),
  };
  recorder.add(
    'Finished',
    `The DFA has ${rows.length} state${rows.length === 1 ? '' : 's'}. States containing position ${endPosition}, the end marker, are accepting.`,
    snapshot('done'),
  );
  return { dfa, trace: recorder.finish() };
}
