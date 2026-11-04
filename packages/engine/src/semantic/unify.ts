import { EngineError } from '../core/result';
import { typeExprFormat, type TypeExpr } from './type-expr';

// Unification over type expressions, as in section 6.5.5: find a substitution that makes two types
// equal. Bindings stay in one table, and looking a variable up follows the chain, which is the same
// idea as the book's union-find over type nodes.

const MAX_RESOLVED_NODES = 20_000;

export type TypeUnifyAction = 'same' | 'bind' | 'decompose' | 'fail';

export interface TypeUnifyStep {
  left: string;
  right: string;
  action: TypeUnifyAction;
  /** A sentence saying what happened. */
  detail: string;
}

export interface TypeBinding {
  variable: string;
  type: string;
}

export interface TypeUnifyResult {
  ok: boolean;
  steps: TypeUnifyStep[];
  /** The final substitution, with variables replaced all the way through. */
  bindings: TypeBinding[];
  /** The type both sides became, when it worked. */
  unified: string | null;
  /** Why it failed, when it did. */
  error: string | null;
}

const TOO_LARGE_HINT =
  'Types can grow very fast when they repeat each other. Try a smaller example.';

/** Holds the substitution. Not exported from the package: results carry plain data instead. */
export class TypeUnifier {
  private readonly table = new Map<string, TypeExpr>();
  steps: TypeUnifyStep[] = [];
  /** The sentence for the last failure. */
  failure: string | null = null;

  /** Follows variable bindings at the top of a type only. */
  private walk(type: TypeExpr): TypeExpr {
    let current = type;
    while (current.kind === 'variable') {
      const bound = this.table.get(current.name);
      if (!bound) return current;
      current = bound;
    }
    return current;
  }

  /** Replaces every bound variable in a type. The budget stops types that double in size. */
  resolve(type: TypeExpr): TypeExpr {
    let budget = MAX_RESOLVED_NODES;
    const go = (current: TypeExpr): TypeExpr => {
      if (--budget < 0) {
        throw new EngineError({
          code: 'type_too_large',
          message: 'A type here grew too large to show.',
          hint: TOO_LARGE_HINT,
        });
      }
      const walked = this.walk(current);
      switch (walked.kind) {
        case 'array':
          return { ...walked, element: go(walked.element) };
        case 'pointer':
          return { ...walked, target: go(walked.target) };
        case 'function':
          return { kind: 'function', params: walked.params.map(go), result: go(walked.result) };
        case 'record':
          return {
            kind: 'record',
            fields: walked.fields.map((field) => ({ name: field.name, type: go(field.type) })),
          };
        case 'constructed':
          return { kind: 'constructed', name: walked.name, args: walked.args.map(go) };
        default:
          return walked;
      }
    };
    return go(type);
  }

  format(type: TypeExpr): string {
    return typeExprFormat(this.resolve(type));
  }

  private occurs(name: string, type: TypeExpr): boolean {
    let budget = MAX_RESOLVED_NODES;
    const go = (current: TypeExpr): boolean => {
      if (--budget < 0) {
        throw new EngineError({
          code: 'type_too_large',
          message: 'A type here grew too large to check.',
          hint: TOO_LARGE_HINT,
        });
      }
      const walked = this.walk(current);
      switch (walked.kind) {
        case 'variable':
          return walked.name === name;
        case 'array':
          return go(walked.element);
        case 'pointer':
          return go(walked.target);
        case 'function':
          return walked.params.some(go) || go(walked.result);
        case 'record':
          return walked.fields.some((field) => go(field.type));
        case 'constructed':
          return walked.args.some(go);
        default:
          return false;
      }
    };
    return go(type);
  }

  private add(left: TypeExpr, right: TypeExpr, action: TypeUnifyAction, detail: string): void {
    this.steps.push({ left: this.format(left), right: this.format(right), action, detail });
  }

  private fail(left: TypeExpr, right: TypeExpr, detail: string): boolean {
    this.failure = detail;
    this.add(left, right, 'fail', detail);
    return false;
  }

