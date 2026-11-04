import { TraceRecorder, type Trace } from '../core/trace';
import { locateOffset } from '../flex/spec';
import { tcParse, type TcExpr, type TcNodeBase, type TcProgram, type TcStmt } from './tc-parser';
import {
  TYPE_BOOL,
  TYPE_CHAR,
  TYPE_ERROR,
  TYPE_FLOAT,
  TYPE_INT,
  TYPE_VOID,
  typeExprFormat,
  type TypeExpr,
} from './type-expr';
import {
  TYPE_NUMERIC_NAMES,
  typeConversionKind,
  typeIsEquivalent,
  typeMaxOf,
} from './type-relations';

// A type checker for the mini-language, as a stepper. Expressions are visited after their operands,
// so each step can state its operands' types, the rule it applies, any conversion it inserts, and
// any error, with a location. After an error the node gets the error type, which matches anything,
// so one mistake gives one message.

export interface TcDiagnostic {
  code: string;
  message: string;
  hint: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

/** A conversion the compiler inserts, like (float) a. */
export interface TcCoercion {
  node: number;
  text: string;
  from: string;
  to: string;
  conversion: string;
  /** Where it happens, like "left operand" or "argument 2". */
  context: string;
}

export interface TcSymbolView {
  name: string;
  type: string;
  kind: 'variable' | 'parameter' | 'function';
}

export interface TcScopeView {
  level: number;
  /** What opened it. */
  owner: string;
  symbols: TcSymbolView[];
}

export interface TcState {
  node: number | null;
  nodeKind: string;
  /** The source text of the node. */
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
  /** The node's type, once known. */
  type: string | null;
  /** The typing rule used, like E1 + E2 : max(t1, t2). */
  rule: string;
  coercions: TcCoercion[];
  errors: TcDiagnostic[];
  errorCount: number;
  /** Outermost scope first. */
  scopes: TcScopeView[];
}

export interface TcResult {
  program: TcProgram;
  ok: boolean;
  errors: TcDiagnostic[];
  coercions: TcCoercion[];
  /** The type of each expression, by node id. */
  nodeTypes: { node: number; type: string }[];
  /** The struct types the program declared. */
  structs: { name: string; type: string }[];
  /** The scope still open at the end, which is the global one. */
  globals: TcSymbolView[];
  trace: Trace<TcState>;
}

interface OpenScope {
  level: number;
  owner: string;
  symbols: Map<string, { type: TypeExpr; kind: TcSymbolView['kind'] }>;
}

function numericName(type: TypeExpr): string | null {
  return type.kind === 'basic' && TYPE_NUMERIC_NAMES.includes(type.name) ? type.name : null;
}

function isIntegral(type: TypeExpr): boolean {
  const name = numericName(type);
  return name !== null && name !== 'float' && name !== 'double';
}

function isVoid(type: TypeExpr): boolean {
  return type.kind === 'basic' && type.name === 'void';
}

function alwaysReturns(statement: TcStmt): boolean {
  switch (statement.kind) {
    case 'return':
      return true;
    case 'block':
      return statement.body.some(alwaysReturns);
    case 'if':
      return (
        statement.elseBranch !== null &&
        alwaysReturns(statement.thenBranch) &&
        alwaysReturns(statement.elseBranch)
      );
    default:
      return false;
  }
}

class TypeChecker {
  private readonly recorder = new TraceRecorder<TcState>();
  private readonly errors: TcDiagnostic[] = [];
  private readonly coercions: TcCoercion[] = [];
  private readonly nodeTypes: { node: number; type: string }[] = [];
  private readonly structs: { name: string; type: TypeExpr }[] = [];
  private readonly reportedUndeclared = new Set<string>();
  private readonly scopes: OpenScope[] = [{ level: 0, owner: 'program', symbols: new Map() }];
  private currentFunction: { name: string; result: TypeExpr } | null = null;

  constructor(private readonly program: TcProgram) {}

  run(): TcResult {
    this.recorder.add(
      'Start',
      "The global scope opens, empty. The checker visits the program in order, and each expression after its operands, because a node's type depends on theirs.",
      this.state(null, 'program', '', 0, 0, null, '', [], []),
    );
    for (const statement of this.program.body) this.statement(statement);
    this.recorder.add(
      'Finished',
      this.errors.length === 0
        ? `The program is well typed. The checker inserted ${this.coercions.length} conversion${this.coercions.length === 1 ? '' : 's'}.`
        : `The checker found ${this.errors.length} error${this.errors.length === 1 ? '' : 's'}.`,
      this.state(
        null,
        'program',
        '',
        this.program.source.length,
        this.program.source.length,
        null,
        '',
        [],
        [],
      ),
    );
    return {
      program: this.program,
      ok: this.errors.length === 0,
      errors: this.errors,
      coercions: this.coercions,
      nodeTypes: this.nodeTypes,
      structs: this.structs.map(({ name, type }) => ({ name, type: typeExprFormat(type) })),
      globals: this.scopeView(this.scopes[0] as OpenScope).symbols,
      trace: this.recorder.finish(),
    };
  }

