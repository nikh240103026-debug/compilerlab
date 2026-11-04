import type { TinyExpr, TinyProgram, TinySpan, TinyStmt } from './ast';

/** The syntax tree in one simple shape, so a visualizer can draw any node the same way. */
export interface TinyAstNode extends TinySpan {
  label: string;
  /** The checked type, once semantic analysis has run. */
  type: string | null;
  children: TinyAstNode[];
}

function exprNode(expr: TinyExpr): TinyAstNode {
  const node = (label: string, children: TinyAstNode[] = []): TinyAstNode => ({
    label,
    type: expr.type ?? null,
    children,
    position: expr.position,
    length: expr.length,
  });
  switch (expr.kind) {
    case 'int':
      return node(String(expr.value));
    case 'bool':
      return node(String(expr.value));
    case 'name':
      return node(expr.name);
    case 'index':
      return node(`${expr.name}[ ]`, [exprNode(expr.index)]);
    case 'unary':
      return node(expr.operator, [exprNode(expr.arg)]);
    case 'binary':
      return node(expr.operator, [exprNode(expr.left), exprNode(expr.right)]);
    case 'call':
      return node(`call ${expr.name}`, expr.args.map(exprNode));
  }
}

function stmtNode(statement: TinyStmt): TinyAstNode {
  const node = (label: string, children: TinyAstNode[] = []): TinyAstNode => ({
    label,
    type: null,
    children,
    position: statement.position,
    length: statement.length,
  });
  switch (statement.kind) {
    case 'block':
      return node('block', statement.statements.map(stmtNode));
    case 'decl': {
      const size = statement.arraySize === null ? '' : `[${statement.arraySize}]`;
      return node(
        `${statement.baseType} ${statement.name}${size}`,
        statement.init ? [exprNode(statement.init)] : [],
      );
    }
    case 'assign': {
      const target = statement.index ? `${statement.name}[ ] =` : `${statement.name} =`;
      return node(target, [
        ...(statement.index ? [exprNode(statement.index)] : []),
        exprNode(statement.value),
      ]);
    }
    case 'if':
      return node('if', [
        exprNode(statement.cond),
        stmtNode(statement.then),
        ...(statement.otherwise ? [stmtNode(statement.otherwise)] : []),
      ]);
    case 'while':
      return node('while', [exprNode(statement.cond), stmtNode(statement.body)]);
    case 'return':
      return node('return', statement.value ? [exprNode(statement.value)] : []);
    case 'print':
      return node('print', [exprNode(statement.value)]);
    case 'expression':
      return node('call statement', [exprNode(statement.value)]);
  }
}

/** Stage 3 of the capstone's eight: the tree itself, in a shape that is simple to draw. */
export function tinycAstTree(program: TinyProgram): TinyAstNode {
  const last = program.functions.at(-1);
  return {
    label: 'program',
    type: null,
    position: 0,
    length: last ? last.position + last.length : 0,
    children: program.functions.map((fn) => ({
      label: `${fn.returnType} ${fn.name}(${fn.params.map((param) => `${param.baseType} ${param.name}${param.isArray ? '[]' : ''}`).join(', ')})`,
      type: null,
      position: fn.position,
      length: fn.length,
      children: fn.body.statements.map(stmtNode),
    })),
  };
}
