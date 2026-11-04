import { TraceRecorder, type Trace } from '../core/trace';
import { codegenFormatExpr, codegenParseExpr, type CgExpr, type CgTreeNode } from './expr';
import { ISA_OPCODE_OF_OPERATOR } from './isa';

export interface StackCodeState {
  /** The tree node this step finishes, by id. */
  node: number;
  /** All code so far. */
  code: string[];
  /** What the stack would hold at run time, shown symbolically, bottom first. */
  stack: string[];
  maxDepth: number;
}

export interface StackCodeResult {
  tree: CgTreeNode;
  code: string[];
  /** The code with PRINT and HALT added, ready for vmExecute. */
  runnable: string;
  /** How many stack cells the expression needs at its deepest. */
  maxDepth: number;
  trace: Trace<StackCodeState>;
}

/**
 * Generates stack-machine code by a postorder walk: code for the operands first, then the
 * operator. When the operator runs, its operands are exactly the top values on the stack.
 */
export function codegenStackMachine(input: string | CgExpr): StackCodeResult {
  const ast = typeof input === 'string' ? codegenParseExpr(input) : input;
  const recorder = new TraceRecorder<StackCodeState>();
  const code: string[] = [];
  const stack: string[] = [];
  let maxDepth = 0;
  let nextId = 0;

  const record = (node: number, title: string, explanation: string) => {
    maxDepth = Math.max(maxDepth, stack.length);
    recorder.add(title, explanation, { node, code: [...code], stack: [...stack], maxDepth });
  };

  const walk = (node: CgExpr): CgTreeNode => {
    const id = nextId++;
    switch (node.kind) {
      case 'num': {
        code.push(`PUSH #${node.value}`);
        stack.push(String(node.value));
        record(id, `PUSH #${node.value}`, `A constant has no operands. Push its value.`);
        return { id, label: String(node.value), children: [] };
      }
      case 'var': {
        code.push(`PUSH ${node.name}`);
        stack.push(node.name);
        record(
          id,
          `PUSH ${node.name}`,
          `Read variable ${node.name} from memory and push its value.`,
        );
        return { id, label: node.name, children: [] };
      }
      case 'index':
        // The parser only makes these when asked to, and this function never asks.
        return { id, label: codegenFormatExpr(node), children: [] };
      case 'unary': {
        const child = walk(node.arg);
        const opcode = node.operator === '-' ? 'NEG' : 'NOT';
        code.push(opcode);
        const arg = stack.pop() as string;
        stack.push(`${node.operator}${arg}`);
        record(
          id,
          opcode,
          `The operand is on top of the stack. ${opcode} replaces it with the result.`,
        );
        return { id, label: node.operator, children: [child] };
      }
      case 'binary': {
        const left = walk(node.left);
        const right = walk(node.right);
        const opcode = ISA_OPCODE_OF_OPERATOR[node.operator];
        code.push(opcode);
        const rightValue = stack.pop() as string;
        const leftValue = stack.pop() as string;
        stack.push(`(${leftValue} ${node.operator} ${rightValue})`);
        record(
          id,
          opcode,
          `Both operands are on the stack, the right one on top. ${opcode} pops them both and pushes ${leftValue} ${node.operator} ${rightValue}.`,
        );
        return { id, label: node.operator, children: [left, right] };
      }
    }
  };

  const tree = walk(ast);
  return {
    tree,
    code,
    runnable: [...code, 'PRINT', 'HALT'].join('\n'),
    maxDepth,
    trace: recorder.finish(),
  };
}
