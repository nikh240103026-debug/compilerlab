import type { Trace } from '../core/trace';

// The shared vocabulary of the heap demo, and a small object program all three collectors can run.

export type HeapCollector = 'mark-sweep' | 'reference-counting' | 'copying';

export const HEAP_COLLECTORS: readonly HeapCollector[] = [
  'mark-sweep',
  'reference-counting',
  'copying',
];

/** One action of the program driving the heap. Variables are the program's roots. */
export type HeapOp =
  /** variable = new object with this many pointer fields. */
  | { op: 'alloc'; variable: string; fields?: number; label?: string }
  /** variable = source. A null source drops the reference. */
  | { op: 'assign'; variable: string; source: string | null }
  /** variable.field = source. */
  | { op: 'set-field'; variable: string; field: number; source: string | null }
  /** Ask for a collection now. Reference counting has nothing to do here. */
  | { op: 'collect' };

export interface HeapObjectView {
  id: number;
  label: string;
  /** Where the object starts in the heap. */
  address: number;
  /** Cells it occupies. */
  size: number;
  /** Object ids its pointer fields refer to. */
  fields: (number | null)[];
  refCount: number;
  /** Set by the mark phase, and by copying once forwarded. */
  marked: boolean;
  /** Set when collection can no longer reach it but it has not been freed yet. */
  garbage: boolean;
}

export interface HeapBlockView {
  address: number;
  size: number;
  /** The object here, or null for free space. */
  object: number | null;
}

export type HeapPhase =
  | 'start'
  | 'alloc'
  | 'assign'
  | 'mark'
  | 'sweep'
  | 'count'
  | 'free'
  | 'flip'
  | 'copy'
  | 'scan'
  | 'done'
  | 'out-of-memory';

export interface HeapStepState {
  collector: HeapCollector;
  phase: HeapPhase;
  /** Heap layout from low address to high, every cell accounted for. */
  blocks: HeapBlockView[];
  objects: HeapObjectView[];
  /** The program's variables, each pointing at an object id or nothing. */
  roots: Record<string, number | null>;
  /** The object this step focused on. */
  focus: number | null;
  /** Copying only: where from-space and to-space sit right now. */
  fromSpace: { start: number; end: number } | null;
  toSpace: { start: number; end: number } | null;
  /** Copying only: Cheney's scan and free pointers. */
  scan: number | null;
  free: number | null;
  capacity: number;
  usedCells: number;
  /** How many collections have started so far. */
  collections: number;
}

export interface HeapRunResult {
  collector: HeapCollector;
  capacity: number;
  /** Objects still in the heap at the end. */
  finalObjects: HeapObjectView[];
  /** Objects no variable can reach but which are still in the heap. Cycles under counting. */
  leaked: number[];
  collections: number;
  /** Total objects freed or left behind by collection. */
  freed: number;
  outOfMemory: boolean;
  trace: Trace<HeapStepState>;
}

/**
 * A short program with a shared object and a cycle. Run it under each collector: the cycle is the
 * one thing reference counting cannot get rid of.
 */
export const HEAP_SAMPLE_PROGRAM: readonly HeapOp[] = [
  { op: 'alloc', variable: 'x', fields: 2, label: 'A' },
  { op: 'alloc', variable: 'y', fields: 1, label: 'B' },
  { op: 'set-field', variable: 'x', field: 0, source: 'y' },
  { op: 'alloc', variable: 'z', fields: 1, label: 'C' },
  { op: 'alloc', variable: 'w', fields: 1, label: 'D' },
  // C and D point at each other, then lose their variables: a garbage cycle.
  { op: 'set-field', variable: 'z', field: 0, source: 'w' },
  { op: 'set-field', variable: 'w', field: 0, source: 'z' },
  { op: 'assign', variable: 'z', source: null },
  { op: 'assign', variable: 'w', source: null },
  // B stays alive through A's field after y lets go of it.
  { op: 'assign', variable: 'y', source: null },
  { op: 'collect' },
  { op: 'alloc', variable: 'v', fields: 1, label: 'E' },
];
