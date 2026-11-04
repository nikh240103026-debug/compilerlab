import { TraceRecorder, type Trace } from '../core/trace';
import { typeExprFormat, type TypeEnv, type TypeExpr } from './type-expr';

// How types relate: when two types count as the same (section 6.3.2), and when a value of one
// type may be used as another by inserting a conversion (section 6.5.2).

export type TypeEquivalenceMode = 'structural' | 'name';

export interface TypeEquivalenceState {
  mode: TypeEquivalenceMode;
  /** How deep this comparison is inside the types being compared. */
  depth: number;
  left: string;
  right: string;
  /** The rule this step used. */
  rule: string;
  /** null while the parts of a constructor are still being compared. */
  result: boolean | null;
}

export interface TypeEquivalenceResult {
  equivalent: boolean;
  mode: TypeEquivalenceMode;
  trace: Trace<TypeEquivalenceState>;
}

interface CompareContext {
  mode: TypeEquivalenceMode;
  env: TypeEnv;
  assumed: Set<string>;
  record: ((state: Omit<TypeEquivalenceState, 'mode'>, explanation: string) => void) | null;
}

function compareTypes(a: TypeExpr, b: TypeExpr, depth: number, context: CompareContext): boolean {
  const left = typeExprFormat(a);
  const right = typeExprFormat(b);
  const finish = (rule: string, result: boolean, explanation: string): boolean => {
    context.record?.({ depth, left, right, rule, result }, explanation);
    return result;
  };
  const parts = (rule: string, explanation: string): void => {
    context.record?.({ depth, left, right, rule, result: null }, explanation);
  };

  if (a.kind === 'error' || b.kind === 'error') {
    return finish(
      'error type',
      true,
      'One side is already an error, so it matches anything. This stops one mistake from causing more messages.',
    );
  }
  if (a.kind === 'named' && b.kind === 'named' && a.name === b.name) {
    return finish(
      'same name',
      true,
      `Both are the name ${a.name}, so they are equivalent under either rule.`,
    );
  }
  if (a.kind === 'named' || b.kind === 'named') {
    if (context.mode === 'name') {
      return finish(
        'name equivalence',
        false,
        `Under name equivalence a name equals only itself, so ${left} and ${right} differ, even if they stand for the same structure.`,
      );
    }
    // Recursive types can bring the same pair back. If it comes back, it is assumed equal, and
    // any real difference shows up in a part still being compared.
    const key = `${left}≡${right}`;
    if (context.assumed.has(key)) {
      return finish(
        'already being compared',
        true,
        `The pair ${left} and ${right} is already being compared higher up, so a recursive type has come back around. It is assumed equal here.`,
      );
    }
    context.assumed.add(key);
    const expand = (type: TypeExpr): TypeExpr | null => {
      if (type.kind !== 'named') return type;
      return context.env.find((item) => item.name === type.name)?.type ?? null;
    };
    const leftType = expand(a);
    const rightType = expand(b);
    if (!leftType || !rightType) {
      const unknown = !leftType ? left : right;
      return finish(
        'unknown name',
        false,
        `${unknown} has no declaration, so it cannot be expanded and matches nothing else.`,
      );
    }
    parts(
      'expand the name',
      `Under structural equivalence a name stands for its definition, so compare ${typeExprFormat(leftType)} with ${typeExprFormat(rightType)}.`,
    );
    const result = compareTypes(leftType, rightType, depth + 1, context);
    return finish(
      'expand the name',
      result,
      result ? 'The definitions match, so these are equivalent.' : 'The definitions differ.',
    );
  }
  if (a.kind === 'basic' && b.kind === 'basic') {
    const same = a.name === b.name;
    return finish(
      'basic types',
      same,
      same
        ? `Both are the basic type ${a.name}.`
        : `${a.name} and ${b.name} are different basic types.`,
    );
  }
  if (a.kind === 'variable' && b.kind === 'variable') {
    const same = a.name === b.name;
    return finish(
      'type variables',
      same,
      same
        ? `Both are the variable ${a.name}.`
        : `${a.name} and ${b.name} are different variables.`,
    );
  }
  if (a.kind === 'array' && b.kind === 'array') {
    if (a.size !== b.size) {
      return finish(
        'array',
        false,
        `The sizes differ (${a.size ?? 'none'} and ${b.size ?? 'none'}), so these are different array types.`,
      );
    }
    parts('array', 'The sizes match, so compare the element types.');
    const result = compareTypes(a.element, b.element, depth + 1, context);
    return finish(
      'array',
      result,
      result ? 'Same size and equivalent elements.' : 'The element types differ.',
    );
  }
  if (a.kind === 'pointer' && b.kind === 'pointer') {
    parts('pointer', 'Both are pointers, so compare what they point to.');
    const result = compareTypes(a.target, b.target, depth + 1, context);
    return finish(
      'pointer',
      result,
      result ? 'They point to equivalent types.' : 'They point to different types.',
    );
  }
  if (a.kind === 'function' && b.kind === 'function') {
    if (a.params.length !== b.params.length) {
      return finish(
        'function',
        false,
        `One takes ${a.params.length} parameters and the other ${b.params.length}.`,
      );
    }
    parts('function', 'Same number of parameters, so compare each parameter, then the results.');
    const pairs = a.params.map((param, index) => [param, b.params[index] as TypeExpr] as const);
    const result =
      pairs.every(([x, y]) => compareTypes(x, y, depth + 1, context)) &&
      compareTypes(a.result, b.result, depth + 1, context);
    return finish(
      'function',
      result,
      result ? 'All parameters and the result match.' : 'A parameter or the result differs.',
    );
  }
  if (a.kind === 'record' && b.kind === 'record') {
    if (
      a.fields.length !== b.fields.length ||
      a.fields.some((field, i) => field.name !== b.fields[i]?.name)
    ) {
      return finish(
        'record',
        false,
        'The records do not have the same field names in the same order.',
      );
    }
    parts('record', 'Same field names in the same order, so compare the field types.');
    const result = a.fields.every((field, i) =>
      compareTypes(field.type, (b.fields[i] as { type: TypeExpr }).type, depth + 1, context),
    );
    return finish('record', result, result ? 'All fields match.' : 'A field type differs.');
  }
  if (a.kind === 'constructed' && b.kind === 'constructed') {
    if (a.name !== b.name || a.args.length !== b.args.length) {
      return finish('constructor', false, `${a.name} and ${b.name} are different constructors.`);
    }
    parts('constructor', `Both use the constructor ${a.name}, so compare the arguments.`);
    const result = a.args.every((arg, i) =>
      compareTypes(arg, b.args[i] as TypeExpr, depth + 1, context),
    );
    return finish('constructor', result, result ? 'All arguments match.' : 'An argument differs.');
  }
  return finish(
    'different constructors',
    false,
    `${left} and ${right} are built by different constructors, so they cannot be equivalent.`,
  );
}