  private scopeView(scope: OpenScope): TcScopeView {
    return {
      level: scope.level,
      owner: scope.owner,
      symbols: [...scope.symbols].map(([name, symbol]) => ({
        name,
        type: typeExprFormat(symbol.type),
        kind: symbol.kind,
      })),
    };
  }

  private state(
    node: number | null,
    nodeKind: string,
    text: string,
    start: number,
    end: number,
    type: TypeExpr | null,
    rule: string,
    coercions: TcCoercion[],
    errors: TcDiagnostic[],
  ): TcState {
    const { line, column } = locateOffset(this.program.source, start);
    return {
      node,
      nodeKind,
      text,
      start,
      end,
      line,
      column,
      type: type ? typeExprFormat(type) : null,
      rule,
      coercions: coercions.map((item) => ({ ...item })),
      errors: errors.map((item) => ({ ...item })),
      errorCount: this.errors.length,
      scopes: this.scopes.map((scope) => this.scopeView(scope)),
    };
  }

  private textOf(node: TcNodeBase): string {
    return this.program.source.slice(node.start, node.end);
  }

  private step(
    title: string,
    explanation: string,
    node: TcNodeBase & { kind: string },
    type: TypeExpr | null,
    rule: string,
    coercions: TcCoercion[] = [],
    errors: TcDiagnostic[] = [],
  ): void {
    const text = this.textOf(node);
    const short = text.length > 60 ? `${text.slice(0, 57)}...` : text;
    this.recorder.add(
      title,
      explanation,
      this.state(node.id, node.kind, short, node.start, node.end, type, rule, coercions, errors),
    );
  }

  private report(
    code: string,
    message: string,
    hint: string,
    node: { start: number; end: number },
  ): TcDiagnostic {
    const { line, column } = locateOffset(this.program.source, node.start);
    const diagnostic: TcDiagnostic = {
      code,
      message,
      hint,
      start: node.start,
      end: node.end,
      line,
      column,
    };
    this.errors.push(diagnostic);
    return diagnostic;
  }

  private insertConversion(
    expr: TcExpr,
    from: TypeExpr,
    to: TypeExpr,
    context: string,
  ): TcCoercion {
    const text = this.textOf(expr);
    const coercion: TcCoercion = {
      node: expr.id,
      text,
      from: typeExprFormat(from),
      to: typeExprFormat(to),
      conversion: `(${typeExprFormat(to)}) ${text}`,
      context,
    };
    this.coercions.push(coercion);
    return coercion;
  }

  private structOf(type: TypeExpr): TypeExpr | null {
    if (type.kind !== 'named') return type;
    return this.structs.find((item) => item.name === type.name)?.type ?? null;
  }

  // ------ Scopes ------

  private top(): OpenScope {
    return this.scopes.at(-1) as OpenScope;
  }

