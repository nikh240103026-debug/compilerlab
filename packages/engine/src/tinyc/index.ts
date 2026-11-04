/**
 * TinyC, the small language behind the capstone project.
 *
 * THE LANGUAGE
 *
 *   program    := function*
 *   function   := type name '(' params? ')' block
 *   type       := 'int' | 'bool' | 'void'
 *   params     := param (',' param)*
 *   param      := ('int' | 'bool') name ('[' ']')?
 *   block      := '{' statement* '}'
 *   statement  := block
 *               | ('int' | 'bool') name ('[' number ']' | '=' expr)? ';'
 *               | name ('[' expr ']')? '=' expr ';'
 *               | 'if' '(' expr ')' statement ('else' statement)?
 *               | 'while' '(' expr ')' statement
 *               | 'return' expr? ';'
 *               | 'print' '(' expr ')' ';'
 *               | name '(' args? ')' ';'
 *   expr       := the operators below, with C's precedence, and these primaries:
 *                 number | 'true' | 'false' | name | name '[' expr ']' | name '(' args? ')' | '(' expr ')'
 *   operators  := || && == != < <= > >= + - * / %   and the prefix operators - !
 *
 * Comments are // and /* *\/. Every program needs a main with no parameters.
 *
 * The rules, chosen to keep the compiler readable:
 * - int is 32 bits and wraps. bool is separate, and there is no conversion between them, so write
 *   x != 0 to test an int. A condition must be a bool.
 * - && and || short-circuit.
 * - Scalars are passed by value. Arrays are passed by reference: int f(int a[]).
 * - There are no global variables. A function works with its parameters and its locals.
 * - A scalar declared without a value starts at 0. Array cells are 0 when the function is entered.
 * - Local arrays are bounds-checked at run time. An array parameter is not, because its size belongs
 *   to the caller, and only the bounds of memory apply.
 * - A function with a return type must return on every path. print shows an int or a bool.
 *
 * A SAMPLE PROGRAM, with more in TINYC_SAMPLES, including factorial and fibonacci:
 *
 *   int factorial(int n) {
 *     if (n <= 1) {
 *       return 1;
 *     }
 *     return n * factorial(n - 1);
 *   }
 *
 *   int main() {
 *     print(factorial(5));   // prints 120
 *     return 0;
 *   }
 *
 * THE API. Every error is an EngineError with a position in the TinyC source.
 *
 * The whole pipeline at once:
 *
 *   compileTinyC(source, { optimize: true, toggles: { licm: false } })
 *   // { source, tokens, ast, astTree, semantic, ir, optimized, codegen, program }
 *
 *   runTinyC(source, { optimize: true, maxSteps: 1_000_000 })
 *   // { output: ['120'], steps, trace, traceTruncated, compiled }
 *
 *   tinycCompileStages(source)
 *   // Never throws on a bad program, so the capstone can show how far it got:
 *   // { stages: [{ id, label, status: 'ok' | 'failed' | 'not-reached' }], partial, error }
 *
 * Or one stage at a time, the eight stages of the capstone:
 *
 *   tinycLex(source)                 // 1 lexer: tokens with position, line, column
 *   tinycParse(tokens)               // 2 parser: the syntax tree
 *   tinycAstTree(ast)                // 3 AST: { label, type, children, position, length }, ready to draw
 *   tinycCheck(ast)                  // 4 semantic checks: { ast, functions, trace }
 *   tinycGenerateIr(checked)         // 5 IR: { functions: [{ name, params, arrays, instrs, spans, text }] }
 *   tinycOptimize(ir, { toggles })   // 6 optimizer: the same, plus each function's pipeline result
 *   tinycCodegen(irOrOptimized)      // 7 codegen: { assembly, functions, instructionMap }
 *   vmAssemble(codegen.assembly)     // 8 VM: then vmExecute, or tinycExecute(compiled) for positions
 *
 *   tinycExecute(compiled, { maxSteps }) // { output, steps, trace, traceTruncated, error }, never throws
 *                                        // for a runtime error, and error.position is in the TinyC source.
 *
 * VM-level traces are the VmSnapshot steps described in vm/index.ts.
 */
export {
  TINYC_KEYWORDS,
  TINYC_MAX_INT,
  TINYC_MAX_SOURCE_LENGTH,
  tinycLex,
  type TinyToken,
  type TinyTokenKind,
} from './lexer';
export type {
  TinyBaseType,
  TinyBinaryOp,
  TinyExpr,
  TinyFunction,
  TinyParam,
  TinyProgram,
  TinyReturnType,
  TinySpan,
  TinyStmt,
  TinyType,
} from './ast';
export {
  TINYC_MAX_ARRAY_SIZE,
  TINYC_MAX_EXPRESSION_NODES,
  TINYC_MAX_NESTING,
  tinycParse,
} from './parser';
export { tinycAstTree, type TinyAstNode } from './ast-view';
export {
  tinycCheck,
  type TinyFunctionInfo,
  type TinySemanticResult,
  type TinySemanticState,
  type TinySymbol,
} from './semantic';
export {
  TINYC_PRINT_BOOL,
  TINYC_PRINT_INT,
  tinycGenerateIr,
  type TinyIr,
  type TinyIrArray,
  type TinyIrFunction,
} from './ir';
export {
  tinycOptimize,
  type TinyOptimized,
  type TinyOptimizedFunction,
  type TinyOptimizeOptions,
} from './optimizer';
export {
  tinycCodegen,
  type TinyCodeFunction,
  type TinyCodegenResult,
  type TinyCodeRow,
} from './codegen';
export { TINYC_SAMPLES, tinycSample, type TinySample } from './samples';
export {
  TINYC_DEFAULT_MEMORY,
  TINYC_STAGES,
  compileTinyC,
  runTinyC,
  tinycCompileStages,
  tinycExecute,
  type TinyCompileOptions,
  type TinyCompileResult,
  type TinyExecution,
  type TinyRunOptions,
  type TinyRunResult,
  type TinyStageId,
  type TinyStageReport,
  type TinyStagesResult,
} from './pipeline';