  private bind(name: string, variable: TypeExpr, type: TypeExpr): boolean {
    if (this.occurs(name, type)) {
      return this.fail(
        variable,
        type,
        `${name} cannot equal ${this.format(type)}, because ${name} appears inside it. That would make an infinite type. This check is called the occurs check.`,
      );
    }
    const shown = this.format(type);
    this.table.set(name, type);
    this.steps.push({
      left: name,
      right: shown,
      action: 'bind',
      detail: `${name} now stands for ${shown}.`,
    });
    return true;
  }

  /** Makes two types equal, or returns false with the reason in `failure`. */
  unify(a: TypeExpr, b: TypeExpr): boolean {
    const left = this.walk(a);
    const right = this.walk(b);
    if (left.kind === 'variable' && right.kind === 'variable' && left.name === right.name) {
      this.add(left, right, 'same', `Both sides are already ${left.name}.`);
      return true;
    }
    if (left.kind === 'variable') return this.bind(left.name, left, right);
    if (right.kind === 'variable') return this.bind(right.name, right, left);

    const mismatch = (): boolean =>
      this.fail(
        left,
        right,
        `${this.format(left)} and ${this.format(right)} can never be equal, because they are built differently.`,
      );

    switch (left.kind) {
      case 'basic':
      case 'named':
        if (
          (right.kind !== 'basic' && right.kind !== 'named') ||
          right.kind !== left.kind ||
          right.name !== left.name
        ) {
          return mismatch();
        }
        this.add(left, right, 'same', `Both sides are ${left.name}.`);
        return true;
      case 'error':
        this.add(left, right, 'same', 'An error type matches anything.');
        return true;
      case 'array':
        if (right.kind !== 'array' || right.size !== left.size) return mismatch();
        this.add(
          left,
          right,
          'decompose',
          'Both are arrays of the same size, so unify their elements.',
        );
        return this.unify(left.element, right.element);
      case 'pointer':
        if (right.kind !== 'pointer') return mismatch();
        this.add(left, right, 'decompose', 'Both are pointers, so unify what they point to.');
        return this.unify(left.target, right.target);
      case 'function': {
        if (right.kind !== 'function' || right.params.length !== left.params.length)
          return mismatch();
        this.add(
          left,
          right,
          'decompose',
          'Both are functions with the same number of parameters, so unify the parameters and results, in pairs.',
        );
        const params = left.params.every((param, index) =>
          this.unify(param, right.params[index] as TypeExpr),
        );
        return params && this.unify(left.result, right.result);
      }
      case 'record': {
        if (
          right.kind !== 'record' ||
          right.fields.length !== left.fields.length ||
          left.fields.some((field, i) => field.name !== right.fields[i]?.name)
        ) {
          return mismatch();
        }
        this.add(
          left,
          right,
          'decompose',
          'Both records have the same fields, so unify each field type.',
        );
        return left.fields.every((field, i) =>
          this.unify(field.type, (right.fields[i] as { type: TypeExpr }).type),
        );
      }
      case 'constructed':
        if (
          right.kind !== 'constructed' ||
          right.name !== left.name ||
          right.args.length !== left.args.length
        )
          return mismatch();
        this.add(
          left,
          right,
          'decompose',
          `Both use the constructor ${left.name}, so unify the arguments.`,
        );
        return left.args.every((arg, index) => this.unify(arg, right.args[index] as TypeExpr));
    }
  }

  /** The substitution now, as plain data. */
  bindings(): TypeBinding[] {
    return [...this.table.keys()].map((variable) => ({
      variable,
      type: this.format({ kind: 'variable', name: variable }),
    }));
  }

  /** Hands over the steps since the last call. */
  takeSteps(): TypeUnifyStep[] {
    const steps = this.steps;
    this.steps = [];
    return steps;
  }
}

/** Unifies two type expressions, listing each step. A failed unification is a normal result. */
export function typeUnify(left: TypeExpr, right: TypeExpr): TypeUnifyResult {
  const unifier = new TypeUnifier();
  const ok = unifier.unify(left, right);
  return {
    ok,
    steps: unifier.takeSteps(),
    bindings: unifier.bindings(),
    unified: ok ? unifier.format(left) : null,
    error: ok ? null : unifier.failure,
  };
}
