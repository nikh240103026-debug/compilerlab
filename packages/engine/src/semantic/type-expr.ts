import { EngineError } from '../core/result';

// Type expressions from section 6.3: basic types, and constructors applied to them.

export type TypeExpr =
  | { kind: 'basic'; name: string }
  /** A declared name that stands for another type, like Point or link. */
  | { kind: 'named'; name: string }
  /** size is null for an array whose length is not fixed, as in a parameter int a[]. */
  | { kind: 'array'; size: number | null; element: TypeExpr }
  | { kind: 'pointer'; target: TypeExpr }
  | { kind: 'function'; params: TypeExpr[]; result: TypeExpr }
  | { kind: 'record'; fields: { name: string; type: TypeExpr }[] }
  /** Any other constructor, like list(int) in type inference. */
  | { kind: 'constructed'; name: string; args: TypeExpr[] }
  /** A type variable, like α. */
  | { kind: 'variable'; name: string }
  /** Marks an expression already reported as wrong, so one mistake gives one message. */
  | { kind: 'error' };

export const TYPE_BASIC_NAMES: readonly string[] = [
  'bool',
  'byte',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'void',
];

export const TYPE_INT: TypeExpr = Object.freeze({ kind: 'basic', name: 'int' });
export const TYPE_FLOAT: TypeExpr = Object.freeze({ kind: 'basic', name: 'float' });
export const TYPE_CHAR: TypeExpr = Object.freeze({ kind: 'basic', name: 'char' });
export const TYPE_BOOL: TypeExpr = Object.freeze({ kind: 'basic', name: 'bool' });
export const TYPE_VOID: TypeExpr = Object.freeze({ kind: 'basic', name: 'void' });
export const TYPE_ERROR: TypeExpr = Object.freeze({ kind: 'error' });

/** Declared type names and what they stand for. */
export type TypeEnv = readonly { name: string; type: TypeExpr }[];

const MAX_TYPE_TEXT = 2000;
const MAX_TYPE_DEPTH = 64;

/** The book's widths, in bytes. Pointers here are 8. */
const BASIC_WIDTHS: Readonly<Record<string, number>> = {
  bool: 1,
  byte: 1,
  char: 1,
  short: 2,
  int: 4,
  long: 8,
  float: 8,
  double: 8,
  void: 0,
};
const POINTER_WIDTH = 8;

function formatParam(type: TypeExpr): string {
  return type.kind === 'function' ? `(${typeExprFormat(type)})` : typeExprFormat(type);
}

/** Prints a type the way the book does, like array(10, int) or int × float → bool. */
export function typeExprFormat(type: TypeExpr): string {
  switch (type.kind) {
    case 'basic':
    case 'named':
    case 'variable':
      return type.name;
    case 'array':
      return type.size === null
        ? `array(${typeExprFormat(type.element)})`
        : `array(${type.size}, ${typeExprFormat(type.element)})`;
    case 'pointer':
      return `pointer(${typeExprFormat(type.target)})`;
    case 'function': {
      const params = type.params.length > 0 ? type.params.map(formatParam).join(' × ') : 'void';
      return `${params} → ${typeExprFormat(type.result)}`;
    }
    case 'record':
      return `record{${type.fields.map((field) => `${field.name}: ${typeExprFormat(field.type)}`).join('; ')}}`;
    case 'constructed':
      return `${type.name}(${type.args.map(typeExprFormat).join(', ')})`;
    case 'error':
      return 'error';
  }
}

/** How many bytes a value of this type takes. Records add up their fields, with no padding. */
export function typeExprWidth(type: TypeExpr, env: TypeEnv = []): number {
  const width = (current: TypeExpr, seen: readonly string[]): number => {
    switch (current.kind) {
      case 'basic':
        return BASIC_WIDTHS[current.name] ?? 0;
      case 'named': {
        const declared = env.find((item) => item.name === current.name);
        if (!declared || seen.includes(current.name)) return 0;
        return width(declared.type, [...seen, current.name]);
      }
      case 'array':
        return current.size === null ? POINTER_WIDTH : current.size * width(current.element, seen);
      case 'pointer':
      case 'function':
        return POINTER_WIDTH;
      case 'record':
        return current.fields.reduce((sum, field) => sum + width(field.type, seen), 0);
      default:
        return 0;
    }
  };
  return width(type, []);
}

interface TypeToken {
  text: string;
  start: number;
  end: number;
}

const TYPE_TOKEN =
  /->|→|×|[(){},;:*]|[0-9]+|'[A-Za-z_][A-Za-z0-9_]*|[α-ω][0-9]*|[A-Za-z_][A-Za-z0-9_]*/y;

function typeError(message: string, position: number, length: number, hint: string): never {
  throw new EngineError({ code: 'type_bad_expression', message, hint, position, length });
}

function scanType(text: string): TypeToken[] {
  const tokens: TypeToken[] = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/.test(text[at] as string)) {
      at++;
      continue;
    }
    TYPE_TOKEN.lastIndex = at;
    const match = TYPE_TOKEN.exec(text);
    if (!match) {
      typeError(`"${text[at]}" cannot appear in a type.`, at, 1, TYPE_SYNTAX_HINT);
    }
    tokens.push({ text: match[0], start: at, end: at + match[0].length });
    at += match[0].length;
  }
  return tokens;
}

const TYPE_SYNTAX_HINT =
  'Types look like: int, array(10, int), pointer(float), int * int -> bool, record { x: int; y: float }, list(α).';

class TypeParser {
  private at = 0;
  private depth = 0;

  constructor(
    private readonly tokens: TypeToken[],
    private readonly length: number,
  ) {}

  private peek(): TypeToken | undefined {
    return this.tokens[this.at];
  }

