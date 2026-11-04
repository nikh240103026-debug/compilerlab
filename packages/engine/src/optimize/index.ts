/**
 * Optimization and data-flow analysis over three-address code.
 *
 * Every function takes either text, parsed by optParseTac, or a TacInstr[] from an earlier phase.
 * Bad input throws an EngineError, and attempt() turns that into a Result. Every trace step is
 * plain JSON-safe data.
 *
 * Assumptions, also worth telling students:
 * - A name like t1 is a temporary. Anything else is a program variable, and optimizing passes
 *   treat those as read after the code ends, unless you pass liveAtExit.
 * - A call changes only its own destination and array contents. There are no global variables.
 * - Arrays may alias, so a store or a call invalidates every remembered array read.
 *
 * PASSES. Each returns an OptPassResult: { instrs, before, after, changes, diff, changed, trace }.
 * Each trace step's state is { pass, program: string[], change: { kind, line, before, after,
 * reason } | null }, and diff is a list of { kind: 'same' | 'removed' | 'added', text, beforeLine,
 * afterLine }.
 *
 *   optConstantFolding('x = 2\ny = x + 3')          // y = 5, using the same arithmetic as the VM
 *   optCopyPropagation('x = y\nz = x + 1')          // z = y + 1
 *   optCommonSubexpressions('a = b + c\nd = b + c') // d = a
 *   optDeadCode('t1 = a + b\nx = 1', { liveAtExit: ['x'] }) // removes t1 = a + b
 *   optStrengthReduction('L: j = j - 1\nt4 = 4 * j\nif t4 > 0 goto L') // updates t4 by subtracting
 *   optLoopInvariantMotion('L: t = a + b\ni = i + t\nif i < 9 goto L') // moves t = a + b out
 *   optPeephole('goto L1\nL1: x = y + 0')           // x = y
 *
 * PIPELINE. Toggle passes and see the combined effect.
 *
 *   optRunPipeline(text, { toggles: { licm: false }, liveAtExit: ['x'] })
 *   // { enabled, before, after, instrs, diff, passResults, rounds, sizeBefore, sizeAfter, trace }
 *
 * DATA-FLOW ANALYSES. Each returns a DataflowResult: { analysis, direction, meet, equations,
 * genName, killName, blocks, edges, universe, definitions, iterations, trace }. Each block has
 * { id, text, preds, succs, gen, kill, in, out }. Each trace step's state is { iteration, block,
 * worklist, sets: { [blockId]: { in, out } }, changed }.
 *
 *   dataflowReachingDefinitions(text)                 // definitions are numbered d1, d2, ...
 *   dataflowLiveVariables(text, { liveAtExit: [] })   // gen and kill mean use and def here
 *   dataflowAvailableExpressions(text)                // starts from U, meets by intersection
 *
 * LOOPS. Dominators, back edges and natural loops.
 *
 *   loopAnalyze(text)
 *   // { cfg, dominators, immediateDominators, backEdges, loops, reducible, trace }
 *
 * BLOCKS AND TEXT.
 *
 *   optParseTac('t1 = a + b')      // TacInstr[]
 *   optFormatProgram(instrs)       // string[]
 *   optBuildCfg(instrs)            // { blocks, edges }, with ENTRY and EXIT blocks
 */
export {
  MAX_TAC_LINES,
  optFormatProgram,
  optIsTempName,
  optOperandOfName,
  optParseTac,
} from './tac-text';
export {
  OPT_ENTRY,
  OPT_EXIT,
  optBuildCfg,
  optFindLeaders,
  optReachableBlocks,
  optReversePostorder,
  type OptBlock,
  type OptCfg,
} from './cfg';
export { optDefOf, optOperandsOf, optToInstrs, optUsesOf } from './tac-util';
export {
  OPT_PASS_LABELS,
  OPT_PASS_NAMES,
  optDiffLines,
  type OptChange,
  type OptDiffLine,
  type OptPassName,
  type OptPassResult,
  type OptPassState,
} from './pass-core';
export { optConstantFolding } from './constant';
export { optCopyPropagation } from './copy';
export { optCommonSubexpressions } from './cse';
export { optDeadCode, type OptDceOptions } from './dce';
export { optStrengthReduction } from './strength';
export { optLoopInvariantMotion, type OptLicmOptions } from './licm';
export { optPeephole } from './peephole';
export {
  OPT_MAX_ROUNDS,
  optRunPipeline,
  type OptPipelineOptions,
  type OptPipelineResult,
  type OptPipelineState,
} from './pipeline';
export {
  MAX_DATAFLOW_BLOCKS,
  MAX_DATAFLOW_FACTS,
  dataflowAvailableExpressions,
  dataflowLiveVariables,
  dataflowReachingDefinitions,
  type DataflowAnalysis,
  type DataflowBlockResult,
  type DataflowDefinition,
  type DataflowDirection,
  type DataflowMeet,
  type DataflowResult,
  type DataflowSets,
  type DataflowStepState,
} from './dataflow';
export {
  loopAnalyze,
  type LoopAnalysis,
  type LoopBackEdge,
  type LoopNatural,
  type LoopPhase,
  type LoopResult,
  type LoopStepState,
} from './loops';