/** Compares two types, with one step per comparison. */
export function typeEquivalent(
  left: TypeExpr,
  right: TypeExpr,
  mode: TypeEquivalenceMode,
  env: TypeEnv = [],
): TypeEquivalenceResult {
  const recorder = new TraceRecorder<TypeEquivalenceState>();
  const equivalent = compareTypes(left, right, 0, {
    mode,
    env,
    assumed: new Set(),
    record: (state, explanation) => {
      const title = `${state.left} ≡ ${state.right}?`;
      recorder.add(title, explanation, { ...state, mode });
    },
  });
  return { equivalent, mode, trace: recorder.finish() };
}

/** The same check with no trace, for code that only needs the answer. */
export function typeIsEquivalent(
  left: TypeExpr,
  right: TypeExpr,
  mode: TypeEquivalenceMode,
  env: TypeEnv = [],
): boolean {
  return compareTypes(left, right, 0, { mode, env, assumed: new Set(), record: null });
}

/**
 * The widening hierarchy of figure 6.25(a). Each pair says a value of the first type can become
 * the second with no loss the language worries about.
 */
export const TYPE_WIDENING_EDGES: readonly (readonly [string, string])[] = [
  ['byte', 'short'],
  ['short', 'int'],
  ['char', 'int'],
  ['int', 'long'],
  ['long', 'float'],
  ['float', 'double'],
];

export const TYPE_NUMERIC_NAMES: readonly string[] = [
  'byte',
  'short',
  'char',
  'int',
  'long',
  'float',
  'double',
];

export type TypeConversionKind = 'same' | 'widening' | 'narrowing' | 'none';

/** The chain of widenings from one type to another, including both ends, or null if none exists. */
export function typeWideningPath(from: string, to: string): string[] | null {
  if (!TYPE_NUMERIC_NAMES.includes(from) || !TYPE_NUMERIC_NAMES.includes(to)) return null;
  const path = [from];
  while (path.at(-1) !== to) {
    const next = TYPE_WIDENING_EDGES.find(([start]) => start === path.at(-1))?.[1];
    if (!next) return null;
    path.push(next);
  }
  return path;
}

/** The book's max(t1, t2): the lowest type both can widen to, or null if there is none. */
export function typeMaxOf(left: string, right: string): string | null {
  const leftPath = typeWideningPath(left, 'double');
  const rightPath = typeWideningPath(right, 'double');
  if (!leftPath || !rightPath) return null;
  return leftPath.find((name) => rightPath.includes(name)) ?? null;
}

/**
 * What converting one basic type to another means. Numeric types that do not widen in this
 * direction narrow, which needs an explicit cast. Anything involving bool or void has no conversion.
 */
export function typeConversionKind(from: string, to: string): TypeConversionKind {
  if (from === to) return 'same';
  if (!TYPE_NUMERIC_NAMES.includes(from) || !TYPE_NUMERIC_NAMES.includes(to)) return 'none';
  return typeWideningPath(from, to) ? 'widening' : 'narrowing';
}

export interface TypeCoercionRow {
  from: string;
  to: string;
  kind: TypeConversionKind;
  /** The steps of a widening, like char → int → long. Empty otherwise. */
  path: string[];
}

/** Every pair of numeric types, for a coercion table. */
export function typeCoercionTable(): TypeCoercionRow[] {
  return TYPE_NUMERIC_NAMES.flatMap((from) =>
    TYPE_NUMERIC_NAMES.map((to) => ({
      from,
      to,
      kind: typeConversionKind(from, to),
      path: from === to ? [] : (typeWideningPath(from, to) ?? []),
    })),
  );
}