  private lookup(name: string): { type: TypeExpr; kind: TcSymbolView['kind'] } | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const symbol = (this.scopes[i] as OpenScope).symbols.get(name);
      if (symbol) return symbol;
    }
    return null;
  }

  private openScope(owner: string, node: TcNodeBase & { kind: string }): void {
    this.scopes.push({ level: this.scopes.length, owner, symbols: new Map() });
    this.step(
      `Enter ${owner}`,
      `A new scope opens at level ${this.scopes.length - 1}. Names declared here hide outer names until it closes.`,
      node,
      null,
      'enter scope',
    );
  }

  private closeScope(node: TcNodeBase & { kind: string }): void {
    const closing = this.scopes.pop() as OpenScope;
    const names = [...closing.symbols.keys()];
    this.step(
      `Exit ${closing.owner}`,
      `The scope at level ${closing.level} closes${names.length > 0 ? `, and ${names.join(', ')} ${names.length === 1 ? 'goes' : 'go'} out of scope` : ''}.`,
      node,
      null,
      'exit scope',
    );
  }

  // ------ Conversions on assignment, arguments and return ------

  /** Checks that a value of type `from` can go where `to` is wanted. Only widening is implicit. */
  private convertTo(
    expr: TcExpr,
    from: TypeExpr,
    to: TypeExpr,
    context: string,
  ): { coercions: TcCoercion[]; problem: { code: string; message: string; hint: string } | null } {
    if (from.kind === 'error' || to.kind === 'error') return { coercions: [], problem: null };
    if (typeIsEquivalent(from, to, 'name', this.structs)) return { coercions: [], problem: null };
    const fromName = numericName(from);
    const toName = numericName(to);
    if (fromName && toName) {
      if (typeConversionKind(fromName, toName) === 'widening') {
        return { coercions: [this.insertConversion(expr, from, to, context)], problem: null };
      }
      return {
        coercions: [],
        problem: {
          code: 'tc_narrowing',
          message: `${fromName} does not convert to ${toName} automatically, because that can lose information.`,
          hint: `Only widening is implicit. Declare the ${context} as ${fromName}, or use a value of type ${toName}.`,
        },
      };
    }
    // An array used as a value means the address of its first element.
    if (from.kind === 'array' && to.kind === 'pointer') {
      if (typeIsEquivalent(from.element, to.target, 'name', this.structs)) {
        return { coercions: [this.insertConversion(expr, from, to, context)], problem: null };
      }
    }
    // A parameter like int a[] accepts an array of any length.
    if (from.kind === 'array' && to.kind === 'array' && to.size === null) {
      if (typeIsEquivalent(from.element, to.element, 'name', this.structs)) {
        return { coercions: [], problem: null };
      }
    }
    return {
      coercions: [],
      problem: {
        code: 'tc_type_mismatch',
        message: `The ${context} has type ${typeExprFormat(from)}, but ${typeExprFormat(to)} is needed.`,
        hint: 'These types have no conversion between them.',
      },
    };
  }

  // ------ Statements ------

  private statement(statement: TcStmt): void {
    switch (statement.kind) {
      case 'decl':
        this.declaration(statement);
        return;
      case 'assign':
        this.assignment(statement);
        return;
      case 'expr':
        this.expr(statement.expr);
        return;
      case 'if':
      case 'while':
        this.condition(statement.cond, statement.kind);
        if (statement.kind === 'while') {
          this.statement(statement.body);
        } else {
          this.statement(statement.thenBranch);
          if (statement.elseBranch) this.statement(statement.elseBranch);
        }
        this.step(
          `${statement.kind} statement`,
          `The condition and the ${statement.kind === 'if' ? 'branches' : 'body'} have been checked. A statement has no value, so its type is void.`,
          statement,
          TYPE_VOID,
          statement.kind === 'if'
            ? 'if (E : bool) S1 else S2 : void'
            : 'while (E : bool) S1 : void',
        );
        return;
      case 'return':
        this.returnStatement(statement);
        return;
      case 'block':
        this.openScope('block', statement);
        for (const inner of statement.body) this.statement(inner);
        this.closeScope(statement);
        return;
      case 'function':
        this.functionDeclaration(statement);
        return;
      case 'struct':
        this.structDeclaration(statement);
        return;
    }
  }

  private condition(cond: TcExpr, owner: string): void {
    const type = this.expr(cond);
    if (type.kind === 'error' || typeIsEquivalent(type, TYPE_BOOL, 'name')) {
      this.step(
        `Condition of ${owner}`,
        `The condition of ${owner} must be bool, and ${type.kind === 'error' ? 'this one already has an error' : 'it is'}.`,
        cond,
        type,
        `${owner} (E) needs E : bool`,
      );
      return;
    }
    const error = this.report(
      'tc_condition_not_bool',
      `The condition of ${owner} has type ${typeExprFormat(type)}, but it must be bool.`,
      'Write a comparison, like x != 0.',
      cond,
    );
    this.step(
      `Condition of ${owner}`,
      error.message,
      cond,
      TYPE_ERROR,
      `${owner} (E) needs E : bool`,
      [],
      [error],
    );
  }

  /** Whether a declared type is usable, reporting the problem if not. Returns the type to record. */
  private checkDeclaredType(
    type: TypeExpr,
    node: { start: number; end: number },
    name: string,
  ): { type: TypeExpr; error: TcDiagnostic | null } {
    if (isVoid(type)) {
      return {
        type: TYPE_ERROR,
        error: this.report(
          'tc_void_variable',
          `${name} cannot have type void, because void holds no value.`,
          'Use int, float, char or bool.',
          node,
        ),
      };
    }
    const walk = (current: TypeExpr): TcDiagnostic | null => {
      if (current.kind === 'named' && !this.structs.some((item) => item.name === current.name)) {
        return this.report(
          'tc_unknown_type',
          `struct ${current.name} has not been declared.`,
          `Declare struct ${current.name} before using it.`,
          node,
        );
      }
      if (current.kind === 'array') {
        if (isVoid(current.element)) {
          return this.report(
            'tc_void_variable',
            `${name} cannot be an array of void.`,
            'Use int, float, char or bool.',
            node,
          );
        }
        return walk(current.element);
      }
      if (current.kind === 'pointer') return walk(current.target);
      return null;
    };
    const error = walk(type);
    return error ? { type: TYPE_ERROR, error } : { type, error: null };
  }

  private declare(
    name: string,
    type: TypeExpr,
    kind: TcSymbolView['kind'],
    node: { start: number; end: number },
  ): TcDiagnostic | null {
    const scope = this.top();
    if (scope.symbols.has(name)) {
      return this.report(
        'tc_redeclared',
        `${name} is already declared in this scope.`,
        'Use a different name, or remove one declaration.',
        node,
      );
    }
    scope.symbols.set(name, { type, kind });
    return null;
  }

  private declaration(statement: Extract<TcStmt, { kind: 'decl' }>): void {
    const { name, init } = statement;
    const errors: TcDiagnostic[] = [];
    const checked = this.checkDeclaredType(statement.type, statement, name);
    if (checked.error) errors.push(checked.error);
    let coercions: TcCoercion[] = [];
    if (init) {
      const initType = this.expr(init);
      if (statement.type.kind === 'array') {
        errors.push(
          this.report(
            'tc_array_init',
            'An array cannot have an initializer in this language.',
            'Assign each element separately.',
            init,
          ),
        );
      } else {
        const result = this.convertTo(init, initType, checked.type, 'initial value');
        coercions = result.coercions;
        if (result.problem)
          errors.push(
            this.report(result.problem.code, result.problem.message, result.problem.hint, init),
          );
      }
    }
    const clash = this.declare(name, checked.type, 'variable', statement);
    if (clash) errors.push(clash);
    const explanation = errors[0]
      ? (errors[0] as TcDiagnostic).message
      : `${name} enters the current scope with type ${typeExprFormat(checked.type)}.${coercions[0] ? ` Its initial value is converted with ${coercions[0].conversion}.` : ''}`;
    this.step(
      `Declare ${name}`,
      explanation,
      statement,
      checked.type,
      'T id : enter id with type T',
      coercions,
      errors,
    );
  }

  private assignment(statement: Extract<TcStmt, { kind: 'assign' }>): void {
    const targetType = this.expr(statement.target);
    const valueType = this.expr(statement.value);
    const rule = "L = E : needs E's type to equal or widen to L's type";
    const errors: TcDiagnostic[] = [];
    let coercions: TcCoercion[] = [];
    const target = statement.target;
    const assignable =
      target.kind === 'index' ||
      target.kind === 'field' ||
      (target.kind === 'unary' && target.op === '*') ||
      (target.kind === 'name' && this.lookup(target.name)?.kind !== 'function');
    if (!assignable) {
      errors.push(
        this.report(
          'tc_not_assignable',
          `${this.textOf(target)} cannot be assigned to, because it does not name a place in memory.`,
          'The left side must be a variable, an array element, a field or *p.',
          target,
        ),
      );
    } else if (targetType.kind === 'array') {
      errors.push(
        this.report(
          'tc_array_assign',
          'An array cannot be assigned as a whole.',
          'Assign each element separately.',
          target,
        ),
      );
    } else {
      const result = this.convertTo(statement.value, valueType, targetType, 'assigned value');
      coercions = result.coercions;
      if (result.problem)
        errors.push(
          this.report(
            result.problem.code,
            result.problem.message,
            result.problem.hint,
            statement.value,
          ),
        );
    }
    const explanation = errors[0]
      ? (errors[0] as TcDiagnostic).message
      : coercions[0]
        ? `The value has type ${coercions[0].from}, and the target has type ${coercions[0].to}. That is a widening, so the compiler inserts ${coercions[0].conversion}.`
        : `Both sides have type ${typeExprFormat(targetType)}.`;
    this.step(
      'Assignment',
      explanation,
      statement,
      errors.length > 0 ? TYPE_ERROR : targetType,
      rule,
      coercions,
      errors,
    );
  }

  private returnStatement(statement: Extract<TcStmt, { kind: 'return' }>): void {
    const rule = "return E : needs E's type to equal or widen to the function's result type";
    const errors: TcDiagnostic[] = [];
    let coercions: TcCoercion[] = [];
    const valueType = statement.value ? this.expr(statement.value) : TYPE_VOID;
    const result = this.currentFunction?.result;
    if (!result) {
      errors.push(
        this.report(
          'tc_return_outside',
          'return only makes sense inside a function.',
          'Move it into a function, or remove it.',
          statement,
        ),
      );
    } else if (!statement.value) {
      if (!isVoid(result)) {
        errors.push(
          this.report(
            'tc_missing_value',
            `This function must return ${typeExprFormat(result)}, but this return has no value.`,
            'Add the value to return.',
            statement,
          ),
        );
      }
    } else if (isVoid(result)) {
      errors.push(
        this.report(
          'tc_unexpected_value',
          'A void function cannot return a value.',
          'Remove the value, or change the result type.',
          statement,
        ),
      );
    } else {
      const converted = this.convertTo(statement.value, valueType, result, 'returned value');
      coercions = converted.coercions;
      if (converted.problem)
        errors.push(
          this.report(
            converted.problem.code,
            converted.problem.message,
            converted.problem.hint,
            statement.value,
          ),
        );
    }
    const explanation = errors[0]
      ? (errors[0] as TcDiagnostic).message
      : `The returned value fits the result type of ${this.currentFunction?.name}.${coercions[0] ? ` The compiler inserts ${coercions[0].conversion}.` : ''}`;
    this.step(
      'Return',
      explanation,
      statement,
      errors.length > 0 ? TYPE_ERROR : valueType,
      rule,
      coercions,
      errors,
    );
  }

  private functionDeclaration(statement: Extract<TcStmt, { kind: 'function' }>): void {
    const errors: TcDiagnostic[] = [];
    const walkNamed = (type: TypeExpr): TcDiagnostic | null => {
      if (type.kind === 'named' && !this.structs.some((item) => item.name === type.name)) {
        return this.report(
          'tc_unknown_type',
          `struct ${type.name} has not been declared.`,
          `Declare struct ${type.name} before using it.`,
          statement,
        );
      }
      if (type.kind === 'pointer') return walkNamed(type.target);
      if (type.kind === 'array') return walkNamed(type.element);
      return null;
    };
    const resultProblem = walkNamed(statement.result);
    if (resultProblem) errors.push(resultProblem);
    const result = resultProblem ? TYPE_ERROR : statement.result;
    const params = statement.params.map((param) => {
      const checked = this.checkDeclaredType(param.type, param, param.name);
      if (checked.error) errors.push(checked.error);
      return { ...param, type: checked.type };
    });
    const type: TypeExpr = { kind: 'function', params: params.map((param) => param.type), result };
    // Entering the name first lets the body call itself.
    const clash = this.declare(statement.name, type, 'function', statement);
    if (clash) errors.push(clash);
    this.step(
      `Function ${statement.name}`,
      errors[0]
        ? (errors[0] as TcDiagnostic).message
        : `${statement.name} enters the scope with type ${typeExprFormat(type)}. It goes in before its body is checked, so the body can call it.`,
      statement,
      type,
      'T id (T1 p1, ..., Tn pn) : id has type T1 × ... × Tn → T',
      [],
      errors,
    );

    const outer = this.currentFunction;
    this.currentFunction = { name: statement.name, result };
    this.openScope(`function ${statement.name}`, statement);
    for (const param of params) {
      const paramClash = this.declare(param.name, param.type, 'parameter', param);
      this.step(
        `Parameter ${param.name}`,
        paramClash
          ? paramClash.message
          : `${param.name} enters the function's scope with type ${typeExprFormat(param.type)}.`,
        { id: statement.id, kind: 'parameter', start: param.start, end: param.end },
        param.type,
        "parameter : enter it in the function's scope",
        [],
        paramClash ? [paramClash] : [],
      );
    }
    for (const inner of statement.body) this.statement(inner);
    if (!isVoid(result) && result.kind !== 'error' && !statement.body.some(alwaysReturns)) {
      const missing = this.report(
        'tc_missing_return',
        `${statement.name} must return ${typeExprFormat(result)}, but some paths reach the end with no return.`,
        'Add a return on every path.',
        statement,
      );
      this.step(
        `End of ${statement.name}`,
        missing.message,
        statement,
        TYPE_ERROR,
        'every path must return',
        [],
        [missing],
      );
    }
    this.closeScope(statement);
    this.currentFunction = outer;
  }

  private structDeclaration(statement: Extract<TcStmt, { kind: 'struct' }>): void {
    const errors: TcDiagnostic[] = [];
    if (this.structs.some((item) => item.name === statement.name)) {
      errors.push(
        this.report(
          'tc_redeclared',
          `struct ${statement.name} is already declared.`,
          'Use a different name.',
          statement,
        ),
      );
    }
    // Entered before the fields are read, so a field can be a pointer to the struct itself.
    const known = this.structs.length;
    this.structs.push({ name: statement.name, type: { kind: 'record', fields: [] } });
    const fields: { name: string; type: TypeExpr }[] = [];
    for (const field of statement.fields) {
      const usesItselfByValue = (type: TypeExpr): boolean =>
        (type.kind === 'named' && type.name === statement.name) ||
        (type.kind === 'array' && usesItselfByValue(type.element));
      if (fields.some((item) => item.name === field.name)) {
        errors.push(
          this.report(
            'tc_redeclared',
            `The field ${field.name} appears twice.`,
            'Give each field its own name.',
            field,
          ),
        );
        continue;
      }
      if (usesItselfByValue(field.type)) {
        errors.push(
          this.report(
            'tc_infinite_struct',
            `struct ${statement.name} cannot contain itself, because it would have no finite size.`,
            `Use a pointer: struct ${statement.name} *${field.name};`,
            field,
          ),
        );
        fields.push({ name: field.name, type: TYPE_ERROR });
        continue;
      }
      const checked = this.checkDeclaredType(field.type, field, field.name);
      if (checked.error) errors.push(checked.error);
      fields.push({ name: field.name, type: checked.type });
    }
    const type: TypeExpr = { kind: 'record', fields };
    this.structs[known] = { name: statement.name, type };
    this.step(
      `struct ${statement.name}`,
      errors[0]
        ? (errors[0] as TcDiagnostic).message
        : `struct ${statement.name} names the type ${typeExprFormat(type)}. Structs use name equivalence, so another struct with the same fields is still a different type.`,
      statement,
      type,
      'struct id { fields } : id names a record type',
      [],
      errors,
    );
  }

  // ------ Expressions ------

  private expr(expr: TcExpr): TypeExpr {
    const type = this.exprInner(expr);
    this.nodeTypes.push({ node: expr.id, type: typeExprFormat(type) });
    return type;
  }

  private exprInner(expr: TcExpr): TypeExpr {
    switch (expr.kind) {
      case 'int':
        this.step(
          `Literal ${expr.value}`,
          `${expr.value} is a whole number, so it has type int.`,
          expr,
          TYPE_INT,
          'num : int',
        );
        return TYPE_INT;
      case 'float':
        this.step(
          `Literal ${expr.value}`,
          `${expr.value} has a decimal point, so it has type float.`,
          expr,
          TYPE_FLOAT,
          'num.num : float',
        );
        return TYPE_FLOAT;
      case 'char':
        this.step(
          `Literal ${this.textOf(expr)}`,
          'A character constant has type char.',
          expr,
          TYPE_CHAR,
          "'c' : char",
        );
        return TYPE_CHAR;
      case 'bool':
        this.step(
          `Literal ${expr.value}`,
          `${expr.value} has type bool.`,
          expr,
          TYPE_BOOL,
          'true, false : bool',
        );
        return TYPE_BOOL;
      case 'name':
        return this.nameExpr(expr);
      case 'unary':
        return this.unary(expr);
      case 'binary':
        return this.binary(expr);
      case 'index':
        return this.indexExpr(expr);
      case 'field':
        return this.fieldExpr(expr);
      case 'call':
        return this.call(expr);
    }
  }

  private fail(
    expr: TcExpr,
    title: string,
    rule: string,
    code: string,
    message: string,
    hint: string,
  ): TypeExpr {
    const error = this.report(code, message, hint, expr);
    this.step(title, message, expr, TYPE_ERROR, rule, [], [error]);
    return TYPE_ERROR;
  }

  private nameExpr(expr: Extract<TcExpr, { kind: 'name' }>): TypeExpr {
    const rule = 'Γ(id) = t, so id : t';
    const symbol = this.lookup(expr.name);
    if (!symbol) {
      if (this.reportedUndeclared.has(expr.name)) {
        this.step(
          `Name ${expr.name}`,
          `${expr.name} is still not declared. It was reported the first time, so it is not reported again.`,
          expr,
          TYPE_ERROR,
          rule,
        );
        return TYPE_ERROR;
      }
      this.reportedUndeclared.add(expr.name);
      return this.fail(
        expr,
        `Name ${expr.name}`,
        rule,
        'tc_undeclared',
        `${expr.name} is not declared in any open scope.`,
        `Declare ${expr.name} before this line, or check the spelling.`,
      );
    }
    const level = [...this.scopes].reverse().find((scope) => scope.symbols.has(expr.name))?.level;
    this.step(
      `Name ${expr.name}`,
      `The nearest declaration of ${expr.name}, at level ${level}, gives it type ${typeExprFormat(symbol.type)}.`,
      expr,
      symbol.type,
      rule,
    );
    return symbol.type;
  }

  private unary(expr: Extract<TcExpr, { kind: 'unary' }>): TypeExpr {
    const arg = this.expr(expr.arg);
    const title = `Operator ${expr.op}`;
    const silent = (rule: string): TypeExpr => {
      this.step(
        title,
        'The operand already has an error, so this node stays an error with no new message.',
        expr,
        TYPE_ERROR,
        rule,
      );
      return TYPE_ERROR;
    };
    switch (expr.op) {
      case '-': {
        const rule = "- E : needs a numeric E, and has E's type";
        if (arg.kind === 'error') return silent(rule);
        if (!numericName(arg))
          return this.fail(
            expr,
            title,
            rule,
            'tc_bad_operand',
            `Unary - needs a number, but this has type ${typeExprFormat(arg)}.`,
            'Use a numeric value.',
          );
        this.step(
          title,
          `Negating a ${typeExprFormat(arg)} gives a ${typeExprFormat(arg)}.`,
          expr,
          arg,
          rule,
        );
        return arg;
      }
      case '!': {
        const rule = '! E : needs E : bool, and is bool';
        if (arg.kind === 'error') return silent(rule);
        if (!typeIsEquivalent(arg, TYPE_BOOL, 'name'))
          return this.fail(
            expr,
            title,
            rule,
            'tc_bad_operand',
            `! needs bool, but this has type ${typeExprFormat(arg)}.`,
            'Write a comparison, like x == 0.',
          );
        this.step(title, 'Not of a bool is a bool.', expr, TYPE_BOOL, rule);
        return TYPE_BOOL;
      }
      case '*': {
        const rule = '* E : needs E : pointer(t) or array(s, t), and has type t';
        if (arg.kind === 'error') return silent(rule);
        if (arg.kind === 'pointer') {
          this.step(
            title,
            `Following a ${typeExprFormat(arg)} gives a ${typeExprFormat(arg.target)}.`,
            expr,
            arg.target,
            rule,
          );
          return arg.target;
        }
        if (arg.kind === 'array') {
          this.step(
            title,
            `An array acts as a pointer to its first element, so this gives a ${typeExprFormat(arg.element)}.`,
            expr,
            arg.element,
            rule,
          );
          return arg.element;
        }
        return this.fail(
          expr,
          title,
          rule,
          'tc_bad_operand',
          `* needs a pointer, but this has type ${typeExprFormat(arg)}.`,
          'Only pointers can be followed.',
        );
      }
      case '&': {
        const rule = '& E : needs E to be a place in memory, and has type pointer(t)';
        if (arg.kind === 'error') return silent(rule);
        const inner = expr.arg;
        const place =
          inner.kind === 'name' ||
          inner.kind === 'index' ||
          inner.kind === 'field' ||
          (inner.kind === 'unary' && inner.op === '*');
        if (!place)
          return this.fail(
            expr,
            title,
            rule,
            'tc_bad_operand',
            `${this.textOf(inner)} has no address, because it is not a place in memory.`,
            'Take the address of a variable, an array element or a field.',
          );
        const type: TypeExpr = { kind: 'pointer', target: arg };
        this.step(
          title,
          `The address of a ${typeExprFormat(arg)} is a ${typeExprFormat(type)}.`,
          expr,
          type,
          rule,
        );
        return type;
      }
    }
  }

  private binary(expr: Extract<TcExpr, { kind: 'binary' }>): TypeExpr {
    const left = this.expr(expr.left);
    const right = this.expr(expr.right);
    const { op } = expr;
    const title = `Operator ${op}`;
    const logical = op === '&&' || op === '||';
    const comparison = op === '<' || op === '<=' || op === '>' || op === '>=';
    const equality = op === '==' || op === '!=';
    const rule = logical
      ? `E1 ${op} E2 : needs both bool, and is bool`
      : comparison
        ? `E1 ${op} E2 : needs both numeric, widens to max(t1, t2), and is bool`
        : equality
          ? `E1 ${op} E2 : needs the same type after widening, and is bool`
          : op === '%'
            ? 'E1 % E2 : needs both whole numbers, and has type max(t1, t2)'
            : `E1 ${op} E2 : needs both numeric, and has type max(t1, t2)`;

    if (left.kind === 'error' || right.kind === 'error') {
      const type = logical || comparison || equality ? TYPE_BOOL : TYPE_ERROR;
      this.step(
        title,
        'An operand already has an error, so there is no new message here.',
        expr,
        type,
        rule,
      );
      return type;
    }

    if (logical) {
      const leftOk = typeIsEquivalent(left, TYPE_BOOL, 'name');
      const rightOk = typeIsEquivalent(right, TYPE_BOOL, 'name');
      if (!leftOk || !rightOk) {
        const bad = leftOk ? right : left;
        return this.fail(
          expr,
          title,
          rule,
          'tc_bad_operand',
          `${op} needs bool on both sides, but one side has type ${typeExprFormat(bad)}.`,
          'Write a comparison, like x != 0.',
        );
      }
      this.step(
        title,
        `Both sides are bool, so ${this.textOf(expr)} is bool.`,
        expr,
        TYPE_BOOL,
        rule,
      );
      return TYPE_BOOL;
    }

    const leftName = numericName(left);
    const rightName = numericName(right);
    if (leftName && rightName) {
      if (op === '%' && (!isIntegral(left) || !isIntegral(right))) {
        return this.fail(
          expr,
          title,
          rule,
          'tc_bad_operand',
          `% needs whole numbers, but this has types ${leftName} and ${rightName}.`,
          'Use int values, or use /.',
        );
      }
      const widest = typeMaxOf(leftName, rightName) as string;
      const widestType: TypeExpr = { kind: 'basic', name: widest };
      const coercions: TcCoercion[] = [];
      if (leftName !== widest)
        coercions.push(this.insertConversion(expr.left, left, widestType, 'left operand'));
      if (rightName !== widest)
        coercions.push(this.insertConversion(expr.right, right, widestType, 'right operand'));
      const resultType = comparison || equality ? TYPE_BOOL : widestType;
      const inserted = coercions.map((item) => item.conversion).join(' and ');
      this.step(
        title,
        `The operands have types ${leftName} and ${rightName}, and max(${leftName}, ${rightName}) = ${widest}.${inserted ? ` The compiler inserts ${inserted}.` : ''} The result has type ${typeExprFormat(resultType)}.`,
        expr,
        resultType,
        rule,
        coercions,
      );
      return resultType;
    }

    if (equality && typeIsEquivalent(left, right, 'name', this.structs)) {
      this.step(
        title,
        `Both sides have type ${typeExprFormat(left)}, so they can be compared, and the result is bool.`,
        expr,
        TYPE_BOOL,
        rule,
      );
      return TYPE_BOOL;
    }
    const message =
      comparison || !equality
        ? `${op} needs numbers, but the operands have types ${typeExprFormat(left)} and ${typeExprFormat(right)}.`
        : `${typeExprFormat(left)} and ${typeExprFormat(right)} cannot be compared with ${op}.`;
    return this.fail(
      expr,
      title,
      rule,
      'tc_bad_operand',
      message,
      'Check that both sides are the types you expect.',
    );
  }

  private indexExpr(expr: Extract<TcExpr, { kind: 'index' }>): TypeExpr {
    const base = this.expr(expr.base);
    const index = this.expr(expr.index);
    const title = 'Array element';
    const rule = 'E1[E2] : needs E1 : array(s, t) or pointer(t) and E2 whole, and has type t';
    const coercions: TcCoercion[] = [];
    if (index.kind !== 'error') {
      if (!isIntegral(index)) {
        const hint = 'Array positions are whole numbers.';
        const message = `An array index must be a whole number, but this has type ${typeExprFormat(index)}.`;
        const error = this.report('tc_bad_index', message, hint, expr.index);
        const element =
          base.kind === 'array' ? base.element : base.kind === 'pointer' ? base.target : TYPE_ERROR;
        this.step(title, message, expr, element, rule, [], [error]);
        return element;
      }
      const name = numericName(index) as string;
      if (name !== 'int' && typeConversionKind(name, 'int') === 'widening') {
        coercions.push(this.insertConversion(expr.index, index, TYPE_INT, 'array index'));
      }
    }
    if (base.kind === 'error') {
      this.step(
        title,
        'The array already has an error, so there is no new message here.',
        expr,
        TYPE_ERROR,
        rule,
        coercions,
      );
      return TYPE_ERROR;
    }
    if (base.kind !== 'array' && base.kind !== 'pointer') {
      return this.fail(
        expr,
        title,
        rule,
        'tc_not_array',
        `${this.textOf(expr.base)} has type ${typeExprFormat(base)}, so it cannot be indexed.`,
        'Only arrays and pointers can be indexed.',
      );
    }
    const element = base.kind === 'array' ? base.element : base.target;
    this.step(
      title,
      `Indexing a ${typeExprFormat(base)} gives a ${typeExprFormat(element)}.`,
      expr,
      element,
      rule,
      coercions,
    );
    return element;
  }

  private fieldExpr(expr: Extract<TcExpr, { kind: 'field' }>): TypeExpr {
    const base = this.expr(expr.base);
    const title = `Field ${expr.field}`;
    const rule = 'E.f : needs E : record with a field f : t, and has type t';
    if (base.kind === 'error') {
      this.step(
        title,
        'The record already has an error, so there is no new message here.',
        expr,
        TYPE_ERROR,
        rule,
      );
      return TYPE_ERROR;
    }
    const record = this.structOf(base);
    if (!record || record.kind !== 'record') {
      return this.fail(
        expr,
        title,
        rule,
        'tc_not_record',
        `${this.textOf(expr.base)} has type ${typeExprFormat(base)}, which has no fields.`,
        'Only structs have fields.',
      );
    }
    const field = record.fields.find((item) => item.name === expr.field);
    if (!field) {
      return this.fail(
        expr,
        title,
        rule,
        'tc_no_field',
        `${typeExprFormat(base)} has no field named ${expr.field}.`,
        `Its fields are: ${record.fields.map((item) => item.name).join(', ') || 'none'}.`,
      );
    }
    this.step(
      title,
      `${expr.field} is a field of ${typeExprFormat(base)}, with type ${typeExprFormat(field.type)}.`,
      expr,
      field.type,
      rule,
    );
    return field.type;
  }

  private call(expr: Extract<TcExpr, { kind: 'call' }>): TypeExpr {
    const argTypes = expr.args.map((arg) => this.expr(arg));
    const title = `Call ${expr.callee}`;
    const rule =
      'f(E1, ..., En) : needs f : t1 × ... × tn → t and each Ei to widen to ti, and has type t';
    const symbol = this.lookup(expr.callee);
    if (!symbol) {
      if (this.reportedUndeclared.has(expr.callee)) {
        this.step(
          title,
          `${expr.callee} is still not declared. It was reported the first time, so it is not reported again.`,
          expr,
          TYPE_ERROR,
          rule,
        );
        return TYPE_ERROR;
      }
      this.reportedUndeclared.add(expr.callee);
      return this.fail(
        expr,
        title,
        rule,
        'tc_undeclared',
        `The function ${expr.callee} is not declared.`,
        `Declare ${expr.callee} before calling it.`,
      );
    }
    if (symbol.type.kind === 'error') {
      this.step(
        title,
        'This name already has an error, so there is no new message here.',
        expr,
        TYPE_ERROR,
        rule,
      );
      return TYPE_ERROR;
    }
    if (symbol.type.kind !== 'function') {
      return this.fail(
        expr,
        title,
        rule,
        'tc_not_function',
        `${expr.callee} has type ${typeExprFormat(symbol.type)}, so it cannot be called.`,
        'Only functions can be called.',
      );
    }
    const { params, result } = symbol.type;
    if (params.length !== expr.args.length) {
      const error = this.report(
        'tc_wrong_argument_count',
        `${expr.callee} takes ${params.length} argument${params.length === 1 ? '' : 's'}, but this call passes ${expr.args.length}.`,
        `Its type is ${typeExprFormat(symbol.type)}.`,
        expr,
      );
      this.step(title, error.message, expr, result, rule, [], [error]);
      return result;
    }
    const coercions: TcCoercion[] = [];
    const errors: TcDiagnostic[] = [];
    expr.args.forEach((arg, index) => {
      const converted = this.convertTo(
        arg,
        argTypes[index] as TypeExpr,
        params[index] as TypeExpr,
        `argument ${index + 1}`,
      );
      coercions.push(...converted.coercions);
      if (converted.problem)
        errors.push(
          this.report(
            converted.problem.code,
            converted.problem.message,
            converted.problem.hint,
            arg,
          ),
        );
    });
    const inserted = coercions.map((item) => item.conversion).join(' and ');
    this.step(
      title,
      errors[0]
        ? (errors[0] as TcDiagnostic).message
        : `${expr.callee} has type ${typeExprFormat(symbol.type)}, and the arguments fit.${inserted ? ` The compiler inserts ${inserted}.` : ''} The call has type ${typeExprFormat(result)}.`,
      expr,
      result,
      rule,
      coercions,
      errors,
    );
    return result;
  }
}

/** Parses and checks a program in the mini-language, with one step per node. */
export function tcCheck(source: string): TcResult {
  return new TypeChecker(tcParse(source)).run();
}
