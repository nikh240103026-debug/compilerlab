/**
 * Code generation. Every trace step is plain JSON-safe data. Bad input throws an EngineError.
 *
 * THE TEACHING ISA, in isa.ts. ISA_REFERENCE lists every opcode with its format and meaning, and
 * isaInstructionCost('LD R1, x') gives the book's cost (2 here). All generated text runs on the VM.
 *
 * STACK MACHINE, from an expression.
 *
 *   codegenStackMachine('a + b * c')
 *   // { tree, code: ['PUSH a', 'PUSH b', 'PUSH c', 'MUL', 'ADD'], runnable, maxDepth, trace }
 *   // Trace state: { node, code, stack, maxDepth }. The stack is shown symbolically.
 *
 * INSTRUCTION SELECTION, from TAC, by templates.
 *
 *   codegenSelectInstructions('x = y + 1\nif x goto L\nL:')
 *   // { rows: [{ tacIndex, tac, rule, pattern, code, cost }], code, totalCost, trace }
 *   // Trace state: { tacIndex, row, code, totalCost }.
 *
 * NEXT-USE INFORMATION, by the book's backward scan over one basic block.
 *
 *   codegenNextUse('t = a - b\nu = a - c', { liveOnExit: ['a', 'b', 'c'] })
 *   // { statements, liveOnExit, rows: [{ index, text, attached, after }], trace }
 *   // nextUse is a 0-based statement index, or null. Trace state: { index, table, attached }.
 *
 * GETREG, with register and address descriptors. This call is the book's worked example:
 *
 *   codegenGetReg('t = a - b\nu = a - c\nv = t + u\na = d\nd = v + u',
 *                 { registers: 3, liveOnExit: ['a', 'b', 'c', 'd'] })
 *   // { statements, rows, code, groups: [{ statement, code }], trace }
 *   // Trace state: { statement, instruction, code, registers: [{ register, holds }],
 *   //                addresses: [{ name, locations }], choice: { rx, ry, rz } }.
 *
 * GRAPH COLORING, Chaitin style, returning plain lists for a 2D or 3D layout.
 *
 *   codegenColorGraph(tacText, { registers: 3 })
 *   // { k, registers, nodes: [{ id, degree, color, range }], edges: [{ source, target }],
 *   //   assignment, spilled, rounds, program, trace }
 *   // Trace state: { round, phase, focus, nodes: [{ id, degree, status, color, spillCost }],
 *   //                edges, stack, program }.
 *   // phase is build, simplify, spill-candidate, select, spill or done.
 *
 * SETHI-ULLMAN, optimal code for a tree. This call is the book's example:
 *
 *   codegenSethiUllman('(a - b) + e * (c + d)', { registers: 3 })
 *   // { tree, labels, registersNeeded, registers, code, resultRegister, spills, trace }
 *   // Trace state: { phase: 'label' | 'generate', node, labels, code }.
 *
 * DAG-BASED GENERATION, for a basic block. Common subexpressions share a node, shared nodes become
 * trees of their own, and each tree gets Sethi-Ullman code.
 *
 *   codegenDagGenerate('a = b + c\nb = a - d\nc = b + c\nd = a - d', { registers: 3 })
 *   // { statements, nodes, edges: [{ from, to }], order, code, registers, liveOnExit, trace }
 *   // Trace state: { phase, statement, focus, nodes, edges, code }.
 *
 * EXPRESSIONS.
 *
 *   codegenParseExpr('a + b')    // a CgExpr tree with source positions
 */
export {
  ISA_OPCODE_OF_OPERATOR,
  ISA_OPERATORS,
  ISA_REFERENCE,
  ISA_REGISTER_COUNT,
  isaInstructionCost,
  type IsaBinaryOpcode,
  type IsaDescription,
  type IsaOpcode,
} from './isa';
export {
  CODEGEN_MAX_EXPR_LENGTH,
  codegenFormatExpr,
  codegenParseExpr,
  type CgExpr,
  type CgTreeNode,
} from './expr';
export { codegenStackMachine, type StackCodeResult, type StackCodeState } from './stack-machine';
export {
  codegenSelectInstructions,
  codegenSelectRule,
  type SelectionResult,
  type SelectionRow,
  type SelectionRule,
  type SelectionState,
} from './selection';
export {
  CODEGEN_MAX_BLOCK_STATEMENTS,
  codegenBlockStatements,
  codegenDefaultLiveOnExit,
  codegenNextUse,
  type NextUseEntry,
  type NextUseResult,
  type NextUseRow,
  type NextUseState,
} from './next-use';
export {
  CODEGEN_MAX_REGISTERS,
  codegenGetReg,
  type GetRegGroup,
  type GetRegOptions,
  type GetRegResult,
  type GetRegState,
} from './get-reg';
export {
  COLORING_MAX_NODES,
  COLORING_MAX_ROUNDS,
  COLORING_SPILL_ARRAY,
  codegenColorGraph,
  type ColoringEdge,
  type ColoringGraph,
  type ColoringLiveRange,
  type ColoringNodeStatus,
  type ColoringNodeView,
  type ColoringPhase,
  type ColoringResult,
  type ColoringStepState,
} from './coloring';
export {
  SU_DEFAULT_REGISTERS,
  codegenSethiUllman,
  type SethiUllmanResult,
  type SethiUllmanState,
  type SuTree,
} from './sethi-ullman';
export {
  codegenDagGenerate,
  type DagGenPhase,
  type DagGenResult,
  type DagGenState,
  type DagNodeView,
} from './dag-gen';
