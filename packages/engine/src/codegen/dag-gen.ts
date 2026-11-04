import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { formatTac, type TacInstr, type TacOperand } from '../ir/types';
import { optIsCommutative } from '../optimize/tac-util';
import { ISA_OPCODE_OF_OPERATOR } from './isa';
import { codegenBlockStatements, codegenDefaultLiveOnExit } from './next-use';
import {
  SU_DEFAULT_REGISTERS,
  suCheckRegisters,
  suExplainLabel,
  suGenerate,
  suLabel,
  suPostorder,
  type SuTree,
} from './sethi-ullman';

export interface DagNodeView {
  id: number;
  /** The operator, or the initial value's name, or the constant. */
  label: string;
  kind: 'leaf' | 'const' | 'op';
  /** The names whose current value this node is. */
  names: string[];
  children: number[];
  /** Null until labeling reaches it, or if it does not get its own tree. */
  ershov: number | null;
  /** True once this node is chosen to be computed and stored as a tree of its own. */
  root: boolean;
  /** True once it is known that nothing needs this node. */
  dead: boolean;
}

export type DagGenPhase = 'build' | 'roots' | 'label' | 'generate' | 'done';

export interface DagGenState {
  phase: DagGenPhase;
  statement: number | null;
  /** The node this step is about. */
  focus: number | null;
  nodes: DagNodeView[];
  edges: { from: number; to: number }[];
  code: string[];
}

export interface DagGenResult {
  statements: string[];
  /** Final DAG, as plain lists, so it can be drawn. */
  nodes: DagNodeView[];
  edges: { from: number; to: number }[];
  /** Trees in the order they are computed, by root id. */
  order: number[];
  code: string[];
  registers: number;
  liveOnExit: string[];
  trace: Trace<DagGenState>;
}

interface Node {
  id: number;
  label: string;
  kind: DagNodeView['kind'];
  opcode: string | null;
  arity: 0 | 1 | 2;
  children: number[];
  names: Set<string>;
  source: string | null;
  ershov: number | null;
  root: boolean;
  dead: boolean;
}

/** The DAG for a basic block, the book's way: reuse a node whenever one already computes the value. */
class DagBuilder {
  readonly nodes: Node[] = [];
  readonly current = new Map<string, number>();
  private readonly byKey = new Map<string, number>();

  private add(fields: Omit<Node, 'id' | 'names' | 'ershov' | 'root' | 'dead'>): Node {
    const node: Node = {
      ...fields,
      id: this.nodes.length,
      names: new Set(),
      ershov: null,
      root: false,
      dead: false,
    };
    this.nodes.push(node);
    return node;
  }

  operandNode(operand: TacOperand): number {
    if (operand.kind === 'const') {
      const key = `const:${operand.value}`;
      const known = this.byKey.get(key);
      if (known !== undefined) return known;
      const node = this.add({
        label: String(operand.value),
        kind: 'const',
        opcode: null,
        arity: 0,
        children: [],
        source: `#${operand.value}`,
      });
      this.byKey.set(key, node.id);
      return node.id;
    }
    const known = this.current.get(operand.name);
    if (known !== undefined) return known;
    const node = this.add({
      label: `${operand.name}0`,
      kind: 'leaf',
      opcode: null,
      arity: 0,
      children: [],
      source: operand.name,
    });
    node.names.add(operand.name);
    this.current.set(operand.name, node.id);
    return node.id;
  }

  /** Reuses a node with this operator and these children, or makes one. */
  opNode(
    label: string,
    opcode: string,
    children: number[],
    commutative: boolean,
  ): { id: number; reused: boolean } {
    const ordered = commutative ? children.toSorted((a, b) => a - b) : children;
    const key = `${label}:${ordered.join(',')}`;
    const known = this.byKey.get(key);
    if (known !== undefined) return { id: known, reused: true };
    const node = this.add({
      label,
      kind: 'op',
      opcode,
      arity: children.length as 1 | 2,
      children,
      source: null,
    });
    this.byKey.set(key, node.id);
    return { id: node.id, reused: false };
  }

  /** A name moves to a new value, so it leaves whichever node held its old one. */
  attach(name: string, id: number): void {
    const previous = this.current.get(name);
    if (previous !== undefined) this.nodes[previous]?.names.delete(name);
    this.nodes[id]?.names.add(name);
    this.current.set(name, id);
  }

  view(): { nodes: DagNodeView[]; edges: DagGenState['edges'] } {
    return {
      nodes: this.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        names: [...node.names],
        children: node.children,
        ershov: node.ershov,
        root: node.root,
        dead: node.dead,
      })),
      edges: this.nodes.flatMap((node) => node.children.map((to) => ({ from: node.id, to }))),
    };
  }
}

