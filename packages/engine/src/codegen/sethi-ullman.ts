import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { codegenParseExpr, type CgExpr, type CgTreeNode } from './expr';
import { ISA_OPCODE_OF_OPERATOR } from './isa';

/** A tree ready for numbering. A leaf holds the operand text an LD instruction would use. */
export type SuTree =
  | { id: number; kind: 'leaf'; text: string; source: string; label: number }
  | { id: number; kind: 'unary'; text: string; opcode: string; child: SuTree; label: number }
  | {
      id: number;
      kind: 'binary';
      text: string;
      opcode: string;
      left: SuTree;
      right: SuTree;
      label: number;
    };

/** The book's labeling rules. It says nothing about unary nodes, which simply take their child's. */
export function suLabel(left: number, right: number): number {
  return left === right ? left + 1 : Math.max(left, right);
}

export function suTreeFromExpr(expr: CgExpr, ids: { next: number }): SuTree {
  const id = ids.next++;
  switch (expr.kind) {
    case 'num':
      return { id, kind: 'leaf', text: String(expr.value), source: `#${expr.value}`, label: 1 };
    case 'var':
      return { id, kind: 'leaf', text: expr.name, source: expr.name, label: 1 };
    case 'index':
      throw new EngineError({
        code: 'bad_expression',
        message: 'Arrays are not part of this demo.',
        hint: 'Use names and numbers.',
        position: expr.position,
        length: expr.length,
      });
    case 'unary': {
      const child = suTreeFromExpr(expr.arg, ids);
      return {
        id,
        kind: 'unary',
        text: expr.operator,
        opcode: expr.operator === '-' ? 'NEG' : 'NOT',
        child,
        label: child.label,
      };
    }
    case 'binary': {
      const left = suTreeFromExpr(expr.left, ids);
      const right = suTreeFromExpr(expr.right, ids);
      return {
        id,
        kind: 'binary',
        text: expr.operator,
        opcode: ISA_OPCODE_OF_OPERATOR[expr.operator],
        left,
        right,
        label: suLabel(left.label, right.label),
      };
    }
  }
}

export function suDrawTree(tree: SuTree): CgTreeNode {
  const children =
    tree.kind === 'leaf'
      ? []
      : tree.kind === 'unary'
        ? [suDrawTree(tree.child)]
        : [suDrawTree(tree.left), suDrawTree(tree.right)];
  return { id: tree.id, label: tree.text, children };
}

/** Postorder, which is the order the labels are worked out in. */
export function suPostorder(tree: SuTree): SuTree[] {
  if (tree.kind === 'leaf') return [tree];
  if (tree.kind === 'unary') return [...suPostorder(tree.child), tree];
  return [...suPostorder(tree.left), ...suPostorder(tree.right), tree];
}

export interface SuEmit {
  instruction: string;
  nodeId: number;
  explanation: string;
}

/**
 * Generates code from a labeled tree. With enough registers this is the book's Algorithm 8.24,
 * and otherwise its Algorithm 8.26, which stores the big subtree's value in a temporary.
 * Returns the number of the register holding the result.
 *
 * Note for checking against the book: for a little child with label j < r, some printings of the
 * algorithm say to use base r - j. The result must land in R_r, and a tree with label j at base b
 * finishes in R_(b+j-1), so the base has to be r - j + 1. This code uses that, and it reproduces
 * the book's own two-register output for its example.
 */
