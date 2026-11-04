// The TinyC syntax tree. Every node is plain data with its position in the source. The parser
// leaves type and symbol empty, and semantic checking returns a copy with them filled in.

export type TinyBaseType = 'int' | 'bool';
export type TinyReturnType = TinyBaseType | 'void';

/** The type of an expression. int[] and bool[] appear only when an array is passed as an argument. */
export type TinyType = TinyBaseType | 'void' | 'int[]' | 'bool[]';

export interface TinySpan {
  position: number;
  length: number;
}

export type TinyBinaryOp =
  '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

export type TinyExpr = TinySpan & { type?: TinyType } & (
    | { kind: 'int'; value: number }
    | { kind: 'bool'; value: boolean }
    /** symbol is the unique name semantic checking picks, because block scopes can shadow. */
    | { kind: 'name'; name: string; symbol?: string }
    | { kind: 'index'; name: string; index: TinyExpr; symbol?: string }
    | { kind: 'unary'; operator: '-' | '!'; arg: TinyExpr }
    | { kind: 'binary'; operator: TinyBinaryOp; left: TinyExpr; right: TinyExpr }
    | { kind: 'call'; name: string; args: TinyExpr[] }
  );

export type TinyStmt = TinySpan &
  (
    | { kind: 'block'; statements: TinyStmt[] }
    | {
        kind: 'decl';
        name: string;
        baseType: TinyBaseType;
        /** Null for a scalar. */
        arraySize: number | null;
        init: TinyExpr | null;
        symbol?: string;
      }
    | {
        kind: 'assign';
        name: string;
        /** Null when assigning to a scalar. */
        index: TinyExpr | null;
        value: TinyExpr;
        symbol?: string;
      }
    | { kind: 'if'; cond: TinyExpr; then: TinyStmt; otherwise: TinyStmt | null }
    | { kind: 'while'; cond: TinyExpr; body: TinyStmt }
    | { kind: 'return'; value: TinyExpr | null }
    | { kind: 'print'; value: TinyExpr }
    | { kind: 'expression'; value: TinyExpr }
  );

export interface TinyParam extends TinySpan {
  name: string;
  baseType: TinyBaseType;
  isArray: boolean;
}

export interface TinyFunction extends TinySpan {
  name: string;
  returnType: TinyReturnType;
  params: TinyParam[];
  body: TinyStmt & { kind: 'block' };
}

export interface TinyProgram {
  functions: TinyFunction[];
}