function addStatement(builder: DagBuilder, instr: TacInstr): string {
  switch (instr.op) {
    case 'binary': {
      const children = [builder.operandNode(instr.left), builder.operandNode(instr.right)];
      const { id, reused } = builder.opNode(
        instr.operator,
        ISA_OPCODE_OF_OPERATOR[instr.operator],
        children,
        optIsCommutative(instr.operator),
      );
      builder.attach(instr.dest, id);
      return reused
        ? `A node for this operation on these same values already exists, so ${instr.dest} joins it. This is how a DAG finds common subexpressions.`
        : `No node computes this yet, so make one and label it with ${instr.dest}.`;
    }
    case 'unary': {
      const child = builder.operandNode(instr.arg);
      const { id, reused } = builder.opNode(
        instr.operator,
        instr.operator === '-' ? 'NEG' : 'NOT',
        [child],
        false,
      );
      builder.attach(instr.dest, id);
      return reused
        ? `A node for this already exists, so ${instr.dest} joins it.`
        : `Make a node for this and label it with ${instr.dest}.`;
    }
    case 'assign': {
      const id = builder.operandNode(instr.src);
      builder.attach(instr.dest, id);
      return `A copy makes no node. ${instr.dest} now names the same value as the source.`;
    }
    default:
      throw new EngineError({
        code: 'dag_unsupported',
        message: `This demo builds a DAG from arithmetic statements, and "${formatTac(instr)}" is not one.`,
        hint: 'Use only statements like: t1 = a + b',
      });
  }
}

/**
 * DAG-based code generation with optimal ordering. Build the DAG, split it into trees wherever a
 * node has several users, then give each tree optimal Sethi-Ullman code. Every tree starts with all
 * registers free, because its result is stored before the next tree begins.
 */
