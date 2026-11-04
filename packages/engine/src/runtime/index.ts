/**
 * Runtime environment models. Each takes a small program description and returns a trace, where
 * every step's state is plain JSON-safe data. Bad input or an endless run gives an EngineError.
 *
 * ACTIVATION RECORDS. Procedures can nest, so frames have control links and access links.
 *
 *   rtSimulateActivations(RT_SAMPLE_FACTORIAL)     // recursion: one frame per call
 *   rtSimulateActivations(RT_SAMPLE_NESTED_SORT)   // the book's sort, for access links
 *   // { output, maxDepth, totalCalls, trace }
 *   // Trace state: { event, frames, current, accessWalk, linkHops, output }.
 *   // Each frame: { id, proc, depth, controlLink, accessLink, returnAddress, slots, baseAddress },
 *   // and links hold frame ids. slots is the frame's layout: { kind, name, value, address }.
 *   // accessWalk lists the frames a variable lookup visited through access links.
 *
 * HEAP AND GARBAGE COLLECTION. The same program runs under each collector.
 *
 *   rtHeapRun(HEAP_SAMPLE_PROGRAM, 'mark-sweep', { capacity: 32 })
 *   rtHeapCompare(HEAP_SAMPLE_PROGRAM)     // one result per collector
 *   // { collector, capacity, finalObjects, leaked, collections, freed, outOfMemory, trace }
 *   // Trace state: { collector, phase, blocks, objects, roots, focus, fromSpace, toSpace, scan,
 *   //                free, capacity, usedCells, collections }.
 *   // blocks accounts for every cell in address order, so it draws directly as a memory bar.
 *   // Under reference counting, leaked lists the garbage cycle in the sample.
 *
 * PARAMETER PASSING. The same program runs under value, reference, copy-restore and name.
 *
 *   rtParamCompare(RT_PARAM_SAMPLE_SWAP)   // the classic swap(i, a[i])
 *   rtParamCompare(RT_PARAM_SAMPLE_ALIAS)  // separates reference from copy-restore
 *   // { runs: [{ mode, finalVariables, finalArrays, trace }], summary: [{ mode, result }] }
 *   // Trace state: { mode, phase, statement, variables, arrays, locals, bindings, reads, writes }.
 */
export {
  RT_SAMPLE_FACTORIAL,
  RT_SAMPLE_NESTED_SORT,
  type RtProcedure,
  type RtProgram,
  type RtStatement,
} from './activation-model';
export {
  RT_MAX_CALL_DEPTH,
  RT_MAX_STEPS,
  rtSimulateActivations,
  type RtActivationResult,
  type RtActivationState,
  type RtEvent,
  type RtFrameView,
  type RtSlot,
  type RtSlotKind,
} from './activation';
export {
  HEAP_COLLECTORS,
  HEAP_SAMPLE_PROGRAM,
  type HeapBlockView,
  type HeapCollector,
  type HeapObjectView,
  type HeapOp,
  type HeapPhase,
  type HeapRunResult,
  type HeapStepState,
} from './heap-model';
export {
  HEAP_DEFAULT_CAPACITY,
  HEAP_MAX_CAPACITY,
  HEAP_MAX_FIELDS,
  HEAP_MAX_OPS,
  rtHeapCompare,
  rtHeapRun,
  type HeapRunOptions,
} from './heap';
export {
  RT_PARAM_MODES,
  RT_PARAM_SAMPLE_ALIAS,
  RT_PARAM_SAMPLE_SWAP,
  rtParamCompare,
  type RtParamBinding,
  type RtParamComparison,
  type RtParamMode,
  type RtParamProgram,
  type RtParamRun,
  type RtParamState,
} from './param-passing';