export function suGenerate(
  tree: SuTree,
  registerCount: number,
  emit: (item: SuEmit) => void,
  spillName: (label: number) => string,
): number {
  const r = registerCount;
  const reg = (number: number) => `R${number}`;

  const generate = (node: SuTree, base: number): number => {
    if (node.kind === 'leaf') {
      emit({
        instruction: `LD ${reg(base)}, ${node.source}`,
        nodeId: node.id,
        explanation: `A leaf has label 1, so it needs one register. With base ${base}, load it into ${reg(base)}.`,
      });
      return base;
    }
    if (node.kind === 'unary') {
      const result = generate(node.child, base);
      emit({
        instruction: `${node.opcode} ${reg(result)}, ${reg(result)}`,
        nodeId: node.id,
        explanation: `A unary operator works in place, in the register holding its operand.`,
      });
      return result;
    }

    const { left, right, label: k, opcode } = node;
    const equal = left.label === right.label;
    const bigIsRight = equal || right.label > left.label;
    const big = bigIsRight ? right : left;
    const small = bigIsRight ? left : right;

    if (k > r) {
      // Not enough registers: compute the big child with everything, and save it in memory.
      const bigResult = generate(big, 1);
      const temp = spillName(k);
      emit({
        instruction: `ST ${temp}, ${reg(bigResult)}`,
        nodeId: node.id,
        explanation: `This node has label ${k}, more than the ${r} registers available. Save the big child's value in the temporary ${temp}, which frees every register for the other child.`,
      });
      const j = small.label;
      const smallResult = generate(small, j >= r ? 1 : r - j + 1);
      emit({
        instruction: `LD ${reg(r - 1)}, ${temp}`,
        nodeId: node.id,
        explanation: `Bring the saved value back into ${reg(r - 1)}. The other child's value is in ${reg(smallResult)}.`,
      });
      const instruction = bigIsRight
        ? `${opcode} ${reg(r)}, ${reg(r)}, ${reg(r - 1)}`
        : `${opcode} ${reg(r)}, ${reg(r - 1)}, ${reg(r)}`;
      emit({
        instruction,
        nodeId: node.id,
        explanation: `Combine the two values. Keep the operands in source order, because not every operator is commutative.`,
      });
      return r;
    }

    const target = base + k - 1;
    if (equal) {
      // Right first, using one fewer register, so the left child can use the rest.
      generate(right, base + 1);
      generate(left, base);
      emit({
        instruction: `${opcode} ${reg(target)}, ${reg(target - 1)}, ${reg(target)}`,
        nodeId: node.id,
        explanation: `Both children have label ${left.label}, so this node needs one register more than either, label ${k}. The right child is in ${reg(target)} and the left in ${reg(target - 1)}.`,
      });
      return target;
    }

    // Big child first: when it finishes it holds just one register, leaving more than enough.
    const bigResult = generate(big, base);
    const smallResult = generate(small, base);
    const instruction = bigIsRight
      ? `${opcode} ${reg(bigResult)}, ${reg(smallResult)}, ${reg(bigResult)}`
      : `${opcode} ${reg(bigResult)}, ${reg(bigResult)}, ${reg(smallResult)}`;
    emit({
      instruction,
      nodeId: node.id,
      explanation: `The labels differ, so the bigger child (label ${big.label}) goes first and this node needs only label ${k}. Its result stays in ${reg(bigResult)}.`,
    });
    return bigResult;
  };

  return generate(tree, 1);
}

export interface SethiUllmanState {
  phase: 'label' | 'generate';
  /** The tree node this step is about. */
  node: number;
  /** Ershov numbers worked out so far, by node id. */
  labels: Record<number, number>;
  code: string[];
}

export interface SethiUllmanResult {
  tree: CgTreeNode;
  labels: Record<number, number>;
  /** The label at the root: the fewest registers this expression can use without spilling. */
  registersNeeded: number;
  registers: number;
  code: string[];
  /** Register number holding the final result. */
  resultRegister: number;
  /** True if there were too few registers, so values were saved to memory. */
  spills: boolean;
  trace: Trace<SethiUllmanState>;
}

export const SU_DEFAULT_REGISTERS = 3;

export function suCheckRegisters(registers: number): void {
  if (!Number.isInteger(registers) || registers < 2 || registers > 7) {
    throw new EngineError({
      code: 'bad_register_count',
      message: `This needs between 2 and 7 registers, but was asked to use ${registers}.`,
      hint: 'The book uses 3, then 2.',
    });
  }
}

export function suExplainLabel(node: SuTree): string {
  if (node.kind === 'leaf') return `${node.text} is a leaf, so its label is 1.`;
  if (node.kind === 'unary')
    return `A unary operator needs only its operand's registers: label ${node.label}.`;
  return node.left.label === node.right.label
    ? `Both children have label ${node.left.label}, so this node's label is one more: ${node.label}.`
    : `The children have labels ${node.left.label} and ${node.right.label}, so this node's label is the larger: ${node.label}.`;
}

/** Sethi-Ullman: number the tree, then generate optimal code for r registers. */
export function codegenSethiUllman(
  input: string | CgExpr,
  options: { registers?: number } = {},
): SethiUllmanResult {
  const registers = options.registers ?? SU_DEFAULT_REGISTERS;
  suCheckRegisters(registers);
  const expr = typeof input === 'string' ? codegenParseExpr(input) : input;
  const tree = suTreeFromExpr(expr, { next: 0 });
  const recorder = new TraceRecorder<SethiUllmanState>();

  const labels: Record<number, number> = {};
  const code: string[] = [];
  for (const node of suPostorder(tree)) {
    labels[node.id] = node.label;
    recorder.add(`Label ${node.text}: ${node.label}`, suExplainLabel(node), {
      phase: 'label',
      node: node.id,
      labels: { ...labels },
      code: [],
    });
  }

  const resultRegister = suGenerate(
    tree,
    registers,
    ({ instruction, nodeId, explanation }) => {
      code.push(instruction);
      recorder.add(instruction, explanation, {
        phase: 'generate',
        node: nodeId,
        labels,
        code: [...code],
      });
    },
    (label) => `t${label}`,
  );

  return {
    tree: suDrawTree(tree),
    labels,
    registersNeeded: tree.label,
    registers,
    code,
    resultRegister,
    spills: tree.label > registers,
    trace: recorder.finish(),
  };
}
