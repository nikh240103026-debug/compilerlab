import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { scanSource, type ScanToken } from './scan';

// Three ways to organize a symbol table with nested scopes, all running the same operations, so a
// student can watch where the comparisons go. Each one answers every lookup the same way. They
// differ in how much work it takes.

export const MAX_SYMTAB_OPERATIONS = 500;
export const MAX_SYMTAB_BUCKETS = 211;
export const SYMTAB_DEFAULT_BUCKETS = 7;
const MAX_SYMTAB_SOURCE = 8000;

export type SymtabOrganization = 'hash' | 'tree' | 'stack';

export type SymtabOperation =
  | { op: 'enter' }
  | { op: 'exit' }
  | { op: 'insert'; name: string; type: string }
  | { op: 'lookup'; name: string };

export interface SymtabEntry {
  name: string;
  type: string;
  /** How deep the scope is. The outermost scope is level 0. */
  level: number;
  /** Tells two different scopes at the same depth apart. */
  scope: number;
}

export interface SymtabHashInfo {
  name: string;
  /** The sum of the name's character codes. */
  sum: number;
  bucket: number;
  /** Like h("x") = 120 mod 7 = 1. */
  formula: string;
}

export interface SymtabHashStructure {
  organization: 'hash';
  size: number;
  /** Each bucket is a chain with the newest entry first, so inner scopes are found first. */
  buckets: SymtabEntry[][];
  /** Per open scope, its entries. Exiting a scope uses this instead of scanning the table. */
  scopeLists: { level: number; names: string[] }[];
  /** How this step picked its bucket. */
  hash: SymtabHashInfo | null;
  /** Entries this step compared, as positions in the bucket. */
  visited: { bucket: number; index: number }[];
}

export interface SymtabTreeNode {
  id: number;
  name: string;
  left: number | null;
  right: number | null;
  /** Declarations of this name, outermost first. The last one is the one in effect. */
  bindings: SymtabEntry[];
}

export interface SymtabTreeStructure {
  organization: 'tree';
  root: number | null;
  /** Every node, in preorder. Links are node ids. */
  nodes: SymtabTreeNode[];
  /** Node ids this step compared, from the root down. */
  path: number[];
}

export interface SymtabStackStructure {
  organization: 'stack';
  /** One frame per open scope, outermost first. */
  frames: { level: number; scope: number; entries: SymtabEntry[] }[];
  /** Entries this step compared. */
  visited: { frame: number; index: number }[];
}

export type SymtabStructure = SymtabHashStructure | SymtabTreeStructure | SymtabStackStructure;

export type SymtabOutcome = 'ok' | 'found' | 'not_found' | 'redeclared' | 'no_scope';

export interface SymtabState {
  /** Index of this operation in the input. */
  index: number;
  operation: SymtabOperation;
  outcome: SymtabOutcome;
  level: number;
  /** The declaration a lookup found. */
  found: SymtabEntry | null;
  /** Entries exit removed. */
  removed: SymtabEntry[];
  comparisons: number;
  totalComparisons: number;
  structure: SymtabStructure;
}

export interface SymtabResult {
  organization: SymtabOrganization;
  operations: SymtabOperation[];
  totalComparisons: number;
  trace: Trace<SymtabState>;
}

export interface SymtabComparisonRow {
  operation: string;
  outcome: SymtabOutcome;
  /** The declaration found, shown the same way for all three. */
  found: string | null;
  hash: number;
  tree: number;
  stack: number;
}

export interface SymtabComparison {
  rows: SymtabComparisonRow[];
  totals: { hash: number; tree: number; stack: number };
}

export interface SymtabOptions {
  /** Buckets in the hash table. */
  buckets?: number;
}

/** Adding the character codes is a weak hash, on purpose: students get to see chains form. */
function hashOf(name: string, size: number): SymtabHashInfo {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  const bucket = sum % size;
  return { name, sum, bucket, formula: `h("${name}") = ${sum} mod ${size} = ${bucket}` };
}

/** Every organization does these things, and says how many comparisons each one took. */
interface Table {
  enter(level: number, scope: number): void;
  exit(): SymtabEntry[];
  insert(entry: SymtabEntry): { inserted: boolean; comparisons: number; note: string };
  lookup(name: string): { found: SymtabEntry | null; comparisons: number; note: string };
  /** The structure now, marking what the last call touched. */
  snapshot(): SymtabStructure;
  /** Forgets the marks, so a later step does not show them. */
  clearMarks(): void;
}

