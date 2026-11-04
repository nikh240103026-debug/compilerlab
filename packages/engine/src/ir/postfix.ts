import { TraceRecorder, type Trace } from '../core/trace';
import { irParse, type IrExpr, type IrProgram, type IrStmt } from './parser';

// Postfix notation: the syntax tree written in postorder, with each operator after its operands.
// For expressions this is the book's notation. a = b*-c + b*-c becomes
//
//   a b c uminus * b c uminus * + =
//
// Statements have no standard postfix form, so they follow the same pattern, with their keyword
// last: cond then-part if, cond then-part else-part ifelse, cond body while.

export interface IrPostfixState {
  node: number;
  nodeKind: string;
  text: string;
  start: number;
  end: number;
  /** What this step added. */
  appended: string[];
  /** tokens[0..tokenCount) exist at this step. */
  tokenCount: number;
}

export interface IrPostfixResult {
  program: IrProgram;
  tokens: string[];
  /** The tokens joined with spaces. */
  text: string;
  trace: Trace<IrPostfixState>;
}

function operatorToken(expr: Extract<IrExpr, { kind: 'unary' }>): string {
  return expr.op === '-' ? 'uminus' : '!';
}

/** Writes a program in postfix, with one step for each node, operands before operators. */
export function irToPostfix(source: string): IrPostfixResult {
  const program = irParse(source);
  const recorder = new TraceRecorder<IrPostfixState>();
  const tokens: string[] = [];

  const visit = (
    node: { id: number; kind: string; start: number; end: number },
    appended: string[],
    explanation: string,
  ): void => {
    tokens.push(...appended);
    recorder.add(appended.join(' '), explanation, {
      node: node.id,
      nodeKind: node.kind,
      text: program.source.slice(node.start, node.end),
      start: node.start,
      end: node.end,
      appended,
      tokenCount: tokens.length,
    });
  };

  const expression = (expr: IrExpr): void => {
    switch (expr.kind) {
      case 'num':
        visit(
          expr,
          [String(expr.value)],
          'An operand has no parts, so it is written straight away.',
        );
        return;
      case 'bool':
        visit(
          expr,
          [String(expr.value)],
          'An operand has no parts, so it is written straight away.',
        );
        return;
      case 'var':
        visit(expr, [expr.name], 'An operand has no parts, so it is written straight away.');
        return;
      case 'unary':
        expression(expr.arg);
        visit(
          expr,
          [operatorToken(expr)],
          'Its operand is written, so the operator can follow it.',
        );
        return;
      case 'binary':
        expression(expr.left);
        expression(expr.right);
        visit(expr, [expr.op], 'Both operands are written, so the operator can follow them.');
        return;
      case 'index':
        visit(expr, [expr.base], 'The array name comes first, then each index followed by [].');
        for (const index of expr.indices) {
          expression(index);
          visit(expr, ['[]'], 'The array part and this index are written, so [] can follow them.');
        }
        return;
      case 'call':
        for (const arg of expr.args) expression(arg);
        visit(
          expr,
          [`call(${expr.name},${expr.args.length})`],
          'The arguments are written, so the call can follow them. It says how many values it takes.',
        );
        return;
    }
  };

  const statement = (item: IrStmt): void => {
    switch (item.kind) {
      case 'decl':
        // A declaration computes nothing, so it has no postfix form.
        return;
      case 'assign':
        expression(item.target);
        expression(item.value);
        visit(item, ['='], 'The target and the value are written, so = can follow them.');
        return;
      case 'expr':
        expression(item.expr);
        return;
      case 'if':
        expression(item.cond);
        statement(item.thenBranch);
        if (item.elseBranch) {
          statement(item.elseBranch);
          visit(
            item,
            ['ifelse'],
            'The condition and both branches are written, so ifelse can follow them.',
          );
        } else {
          visit(item, ['if'], 'The condition and the body are written, so if can follow them.');
        }
        return;
      case 'while':
        expression(item.cond);
        statement(item.body);
        visit(item, ['while'], 'The condition and the body are written, so while can follow them.');
        return;
      case 'switch':
        expression(item.subject);
        for (const part of item.cases) {
          for (const inner of part.body) statement(inner);
          visit(
            { id: item.id, kind: 'case', start: part.start, end: part.end },
            part.value === null ? ['default'] : [String(part.value), 'case'],
            'The body is written, so the case marker can follow it.',
          );
        }
        visit(
          item,
          ['switch'],
          'The value and all the cases are written, so switch can follow them.',
        );
        return;
      case 'block':
        for (const inner of item.body) statement(inner);
        return;
      case 'break':
        visit(item, ['break'], 'break has no parts, so it is written straight away.');
        return;
      case 'return':
        if (item.value) expression(item.value);
        visit(
          item,
          ['return'],
          item.value
            ? 'The value is written, so return can follow it.'
            : 'This return has no value.',
        );
        return;
    }
  };

  for (const item of program.body) statement(item);
  return { program, tokens, text: tokens.join(' '), trace: recorder.finish() };
}
