import { EngineError } from '../core/result';
import { typeExprFormat, typeExprWidth, type TypeExpr } from '../semantic/type-expr';
import type { IrIndexExpr, IrStmt } from './parser';

// Declarations and array layout, from sections 6.3.4 and 6.4.3. Each declaration gets an offset
// and a width, and an array reference needs the width of each level it steps through.

export interface IrSymbol {
  name: string;
  /** The element type, like int. */
  base: string;
  dims: number[];
  /** The whole type, like array(2, array(3, int)). */
  type: string;
  width: number;
  /** Where it sits, as the book's offset counter assigns it. */
  offset: number;
}

export interface IrArrayLayout {
  /** The width stepped over by each index: 12 and 4 for int a[2][3]. */
  widths: number[];
  /** The type after each index: array(3, int), then int. */
  types: string[];
  /** False when the array was never declared, so one dimension of int is assumed. */
  declared: boolean;
  /** Why each width has its value, in words. */
  notes: string[];
}

function typeOf(base: string, dims: readonly number[]): TypeExpr {
  return dims.reduceRight<TypeExpr>((element, size) => ({ kind: 'array', size, element }), {
    kind: 'basic',
    name: base,
  });
}

/** Adds a declaration at this offset, the way the book's rule for D does. */
export function irDeclareSymbol(
  symbols: Map<string, IrSymbol>,
  statement: Extract<IrStmt, { kind: 'decl' }>,
  offset: number,
): IrSymbol {
  if (symbols.has(statement.name)) {
    throw new EngineError({
      code: 'ir_redeclared',
      message: `${statement.name} is declared twice.`,
      hint: 'Each name has one declaration here, because this language has no nested scopes.',
      position: statement.start,
      length: statement.end - statement.start,
    });
  }
  const type = typeOf(statement.base, statement.dims);
  const symbol: IrSymbol = {
    name: statement.name,
    base: statement.base,
    dims: statement.dims,
    type: typeExprFormat(type),
    width: typeExprWidth(type),
    offset,
  };
  symbols.set(statement.name, symbol);
  return symbol;
}

/** Works out the widths for one array reference, and rejects a reference that does not fit. */
export function irArrayLayout(
  symbols: ReadonlyMap<string, IrSymbol>,
  reference: IrIndexExpr,
): IrArrayLayout {
  const symbol = symbols.get(reference.base);
  const count = reference.indices.length;
  const fail = (message: string, hint: string): never => {
    throw new EngineError({
      code: 'ir_bad_array',
      message,
      hint,
      position: reference.start,
      length: reference.end - reference.start,
    });
  };
  if (!symbol) {
    if (count > 1) {
      return fail(
        `${reference.base} is not declared, so its row widths are unknown.`,
        `Declare it first, like this: int ${reference.base}${reference.indices.map(() => '[10]').join('')};`,
      );
    }
    return {
      widths: [4],
      types: ['int'],
      declared: false,
      notes: [
        `${reference.base} is not declared, so this assumes an array of int, whose elements have width 4.`,
      ],
    };
  }
  if (symbol.dims.length === 0) {
    return fail(
      `${reference.base} is declared as ${symbol.type}, so it cannot be indexed.`,
      'Only arrays can be indexed.',
    );
  }
  if (symbol.dims.length !== count) {
    return fail(
      `${reference.base} has ${symbol.dims.length} dimension${symbol.dims.length === 1 ? '' : 's'}, but this reference has ${count} index${count === 1 ? '' : 'es'}.`,
      `Its type is ${symbol.type}, so write one index per dimension.`,
    );
  }
  const widths: number[] = [];
  const types: string[] = [];
  const notes: string[] = [];
  const elementWidth = typeExprWidth({ kind: 'basic', name: symbol.base });
  symbol.dims.forEach((_, level) => {
    const inner = symbol.dims.slice(level + 1);
    const type = typeOf(symbol.base, inner);
    const width = typeExprWidth(type);
    widths.push(width);
    types.push(typeExprFormat(type));
    notes.push(
      inner.length > 0
        ? `Index ${level + 1} steps over whole values of type ${typeExprFormat(type)}, each of width ${inner.join(' × ')} × ${elementWidth} = ${width}.`
        : `Index ${level + 1} steps over single ${symbol.base} values, each of width ${width}.`,
    );
  });
  return { widths, types, declared: true, notes };
}