function hashTable(size: number): Table {
  const buckets: SymtabEntry[][] = Array.from({ length: size }, () => []);
  const scopes: { level: number; entries: SymtabEntry[] }[] = [{ level: 0, entries: [] }];
  let hash: SymtabHashInfo | null = null;
  let visited: SymtabHashStructure['visited'] = [];
  return {
    enter(level) {
      scopes.push({ level, entries: [] });
    },
    exit() {
      const closing = scopes.pop() as { entries: SymtabEntry[] };
      for (const entry of closing.entries) {
        const { bucket } = hashOf(entry.name, size);
        buckets[bucket] = (buckets[bucket] as SymtabEntry[]).filter((item) => item !== entry);
      }
      return closing.entries;
    },
    insert(entry) {
      const info = hashOf(entry.name, size);
      hash = info;
      const { bucket } = info;
      const chain = buckets[bucket] as SymtabEntry[];
      visited = [];
      // Inner entries sit at the front, so the search can stop at the first outer one.
      for (let index = 0; index < chain.length; index++) {
        const item = chain[index] as SymtabEntry;
        if (item.scope !== entry.scope) break;
        visited.push({ bucket, index });
        if (item.name === entry.name) {
          return {
            inserted: false,
            comparisons: visited.length,
            note: `Bucket ${bucket} already holds ${entry.name} from this scope.`,
          };
        }
      }
      buckets[bucket] = [entry, ...chain];
      (scopes.at(-1) as { entries: SymtabEntry[] }).entries.push(entry);
      return {
        inserted: true,
        comparisons: visited.length,
        note: `${info.formula}, so ${entry.name} goes at the front of bucket ${bucket}. New entries go first, so a lookup finds the innermost one before any outer one.`,
      };
    },
    lookup(name) {
      const info = hashOf(name, size);
      hash = info;
      const { bucket } = info;
      const chain = buckets[bucket] as SymtabEntry[];
      visited = [];
      for (let index = 0; index < chain.length; index++) {
        visited.push({ bucket, index });
        const item = chain[index] as SymtabEntry;
        if (item.name === name) {
          return {
            found: item,
            comparisons: visited.length,
            note: `${info.formula}. Walking the chain finds ${name} after ${visited.length} comparison${visited.length === 1 ? '' : 's'}.`,
          };
        }
      }
      return {
        found: null,
        comparisons: visited.length,
        note: `${info.formula}. Bucket ${bucket} has no ${name}, so no other bucket needs checking.`,
      };
    },
    snapshot() {
      return {
        organization: 'hash',
        size,
        buckets: buckets.map((chain) => chain.slice()),
        scopeLists: scopes.map((scope) => ({
          level: scope.level,
          names: scope.entries.map((entry) => entry.name),
        })),
        hash,
        visited,
      };
    },
    clearMarks() {
      hash = null;
      visited = [];
    },
  };
}

interface BstNode {
  id: number;
  name: string;
  left: BstNode | null;
  right: BstNode | null;
  bindings: SymtabEntry[];
}

