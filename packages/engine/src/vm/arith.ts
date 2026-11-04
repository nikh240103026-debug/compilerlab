import type { TacBinaryOp, TacUnaryOp } from '../ir/types';

// One definition of arithmetic, shared by the VM and the optimizer. If they disagreed, constant
// folding would change what a program prints. Values are 32-bit signed integers that wrap, and
// division truncates toward zero, the same as C on a typical machine.

/** Returns null for division by zero: the VM reports it, and the optimizer must not fold it. */
export function vmEvalBinary(operator: TacBinaryOp, left: number, right: number): number | null {
  switch (operator) {
    case '+':
      return (left + right) | 0;
    case '-':
      return (left - right) | 0;
    case '*':
      return Math.imul(left, right);
    case '/':
      return right === 0 ? null : Math.trunc(left / right) | 0;
    case '%':
      return right === 0 ? null : (left % right) | 0;
    case '<':
      return left < right ? 1 : 0;
    case '<=':
      return left <= right ? 1 : 0;
    case '>':
      return left > right ? 1 : 0;
    case '>=':
      return left >= right ? 1 : 0;
    case '==':
      return left === right ? 1 : 0;
    case '!=':
      return left !== right ? 1 : 0;
    case '&&':
      return left !== 0 && right !== 0 ? 1 : 0;
    case '||':
      return left !== 0 || right !== 0 ? 1 : 0;
  }
}

export function vmEvalUnary(operator: TacUnaryOp, value: number): number {
  return operator === '-' ? -value | 0 : value === 0 ? 1 : 0;
}
