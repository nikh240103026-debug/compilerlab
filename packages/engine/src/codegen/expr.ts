import { EngineError } from '../core/result';
import type { TacBinaryOp, TacUnaryOp } from '../ir/types';

// A small expression language shared by the code generation demos and the runtime models, so a
// student can type a + b * c rather than build a tree by hand.

export const CODEGEN_MAX_EXPR_LENGTH = 2000;
const MAX_NESTING = 100;

export type CgExpr =
  | { kind: 'num'; value: number; position: number; length: number }
  | { kind: 'var'; name: string; position: number; length: number }
  /** a[i]. Only the parameter-passing model asks for these. */
  | { kind: 'index'; name: string; index: CgExpr; position: number; length: number }
  | { kind: 'unary'; operator: TacUnaryOp; arg: CgExpr; position: number; length: number }
  | {
      kind: 'binary';
      operator: TacBinaryOp;
      left: CgExpr;
      right: CgExpr;
      position: number;
      length: number;
    };

interface Tok {
  text: string;
  position: number;
}

const TOKEN = /\s*(\d+|[A-Za-z_][A-Za-z0-9_]*|<=|>=|==|!=|&&|\|\||[-+*/%<>!()[\]])/y;

function tokenize(text: string): Tok[] {
  const tokens: Tok[] = [];
  let at = 0;
  while (at < text.length) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text.slice(at).trim() === '') break;
      const position = at + (text.slice(at).length - text.slice(at).trimStart().length);
      throw new EngineError({
        code: 'bad_expression',
        message: `"${text[position]}" cannot appear in an expression.`,
        hint: 'Use names, whole numbers, operators and parentheses, like: a + b * (c - 1)',
        position,
        length: 1,
      });
    }
    const body = match[1] as string;
    tokens.push({ text: body, position: at + match[0].length - body.length });
    at = TOKEN.lastIndex;
  }
  return tokens;
}

/** Lowest precedence first. */
const LEVELS: readonly (readonly TacBinaryOp[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

/** Parses an expression. Bad input gives an EngineError with the position of the problem. */
export function codegenParseExpr(text: string, options: { allowIndex?: boolean } = {}): CgExpr {
  if (text.length > CODEGEN_MAX_EXPR_LENGTH) {
    throw new EngineError({
      code: 'expression_too_long',
      message: `This expression is longer than ${CODEGEN_MAX_EXPR_LENGTH} characters.`,
      hint: 'Try a shorter expression.',
    });
  }
  const tokens = tokenize(text);
  let index = 0;
  let depth = 0;

  const fail = (message: string): never => {
    const token = tokens[index];
    throw new EngineError({
      code: 'bad_expression',
      message,
      hint: 'Write an expression like: a + b * (c - 1)',
      position: token?.position ?? text.length,
      length: token?.text.length ?? 1,
    });
  };

  const span = (start: number, end: number) => ({ position: start, length: end - start });
  const endOf = (node: CgExpr) => node.position + node.length;

  const parsePrimary = (): CgExpr => {
    const token = tokens[index];
    if (!token) return fail('The expression stops too early.');
    if (token.text === '(') {
      if (++depth > MAX_NESTING) {
        return fail(`This expression nests more than ${MAX_NESTING} parentheses deep.`);
      }
      index++;
      const inner = parseLevel(0);
      if (tokens[index]?.text !== ')') return fail('A ")" is missing here.');
      index++;
      depth--;
      return inner;
    }
    if (/^\d/.test(token.text)) {
      index++;
      return {
        kind: 'num',
        value: Number(token.text) | 0,
        ...span(token.position, token.position + token.text.length),
      };
    }
    if (/^[A-Za-z_]/.test(token.text)) {
      index++;
      if (tokens[index]?.text === '[') {
        if (!options.allowIndex) return fail('Arrays are not part of this demo.');
        index++;
        const inner = parseLevel(0);
        const close = tokens[index];
        if (close?.text !== ']') return fail('A "]" is missing here.');
        index++;
        return {
          kind: 'index',
          name: token.text,
          index: inner,
          ...span(token.position, close.position + 1),
        };
      }
      return {
        kind: 'var',
        name: token.text,
        ...span(token.position, token.position + token.text.length),
      };
    }
    return fail(`"${token.text}" cannot start an expression here.`);
  };

  const parseUnary = (): CgExpr => {
    const token = tokens[index];
    if (token?.text === '-' || token?.text === '!') {
      index++;
      const arg = parseUnary();
      return { kind: 'unary', operator: token.text, arg, ...span(token.position, endOf(arg)) };
    }
    return parsePrimary();
  };

  const parseLevel = (level: number): CgExpr => {
    const operators = LEVELS[level];
    if (!operators) return parseUnary();
    let left = parseLevel(level + 1);
    for (;;) {
      const operator = tokens[index]?.text as TacBinaryOp | undefined;
      if (operator === undefined || !operators.includes(operator)) break;
      index++;
      const right = parseLevel(level + 1);
      left = { kind: 'binary', operator, left, right, ...span(left.position, endOf(right)) };
    }
    return left;
  };

  const expression = parseLevel(0);
  if (index < tokens.length)
    fail(`Unexpected "${(tokens[index] as Tok).text}" after the expression.`);
  return expression;
}

export function codegenFormatExpr(node: CgExpr): string {
  switch (node.kind) {
    case 'num':
      return String(node.value);
    case 'var':
      return node.name;
    case 'index':
      return `${node.name}[${codegenFormatExpr(node.index)}]`;
    case 'unary':
      return `${node.operator}${codegenFormatExpr(node.arg)}`;
    case 'binary':
      return `(${codegenFormatExpr(node.left)} ${node.operator} ${codegenFormatExpr(node.right)})`;
  }
}

/** A plain tree for drawing, in the same shape for every demo that shows an expression. */
export interface CgTreeNode {
  id: number;
  label: string;
  children: CgTreeNode[];
}