export function codegenDagGenerate(
  input: string | readonly TacInstr[],
  options: { registers?: number; liveOnExit?: readonly string[] } = {},
): DagGenResult {
  const registers = options.registers ?? SU_DEFAULT_REGISTERS;
  suCheckRegisters(registers);
  const { body, jump } = codegenBlockStatements(input);
  if (jump) {
    throw new EngineError({
      code: 'dag_unsupported',
      message: `This demo builds a DAG from arithmetic statements, and "${formatTac(jump)}" is not one.`,
      hint: 'Remove the jump at the end of the block.',
    });
  }
  const liveOnExit = [...(options.liveOnExit ?? codegenDefaultLiveOnExit(body))];
  const live = new Set(liveOnExit);
  const builder = new DagBuilder();
  const recorder = new TraceRecorder<DagGenState>();
  const code: string[] = [];
  const statements = body.map(formatTac);

  const record = (
    phase: DagGenPhase,
    statement: number | null,
    focus: number | null,
    title: string,
    explanation: string,
  ) => {
    recorder.add(title, explanation, {
      phase,
      statement,
      focus,
      ...builder.view(),
      code: [...code],
    });
  };

  body.forEach((instr, index) => {
    const explanation = addStatement(builder, instr);
    record('build', index, null, formatTac(instr), explanation);
  });

  const nodes = builder.nodes;
  const liveNames = (node: Node) => [...node.names].filter((name) => live.has(name));
  // Its own name on a leaf means the variable was never changed, so nothing needs storing.
  const storedNames = (node: Node) =>
    liveNames(node).filter((name) => !(node.kind === 'leaf' && node.source === name));

  // Walk from the highest id down: a node is needed if it stores a live name or a needed node uses it.
  const needed = new Set<number>();
  const users = new Map<number, number>();
  for (let id = nodes.length - 1; id >= 0; id--) {
    const node = nodes[id] as Node;
    if (storedNames(node).length > 0 || needed.has(id) || liveNames(node).length > 0)
      needed.add(id);
    if (!needed.has(id)) {
      node.dead = true;
      continue;
    }
    for (const child of node.children) {
      needed.add(child);
      users.set(child, (users.get(child) ?? 0) + 1);
    }
  }

  // Choose the roots: anything stored, and any operation with more than one user.
  const taken = new Set<string>([...builder.current.keys()]);
  const homes = new Map<number, string>();
  let tempCounter = 0;
  const freshName = (stem: string) => {
    let name = stem;
    while (taken.has(name)) name = `${stem}.${++tempCounter}`;
    taken.add(name);
    return name;
  };

  for (const node of nodes) {
    if (!needed.has(node.id)) continue;
    const isStored = storedNames(node).length > 0;
    const isShared = node.kind === 'op' && (users.get(node.id) ?? 0) > 1;
    if (!isStored && !isShared) continue;
    node.root = true;
    homes.set(node.id, storedNames(node)[0] ?? freshName(`s${node.id}`));
  }
  record(
    'roots',
    null,
    null,
    'Split into trees',
    'A node becomes the root of its own tree if a live variable must hold its value, or if several nodes use it. Those values get stored, so each user can simply read them back. Dead nodes get no code at all.',
  );

  // Trees run in id order. The last tree that reads each leaf tells us whether the leaf's old value
  // is still needed after that variable's memory cell gets its new value.
  const parentOf = new Map<number, number>();
  for (const node of nodes) {
    if (!needed.has(node.id)) continue;
    for (const child of node.children) parentOf.set(child, node.id);
  }
  const rootOf = (id: number): number => {
    let at = id;
    while (!(nodes[at] as Node).root) {
      const parent = parentOf.get(at);
      if (parent === undefined) break;
      at = parent;
    }
    return at;
  };
  const lastRead = new Map<number, number>();
  for (const node of nodes) {
    if (!needed.has(node.id)) continue;
    if (node.kind === 'leaf' && node.root) lastRead.set(node.id, node.id);
    for (const child of node.children) {
      if ((nodes[child] as Node).kind !== 'leaf') continue;
      lastRead.set(child, Math.max(lastRead.get(child) ?? -1, rootOf(node.id)));
    }
  }

  // The book warns about exactly this order problem: reading a variable after its new value has
  // been stored gives the wrong answer. The simple cure is to copy the old value aside first.
  for (const node of nodes) {
    if (node.kind !== 'leaf' || !needed.has(node.id)) continue;
    const name = node.source as string;
    const finalNode = builder.current.get(name) as number;
    const overwritten = finalNode !== node.id && live.has(name);
    if (overwritten && (lastRead.get(node.id) ?? -1) > finalNode) {
      const saved = freshName(`${name}.old`);
      code.push(`LD R1, ${name}`, `ST ${saved}, R1`);
      node.source = saved;
      record(
        'roots',
        null,
        node.id,
        `Save the old ${name}`,
        `A later tree still reads the old ${name}, but an earlier one stores its new value. Copy the old value aside first.`,
      );
    }
  }

  const treeIds = { next: 0 };
  const treeOf = (id: number, isRoot: boolean): SuTree => {
    const node = nodes[id] as Node;
    const treeId = treeIds.next++;
    if (!isRoot && node.root && node.kind === 'op') {
      return {
        id: treeId,
        kind: 'leaf',
        text: homes.get(id) as string,
        source: homes.get(id) as string,
        label: 1,
      };
    }
    if (node.kind !== 'op') {
      return {
        id: treeId,
        kind: 'leaf',
        text: node.label,
        source: node.source as string,
        label: 1,
      };
    }
    if (node.arity === 1) {
      const child = treeOf(node.children[0] as number, false);
      return {
        id: treeId,
        kind: 'unary',
        text: node.label,
        opcode: node.opcode as string,
        child,
        label: child.label,
      };
    }
    const left = treeOf(node.children[0] as number, false);
    const right = treeOf(node.children[1] as number, false);
    return {
      id: treeId,
      kind: 'binary',
      text: node.label,
      opcode: node.opcode as string,
      left,
      right,
      label: suLabel(left.label, right.label),
    };
  };

  const order: number[] = [];
  for (const node of nodes) {
    if (!node.root) continue;
    order.push(node.id);
    const tree = treeOf(node.id, true);
    node.ershov = tree.label;
    for (const part of suPostorder(tree)) {
      recorder.add(`Label ${part.text}: ${part.label}`, suExplainLabel(part), {
        phase: 'label',
        statement: null,
        focus: node.id,
        ...builder.view(),
        code: [...code],
      });
    }
    const result = suGenerate(
      tree,
      registers,
      ({ instruction, explanation }) => {
        code.push(instruction);
        record('generate', null, node.id, instruction, explanation);
      },
      (label) => freshName(`t${label}`),
    );
    for (const name of storedNames(node).length > 0
      ? storedNames(node)
      : [homes.get(node.id) as string]) {
      code.push(`ST ${name}, R${result}`);
      record(
        'generate',
        null,
        node.id,
        `ST ${name}, R${result}`,
        `Store this tree's value in ${name}${storedNames(node).includes(name) ? ', because that variable is live on exit' : ', so each user of this shared value can read it back'}.`,
      );
    }
  }

  record(
    'done',
    null,
    null,
    'Finished',
    `Generated ${code.length} instructions. Each tree used the fewest registers it could, and nodes nothing needed were left out.`,
  );
  return {
    statements,
    ...builder.view(),
    order,
    code,
    registers,
    liveOnExit,
    trace: recorder.finish(),
  };
}