/** One tree keyed by name. Each node keeps a little stack of that name's declarations. */
function treeTable(): Table {
  let root: BstNode | null = null;
  let nextId = 0;
  let path: number[] = [];
  const scopes: SymtabEntry[][] = [[]];

  /** A standard BST delete. A node with two children takes over its in-order successor's data. */
  const removeKey = (node: BstNode | null, key: string): BstNode | null => {
    if (!node) return null;
    if (key < node.name) {
      node.left = removeKey(node.left, key);
      return node;
    }
    if (key > node.name) {
      node.right = removeKey(node.right, key);
      return node;
    }
    if (!node.left) return node.right;
    if (!node.right) return node.left;
    let successor = node.right;
    while (successor.left) successor = successor.left;
    node.id = successor.id;
    node.name = successor.name;
    node.bindings = successor.bindings;
    node.right = removeKey(node.right, successor.name);
    return node;
  };

  const find = (name: string): BstNode | null => {
    path = [];
    let node = root;
    while (node) {
      path.push(node.id);
      if (name === node.name) return node;
      node = name < node.name ? node.left : node.right;
    }
    return null;
  };

  return {
    enter() {
      scopes.push([]);
    },
    exit() {
      const closing = scopes.pop() as SymtabEntry[];
      for (const entry of closing) {
        const node = find(entry.name) as BstNode;
        node.bindings = node.bindings.filter((item) => item !== entry);
        if (node.bindings.length === 0) root = removeKey(root, entry.name);
      }
      path = [];
      return closing;
    },
    insert(entry) {
      path = [];
      let node = root;
      let parent: BstNode | null = null;
      while (node) {
        path.push(node.id);
        if (entry.name === node.name) break;
        parent = node;
        node = entry.name < node.name ? node.left : node.right;
      }
      const comparisons = path.length;
      if (node) {
        const top = node.bindings.at(-1) as SymtabEntry;
        if (top.scope === entry.scope) {
          return {
            inserted: false,
            comparisons,
            note: `The search reaches the node for ${entry.name}, and its latest declaration is from this scope.`,
          };
        }
        node.bindings = [...node.bindings, entry];
        (scopes.at(-1) as SymtabEntry[]).push(entry);
        return {
          inserted: true,
          comparisons,
          note: `The tree already has a node for ${entry.name}, from an outer scope. This declaration goes on top of that node's list, and hides the outer one until this scope exits.`,
        };
      }
      const created: BstNode = {
        id: nextId++,
        name: entry.name,
        left: null,
        right: null,
        bindings: [entry],
      };
      if (!parent) root = created;
      else if (entry.name < parent.name) parent.left = created;
      else parent.right = created;
      path = [...path, created.id];
      (scopes.at(-1) as SymtabEntry[]).push(entry);
      return {
        inserted: true,
        comparisons,
        note: parent
          ? `After ${comparisons} comparison${comparisons === 1 ? '' : 's'} the search falls off the tree, so ${entry.name} becomes the ${entry.name < parent.name ? 'left' : 'right'} child of ${parent.name}.`
          : `The tree is empty, so ${entry.name} becomes the root.`,
      };
    },
    lookup(name) {
      const node = find(name);
      const comparisons = path.length;
      return {
        found: node ? (node.bindings.at(-1) as SymtabEntry) : null,
        comparisons,
        note: node
          ? `The search walks down by comparing names and reaches ${name} after ${comparisons} comparison${comparisons === 1 ? '' : 's'}. The node's latest declaration is the one in effect.`
          : `The search falls off the tree after ${comparisons} comparison${comparisons === 1 ? '' : 's'}, so ${name} is not declared.`,
      };
    },
    snapshot() {
      const nodes: SymtabTreeNode[] = [];
      const visit = (node: BstNode | null): void => {
        if (!node) return;
        nodes.push({
          id: node.id,
          name: node.name,
          left: node.left?.id ?? null,
          right: node.right?.id ?? null,
          bindings: node.bindings.slice(),
        });
        visit(node.left);
        visit(node.right);
      };
      visit(root);
      return { organization: 'tree', root: root?.id ?? null, nodes, path };
    },
    clearMarks() {
      path = [];
    },
  };
}

/** A stack of scopes, one list per scope. This is the book's chained table from section 2.7. */
function stackTable(): Table {
  const frames: { level: number; scope: number; entries: SymtabEntry[] }[] = [
    { level: 0, scope: 0, entries: [] },
  ];
  let visited: SymtabStackStructure['visited'] = [];
  return {
    enter(level, scope) {
      frames.push({ level, scope, entries: [] });
    },
    exit() {
      return (frames.pop() as { entries: SymtabEntry[] }).entries;
    },
    insert(entry) {
      const frame = frames.length - 1;
      const top = frames[frame] as { entries: SymtabEntry[] };
      visited = [];
      for (let index = top.entries.length - 1; index >= 0; index--) {
        visited.push({ frame, index });
        if ((top.entries[index] as SymtabEntry).name === entry.name) {
          return {
            inserted: false,
            comparisons: visited.length,
            note: `The top frame already holds ${entry.name}.`,
          };
        }
      }
      top.entries = [...top.entries, entry];
      return {
        inserted: true,
        comparisons: visited.length,
        note: `Only the top frame is checked for a duplicate. ${entry.name} is added to it. An outer ${entry.name} stays in its own frame, hidden by this one.`,
      };
    },
    lookup(name) {
      visited = [];
      for (let frame = frames.length - 1; frame >= 0; frame--) {
        const { entries } = frames[frame] as { entries: SymtabEntry[] };
        for (let index = entries.length - 1; index >= 0; index--) {
          visited.push({ frame, index });
          const item = entries[index] as SymtabEntry;
          if (item.name === name) {
            return {
              found: item,
              comparisons: visited.length,
              note: `The search goes from the top frame down, and finds ${name} at level ${item.level} after ${visited.length} comparison${visited.length === 1 ? '' : 's'}.`,
            };
          }
        }
      }
      return {
        found: null,
        comparisons: visited.length,
        note: `The search checks every frame, ${visited.length} comparison${visited.length === 1 ? '' : 's'} in all, and does not find ${name}.`,
      };
    },
    snapshot() {
      return {
        organization: 'stack',
        frames: frames.map((frame) => ({ ...frame, entries: frame.entries.slice() })),
        visited,
      };
    },
    clearMarks() {
      visited = [];
    },
  };
}