  private eat(text: string): boolean {
    if (this.peek()?.text !== text) return false;
    this.at++;
    return true;
  }

  private expect(text: string): void {
    if (this.eat(text)) return;
    const token = this.peek();
    typeError(
      token
        ? `Expected ${text} here, not "${token.text}".`
        : `This type ends early. It needs ${text}.`,
      token ? token.start : this.length,
      token ? token.end - token.start : 0,
      TYPE_SYNTAX_HINT,
    );
  }

  private eatArrow(): boolean {
    return this.eat('->') || this.eat('→');
  }

  whole(): TypeExpr {
    const type = this.type();
    const extra = this.peek();
    if (extra) {
      typeError(
        `The type should have ended before "${extra.text}".`,
        extra.start,
        extra.end - extra.start,
        TYPE_SYNTAX_HINT,
      );
    }
    return type;
  }

  private type(): TypeExpr {
    if (++this.depth > MAX_TYPE_DEPTH) {
      typeError(
        'This type is nested too deeply.',
        this.peek()?.start ?? this.length,
        1,
        'Use a simpler type.',
      );
    }
    const parts = this.product();
    let result: TypeExpr;
    if (this.eatArrow()) {
      result = { kind: 'function', params: parts, result: this.type() };
    } else if (parts.length === 1) {
      result = parts[0] as TypeExpr;
    } else {
      typeError(
        'A product like int × int only makes sense before an arrow.',
        this.peek()?.start ?? this.length,
        1,
        'Finish it as a function type: int * int -> bool',
      );
    }
    this.depth--;
    return result;
  }

  private product(): TypeExpr[] {
    const parts = this.factor();
    while (this.eat('*') || this.eat('×')) parts.push(...this.factor());
    return parts;
  }

  /** A factor can be several parts, because (a × b) groups function parameters. */
  private factor(): TypeExpr[] {
    if (!this.eat('(')) return [this.atom()];
    if (this.eat(')')) return [];
    if (++this.depth > MAX_TYPE_DEPTH) {
      typeError(
        'This type is nested too deeply.',
        this.peek()?.start ?? this.length,
        1,
        'Use a simpler type.',
      );
    }
    let inner = this.product();
    if (this.eatArrow()) inner = [{ kind: 'function', params: inner, result: this.type() }];
    this.expect(')');
    this.depth--;
    return inner;
  }

  private atom(): TypeExpr {
    const token = this.peek();
    if (!token) {
      typeError('This type ends too early.', this.length, 0, TYPE_SYNTAX_HINT);
    }
    this.at++;
    const text = token.text;
    if (text.startsWith("'") || /^[α-ω]/.test(text)) return { kind: 'variable', name: text };
    if (!/^[A-Za-z_]/.test(text)) {
      typeError(
        `"${text}" cannot start a type.`,
        token.start,
        token.end - token.start,
        TYPE_SYNTAX_HINT,
      );
    }
    if (text === 'array') return this.arrayType();
    if (text === 'pointer') {
      this.expect('(');
      const target = this.type();
      this.expect(')');
      return { kind: 'pointer', target };
    }
    if (text === 'record') return this.recordType();
    if (TYPE_BASIC_NAMES.includes(text)) return { kind: 'basic', name: text };
    if (this.eat('(')) {
      const args = [this.type()];
      while (this.eat(',')) args.push(this.type());
      this.expect(')');
      return { kind: 'constructed', name: text, args };
    }
    return { kind: 'named', name: text };
  }

  private arrayType(): TypeExpr {
    this.expect('(');
    const size = this.peek();
    let length: number | null = null;
    if (size && /^[0-9]/.test(size.text)) {
      length = Number(size.text);
      this.at++;
      this.expect(',');
    }
    const element = this.type();
    this.expect(')');
    return { kind: 'array', size: length, element };
  }

  private recordType(): TypeExpr {
    this.expect('{');
    const fields: { name: string; type: TypeExpr }[] = [];
    while (!this.eat('}')) {
      const name = this.peek();
      if (!name || !/^[A-Za-z_]/.test(name.text)) {
        typeError(
          'A record field needs a name.',
          name?.start ?? this.length,
          1,
          'Write it like this: record { x: int; y: float }',
        );
      }
      this.at++;
      this.expect(':');
      fields.push({ name: name.text, type: this.type() });
      if (!this.eat(';') && !this.eat(',')) {
        this.expect('}');
        break;
      }
    }
    return { kind: 'record', fields };
  }
}

/** Reads a type written as text, like array(10, pointer(int)). */
export function typeExprParse(text: string): TypeExpr {
  if (text.length > MAX_TYPE_TEXT) {
    throw new EngineError({
      code: 'type_too_long',
      message: `This type is longer than ${MAX_TYPE_TEXT} characters.`,
      hint: 'Use a simpler type.',
    });
  }
  return new TypeParser(scanType(text), text.length).whole();
}

/**
 * Reads type declarations, one per line, for equivalence checks:
 *
 *   link = pointer(cell)
 *   cell = record { info: int; next: link }
 */
export function typeEnvParse(text: string): { name: string; type: TypeExpr }[] {
  const env: { name: string; type: TypeExpr }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
      if (!match) {
        throw new EngineError({
          code: 'type_bad_declaration',
          message: `"${trimmed}" is not a type declaration.`,
          hint: 'Write it like this: link = pointer(cell)',
          position: offset,
          length: line.length,
        });
      }
      const name = match[1] as string;
      if (env.some((item) => item.name === name)) {
        throw new EngineError({
          code: 'type_bad_declaration',
          message: `${name} is declared twice.`,
          hint: 'Give each type name one declaration.',
          position: offset,
          length: line.length,
        });
      }
      env.push({ name, type: typeExprParse(match[2] as string) });
    }
    offset += line.length + 1;
  }
  return env;
}