function showOperation(operation: SymtabOperation): string {
  switch (operation.op) {
    case 'enter':
      return 'enter scope';
    case 'exit':
      return 'exit scope';
    case 'insert':
      return `insert ${operation.name} : ${operation.type}`;
    case 'lookup':
      return `lookup ${operation.name}`;
  }
}

function checkOperations(operations: readonly SymtabOperation[]): void {
  if (operations.length > MAX_SYMTAB_OPERATIONS) {
    throw new EngineError({
      code: 'symtab_too_long',
      message: `This has more than ${MAX_SYMTAB_OPERATIONS} symbol table operations.`,
      hint: 'Try a shorter program.',
    });
  }
}

/** Runs the operations on one organization, with the structure shown at every step. */
export function symtabRun(
  organization: SymtabOrganization,
  operations: readonly SymtabOperation[],
  options: SymtabOptions = {},
): SymtabResult {
  checkOperations(operations);
  const size = options.buckets ?? SYMTAB_DEFAULT_BUCKETS;
  if (!Number.isInteger(size) || size < 1 || size > MAX_SYMTAB_BUCKETS) {
    throw new EngineError({
      code: 'symtab_bad_buckets',
      message: `A hash table here has between 1 and ${MAX_SYMTAB_BUCKETS} buckets.`,
      hint: 'A prime like 7 or 31 spreads names well.',
    });
  }
  const table =
    organization === 'hash'
      ? hashTable(size)
      : organization === 'tree'
        ? treeTable()
        : stackTable();
  const recorder = new TraceRecorder<SymtabState>();
  const openScopes = [0];
  let nextScope = 1;
  let total = 0;

  operations.forEach((operation, index) => {
    const level = openScopes.length - 1;
    let outcome: SymtabOutcome = 'ok';
    let found: SymtabEntry | null = null;
    let removed: SymtabEntry[] = [];
    let comparisons = 0;
    let explanation = '';
    table.clearMarks();

    switch (operation.op) {
      case 'enter': {
        const scope = nextScope++;
        openScopes.push(scope);
        table.enter(level + 1, scope);
        explanation = `A new scope opens at level ${level + 1}. Names declared now hide outer names with the same spelling, until this scope exits.`;
        break;
      }
      case 'exit': {
        if (level === 0) {
          outcome = 'no_scope';
          explanation = 'Only the outermost scope is open, and it cannot be closed.';
          break;
        }
        openScopes.pop();
        removed = table.exit();
        const names = removed.map((entry) => entry.name);
        explanation = `The scope at level ${level} closes. ${names.length > 0 ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} removed, and any outer name ${names.length === 1 ? 'it hid is' : 'they hid is'} visible again.` : 'It declared nothing, so nothing changes.'}`;
        break;
      }
      case 'insert': {
        const entry: SymtabEntry = {
          name: operation.name,
          type: operation.type,
          level,
          scope: openScopes.at(-1) as number,
        };
        const result = table.insert(entry);
        comparisons = result.comparisons;
        outcome = result.inserted ? 'ok' : 'redeclared';
        explanation = result.inserted
          ? result.note
          : `${result.note} ${operation.name} is declared twice in one scope, which is an error. The table keeps the first one.`;
        break;
      }
      case 'lookup': {
        const result = table.lookup(operation.name);
        comparisons = result.comparisons;
        found = result.found;
        outcome = found ? 'found' : 'not_found';
        explanation = found
          ? `${result.note} It is ${found.type}, declared at level ${found.level}.`
          : `${result.note} Using ${operation.name} here is an error.`;
        break;
      }
    }

    total += comparisons;
    recorder.add(showOperation(operation), explanation, {
      index,
      operation,
      outcome,
      level: openScopes.length - 1,
      found,
      removed,
      comparisons,
      totalComparisons: total,
      structure: table.snapshot(),
    });
  });

  return {
    organization,
    operations: operations.slice(),
    totalComparisons: total,
    trace: recorder.finish(),
  };
}

/** Runs all three, so a table can show the comparisons each organization needed per operation. */
export function symtabCompare(
  operations: readonly SymtabOperation[],
  options: SymtabOptions = {},
): SymtabComparison {
  const hash = symtabRun('hash', operations, options);
  const tree = symtabRun('tree', operations, options);
  const stack = symtabRun('stack', operations, options);
  const count = (run: SymtabResult, index: number): number =>
    (run.trace[index] as Trace<SymtabState>[number]).state.comparisons;
  const rows = operations.map((operation, index): SymtabComparisonRow => {
    const state = (hash.trace[index] as Trace<SymtabState>[number]).state;
    return {
      operation: showOperation(operation),
      outcome: state.outcome,
      found: state.found ? `${state.found.type} at level ${state.found.level}` : null,
      hash: count(hash, index),
      tree: count(tree, index),
      stack: count(stack, index),
    };
  });
  return {
    rows,
    totals: {
      hash: hash.totalComparisons,
      tree: tree.totalComparisons,
      stack: stack.totalComparisons,
    },
  };
}

/**
 * Reads a plain list of operations, one per line:
 *
 *   enter
 *   insert x int
 *   lookup x
 *   exit
 */
export function symtabParseScript(text: string): SymtabOperation[] {
  const operations: SymtabOperation[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const words = line
      .replace(/(#|\/\/).*$/, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const [verb, name, type] = words;
    const bad = (message: string, hint: string): never => {
      throw new EngineError({
        code: 'symtab_bad_script',
        message,
        hint,
        position: offset,
        length: line.length,
      });
    };
    if (verb === 'enter' && words.length === 1) operations.push({ op: 'enter' });
    else if (verb === 'exit' && words.length === 1) operations.push({ op: 'exit' });
    else if ((verb === 'insert' || verb === 'declare') && name && type && words.length === 3) {
      operations.push({ op: 'insert', name, type });
    } else if (verb === 'lookup' && name && words.length === 2) {
      operations.push({ op: 'lookup', name });
    } else if (verb) {
      bad(
        `"${line.trim()}" is not a symbol table operation.`,
        'Each line is one of: enter, exit, insert x int, lookup x.',
      );
    }
    offset += line.length + 1;
  }
  checkOperations(operations);
  return operations;
}

/**
 * Turns a block-structured program into operations, in the style of the book's section 2.7:
 *
 *   { int x; char y; { bool y; x; y; } x; y; }
 *
 * A statement that starts with two names is a declaration. In any other statement, each name is a
 * use, so it becomes a lookup.
 */
export function symtabOperationsFromBlocks(source: string): SymtabOperation[] {
  const tokens = scanSource(source, {
    operators: [
      '{',
      '}',
      ';',
      ',',
      '=',
      '+',
      '-',
      '*',
      '/',
      '%',
      '(',
      ')',
      '<',
      '>',
      '!',
      '[',
      ']',
    ],
    codePrefix: 'symtab',
    language: 'this block language',
    maxLength: MAX_SYMTAB_SOURCE,
  });
  const operations: SymtabOperation[] = [];
  let at = 0;
  let depth = 0;
  const peek = (): ScanToken => tokens[at] as ScanToken;
  while (peek().kind !== 'eof') {
    const token = peek();
    if (token.text === '{' && token.kind === 'op') {
      operations.push({ op: 'enter' });
      depth++;
      at++;
    } else if (token.text === '}' && token.kind === 'op') {
      if (depth === 0) {
        throw new EngineError({
          code: 'symtab_stray_brace',
          message: 'This } has no matching {.',
          hint: 'Remove it, or add the {.',
          position: token.start,
          length: 1,
        });
      }
      operations.push({ op: 'exit' });
      depth--;
      at++;
    } else if (token.kind === 'op' && token.text === ';') {
      at++;
    } else {
      const second = tokens[at + 1] as ScanToken | undefined;
      if (token.kind === 'name' && second?.kind === 'name') {
        at++;
        for (;;) {
          const name = peek();
          if (name.kind !== 'name') {
            throw new EngineError({
              code: 'symtab_expected_name',
              message: `A declaration of ${token.text} needs a name here.`,
              hint: 'Write it like this: int x, y;',
              position: name.start,
              length: Math.max(1, name.end - name.start),
            });
          }
          operations.push({ op: 'insert', name: name.text, type: token.text });
          at++;
          if (peek().text !== ',') break;
          at++;
        }
      } else {
        while (
          peek().kind !== 'eof' &&
          !(peek().kind === 'op' && [';', '{', '}'].includes(peek().text))
        ) {
          if (peek().kind === 'name') operations.push({ op: 'lookup', name: peek().text });
          at++;
        }
      }
    }
  }
  if (depth !== 0) {
    throw new EngineError({
      code: 'symtab_unclosed_block',
      message: `${depth} block${depth === 1 ? ' is' : 's are'} never closed.`,
      hint: 'Add the missing }.',
      position: source.length,
    });
  }
  checkOperations(operations);
  return operations;
}
