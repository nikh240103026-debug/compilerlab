import { EngineError } from '../core/result';
import { TraceRecorder } from '../core/trace';
import {
  HEAP_COLLECTORS,
  type HeapBlockView,
  type HeapCollector,
  type HeapObjectView,
  type HeapOp,
  type HeapPhase,
  type HeapRunResult,
  type HeapStepState,
} from './heap-model';

export const HEAP_DEFAULT_CAPACITY = 32;
export const HEAP_MAX_CAPACITY = 256;
export const HEAP_MAX_OPS = 200;
export const HEAP_MAX_FIELDS = 8;
/** One cell of header, plus one cell per pointer field. */
const HEADER_CELLS = 1;

interface Obj {
  id: number;
  label: string;
  address: number;
  size: number;
  fields: (number | null)[];
  refCount: number;
  marked: boolean;
  garbage: boolean;
}

export interface HeapRunOptions {
  /** Cells in the whole heap. Copying splits this into two equal semispaces. */
  capacity?: number;
}

/** State shared by all three collectors, and the plumbing that turns it into trace steps. */
class Heap {
  readonly objects = new Map<number, Obj>();
  readonly roots = new Map<string, number | null>();
  readonly recorder = new TraceRecorder<HeapStepState>();
  nextId = 0;
  collections = 0;
  freed = 0;
  /** Copying only. */
  spaceStart = 0;
  spaceSize: number;
  bump = 0;
  scan: number | null = null;
  toStart: number | null = null;
  free: number | null = null;

  constructor(
    readonly collector: HeapCollector,
    readonly capacity: number,
  ) {
    this.spaceSize = collector === 'copying' ? Math.floor(capacity / 2) : capacity;
  }

  viewObject(object: Obj): HeapObjectView {
    return { ...object, fields: [...object.fields] };
  }

  blocks(): HeapBlockView[] {
    const sorted = [...this.objects.values()].toSorted((a, b) => a.address - b.address);
    const blocks: HeapBlockView[] = [];
    let at = 0;
    for (const object of sorted) {
      if (object.address > at)
        blocks.push({ address: at, size: object.address - at, object: null });
      blocks.push({ address: object.address, size: object.size, object: object.id });
      at = object.address + object.size;
    }
    if (at < this.capacity) blocks.push({ address: at, size: this.capacity - at, object: null });
    return blocks;
  }

  record(phase: HeapPhase, focus: number | null, title: string, explanation: string): void {
    const copying = this.collector === 'copying';
    const toSpaceStart = this.toStart;
    this.recorder.add(title, explanation, {
      collector: this.collector,
      phase,
      blocks: this.blocks(),
      objects: [...this.objects.values()].map((object) => this.viewObject(object)),
      roots: Object.fromEntries(this.roots),
      focus,
      fromSpace: copying ? { start: this.spaceStart, end: this.spaceStart + this.spaceSize } : null,
      toSpace:
        copying && toSpaceStart !== null
          ? { start: toSpaceStart, end: toSpaceStart + this.spaceSize }
          : null,
      scan: this.scan,
      free: this.free,
      capacity: this.capacity,
      usedCells: [...this.objects.values()].reduce((sum, object) => sum + object.size, 0),
      collections: this.collections,
    });
  }

  /** What the program can reach right now: everything from the variables, through the fields. */
  reachable(): Set<number> {
    const seen = new Set<number>();
    const pending = [...this.roots.values()].filter((id): id is number => id !== null);
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const object = this.objects.get(id);
      if (object) pending.push(...object.fields.filter((f): f is number => f !== null));
    }
    return seen;
  }

  /** The first block of free space big enough, within the given range. */
  firstFit(size: number, start: number, end: number): number | null {
    const sorted = [...this.objects.values()]
      .filter((object) => object.address >= start && object.address < end)
      .toSorted((a, b) => a.address - b.address);
    let at = start;
    for (const object of sorted) {
      if (object.address - at >= size) return at;
      at = object.address + object.size;
    }
    return end - at >= size ? at : null;
  }

  place(size: number, address: number, fields: number, label: string | undefined): Obj {
    const id = this.nextId++;
    const object: Obj = {
      id,
      label: label ?? `obj${id}`,
      address,
      size,
      fields: new Array<number | null>(fields).fill(null),
      refCount: 0,
      marked: false,
      garbage: false,
    };
    this.objects.set(id, object);
    return object;
  }
}

function nameOf(heap: Heap, id: number): string {
  return heap.objects.get(id)?.label ?? `obj${id}`;
}

function collectMarkSweep(heap: Heap, why: string): void {
  heap.collections++;
  heap.record(
    'mark',
    null,
    'Start marking',
    `${why} Mark everything reachable, starting from the variables. Nothing is moved.`,
  );
  const pending = [...heap.roots.values()].filter((id): id is number => id !== null);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const object = heap.objects.get(id) as Obj;
    if (object.marked) continue;
    object.marked = true;
    heap.record(
      'mark',
      id,
      `Mark ${object.label}`,
      `${object.label} is reachable, so it is marked. Its pointer fields lead to more objects to visit.`,
    );
    pending.push(...object.fields.filter((field): field is number => field !== null));
  }
  for (const object of [...heap.objects.values()].toSorted((a, b) => a.address - b.address)) {
    if (object.marked) {
      object.marked = false;
      heap.record(
        'sweep',
        object.id,
        `Keep ${object.label}`,
        `The sweep walks the heap in address order. ${object.label} is marked, so it stays, and its mark is cleared for next time.`,
      );
    } else {
      heap.objects.delete(object.id);
      heap.freed++;
      heap.record(
        'sweep',
        object.id,
        `Free ${object.label}`,
        `${object.label} is not marked, so nothing can reach it, and its cells return to the free list. Note that this can leave holes between live objects.`,
      );
    }
  }
}

function collectCopying(heap: Heap, why: string): void {
  heap.collections++;
  const toStart = heap.spaceStart === 0 ? heap.spaceSize : 0;
  heap.toStart = toStart;
  heap.scan = toStart;
  heap.free = toStart;
  heap.record(
    'flip',
    null,
    'Start copying',
    `${why} Everything live moves to the empty half of the heap, one object at a time. Whatever is left behind is garbage, and collection never even looks at it.`,
  );

  const forwarded = new Map<number, number>();
  const moved: Obj[] = [];
  const forward = (id: number): number => {
    const known = forwarded.get(id);
    if (known !== undefined) return known;
    const object = heap.objects.get(id) as Obj;
    const copy: Obj = {
      ...object,
      fields: [...object.fields],
      address: heap.free as number,
      marked: true,
    };
    heap.free = (heap.free as number) + object.size;
    // Keeping the same id is what makes this a move rather than a new object in the trace.
    heap.objects.set(id, copy);
    forwarded.set(id, id);
    moved.push(copy);
    heap.record(
      'copy',
      id,
      `Copy ${copy.label}`,
      `Copy ${copy.label} to address ${copy.address}, the free pointer, and leave a forwarding address behind so later references find the copy. The free pointer moves up to ${heap.free}.`,
    );
    return id;
  };

  for (const [name, id] of heap.roots) {
    if (id !== null) heap.roots.set(name, forward(id));
  }
  // Cheney's trick: objects between scan and free are copied but not yet scanned, so the to-space
  // itself serves as the breadth-first queue. No extra memory is needed.
  for (let index = 0; index < moved.length; index++) {
    const object = moved[index] as Obj;
    heap.scan = object.address + object.size;
    object.fields = object.fields.map((field) => (field === null ? null : forward(field)));
    heap.record(
      'scan',
      object.id,
      `Scan ${object.label}`,
      `Update each pointer field of ${object.label} to point at the copy of its target, copying that target first if needed. When scan catches up with free, the work is done.`,
    );
  }

  const before = heap.objects.size;
  for (const [id] of heap.objects) {
    if (!forwarded.has(id)) heap.objects.delete(id);
  }
  heap.freed += before - forwarded.size;
  for (const object of moved) object.marked = false;
  heap.spaceStart = toStart;
  heap.bump = heap.free as number;
  heap.toStart = null;
  heap.scan = null;
  heap.free = null;
  heap.record(
    'done',
    null,
    'Spaces flipped',
    `The two halves swap roles. ${forwarded.size} live object${forwarded.size === 1 ? ' was' : 's were'} moved together with no holes, and the old half is all free space at once.`,
  );
}

/** Reference counting: a count reaching zero frees the object at once, then cascades. */
function decrement(heap: Heap, id: number): void {
  const pending = [id];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const object = heap.objects.get(next);
    if (!object) continue;
    object.refCount--;
    heap.record(
      'count',
      object.id,
      `${object.label}: count ${object.refCount}`,
      `A reference to ${object.label} went away, so its count drops to ${object.refCount}.`,
    );
    if (object.refCount === 0) {
      const fields = object.fields.filter((field): field is number => field !== null);
      heap.objects.delete(object.id);
      heap.freed++;
      heap.record(
        'free',
        object.id,
        `Free ${object.label}`,
        `Nothing refers to ${object.label} any more, so it is freed immediately. Its fields stop referring to their targets, so the counts of those drop too.`,
      );
      pending.push(...fields);
    }
  }
}

function retarget(heap: Heap, previous: number | null, next: number | null): void {
  if (heap.collector !== 'reference-counting') return;
  if (next !== null) {
    const object = heap.objects.get(next) as Obj;
    object.refCount++;
    heap.record(
      'count',
      next,
      `${object.label}: count ${object.refCount}`,
      `A new reference to ${object.label} appeared, so its count rises to ${object.refCount}.`,
    );
  }
  // Increment before decrement, so x = x cannot free the object along the way.
  if (previous !== null) decrement(heap, previous);
}

function requireVariable(heap: Heap, name: string): number | null {
  if (!heap.roots.has(name)) {
    throw new EngineError({
      code: 'heap_unknown_variable',
      message: `The program uses ${name} before giving it a value.`,
      hint: `Start with: { op: 'alloc', variable: '${name}' }`,
    });
  }
  return heap.roots.get(name) as number | null;
}

/** Returns false when there is no way to make room. */
function allocate(heap: Heap, op: HeapOp & { op: 'alloc' }): boolean {
  const fields = op.fields ?? 1;
  if (!Number.isInteger(fields) || fields < 0 || fields > HEAP_MAX_FIELDS) {
    throw new EngineError({
      code: 'heap_bad_fields',
      message: `An object can have between 0 and ${HEAP_MAX_FIELDS} fields, but this one asks for ${fields}.`,
      hint: 'Try a smaller object.',
    });
  }
  const size = HEADER_CELLS + fields;
  const label = op.label ?? `obj${heap.nextId}`;

  const tryPlace = (): number | null => {
    if (heap.collector === 'copying') {
      const end = heap.spaceStart + heap.spaceSize;
      return end - heap.bump >= size ? heap.bump : null;
    }
    return heap.firstFit(size, 0, heap.capacity);
  };

  let address = tryPlace();
  if (address === null && heap.collector === 'mark-sweep') {
    collectMarkSweep(heap, `There is no room for ${label}, so the collector runs.`);
    address = tryPlace();
  } else if (address === null && heap.collector === 'copying') {
    collectCopying(heap, `There is no room for ${label}, so the collector runs.`);
    address = tryPlace();
  }
  if (address === null) {
    heap.record(
      'out-of-memory',
      null,
      'Out of memory',
      `There is no room for ${label}, which needs ${size} cells, even ${heap.collector === 'reference-counting' ? 'though counting frees garbage as it appears' : 'after collecting'}. Everything left in the heap ${heap.collector === 'reference-counting' ? 'is still counted, including any unreachable cycles' : 'is still reachable'}.`,
    );
    return false;
  }

  const previous = heap.roots.get(op.variable) ?? null;
  const object = heap.place(size, address, fields, op.label);
  if (heap.collector === 'copying') heap.bump = address + size;
  heap.roots.set(op.variable, object.id);
  heap.record(
    'alloc',
    object.id,
    `${op.variable} = new ${object.label}`,
    heap.collector === 'copying'
      ? `Bump allocation: place ${object.label} at the free pointer, address ${address}. This is as cheap as allocating gets.`
      : `First fit: ${object.label} goes in the first free block with ${size} cells, at address ${address}.`,
  );
  if (heap.collector === 'reference-counting') {
    object.refCount = 1;
    heap.record(
      'count',
      object.id,
      `${object.label}: count 1`,
      `${op.variable} is the first reference to ${object.label}.`,
    );
    if (previous !== null) decrement(heap, previous);
  }
  return true;
}

/** Runs the same program against one collector, recording the heap at every step. */
export function rtHeapRun(
  program: readonly HeapOp[],
  collector: HeapCollector,
  options: HeapRunOptions = {},
): HeapRunResult {
  const capacity = options.capacity ?? HEAP_DEFAULT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 4 || capacity > HEAP_MAX_CAPACITY) {
    throw new EngineError({
      code: 'heap_bad_capacity',
      message: `The heap must have between 4 and ${HEAP_MAX_CAPACITY} cells.`,
      hint: `Try ${HEAP_DEFAULT_CAPACITY}.`,
    });
  }
  if (program.length > HEAP_MAX_OPS) {
    throw new EngineError({
      code: 'heap_too_long',
      message: `This program has more than ${HEAP_MAX_OPS} steps, which is too long to animate.`,
      hint: 'Try a shorter program.',
    });
  }

  const heap = new Heap(collector, capacity);
  heap.record(
    'start',
    null,
    'Empty heap',
    collector === 'copying'
      ? `The heap is split into two halves of ${heap.spaceSize} cells. Only one half is in use at a time.`
      : `All ${capacity} cells are free.`,
  );

  let outOfMemory = false;
  for (const op of program) {
    if (op.op === 'alloc') {
      if (!allocate(heap, op)) {
        outOfMemory = true;
        break;
      }
    } else if (op.op === 'assign') {
      const next = op.source === null ? null : requireVariable(heap, op.source);
      const previous = heap.roots.get(op.variable) ?? null;
      heap.roots.set(op.variable, next);
      heap.record(
        'assign',
        next,
        `${op.variable} = ${op.source ?? 'null'}`,
        next === null
          ? `${op.variable} no longer refers to anything.`
          : `${op.variable} now refers to ${nameOf(heap, next)}.`,
      );
      retarget(heap, previous, next);
    } else if (op.op === 'set-field') {
      const holderId = requireVariable(heap, op.variable);
      const holder = holderId === null ? undefined : heap.objects.get(holderId);
      if (!holder) {
        throw new EngineError({
          code: 'heap_null_reference',
          message: `${op.variable} refers to nothing, so it has no field ${op.field}.`,
          hint: `Give ${op.variable} an object first.`,
        });
      }
      if (!Number.isInteger(op.field) || op.field < 0 || op.field >= holder.fields.length) {
        throw new EngineError({
          code: 'heap_bad_field',
          message: `${holder.label} has ${holder.fields.length} field${holder.fields.length === 1 ? '' : 's'}, so field ${op.field} does not exist.`,
          hint: `Use a field from 0 to ${holder.fields.length - 1}.`,
        });
      }
      const next = op.source === null ? null : requireVariable(heap, op.source);
      const previous = holder.fields[op.field] ?? null;
      holder.fields[op.field] = next;
      heap.record(
        'assign',
        holder.id,
        `${op.variable}.f${op.field} = ${op.source ?? 'null'}`,
        `Field ${op.field} of ${holder.label} now ${next === null ? 'holds nothing' : `refers to ${nameOf(heap, next)}`}.`,
      );
      retarget(heap, previous, next);
    } else if (collector === 'mark-sweep') {
      collectMarkSweep(heap, 'The program asked for a collection.');
    } else if (collector === 'copying') {
      collectCopying(heap, 'The program asked for a collection.');
    } else {
      heap.record(
        'done',
        null,
        'No collection to run',
        'Reference counting has already freed all it can, as references went away. Anything unreachable that is still here is part of a cycle, whose counts can never reach zero.',
      );
    }
  }

  const reachable = heap.reachable();
  const leaked = [...heap.objects.keys()].filter((id) => !reachable.has(id));
  for (const id of leaked) (heap.objects.get(id) as Obj).garbage = true;
  heap.record(
    'done',
    null,
    'End of program',
    leaked.length > 0
      ? `${leaked.map((id) => nameOf(heap, id)).join(', ')} ${leaked.length === 1 ? 'is' : 'are'} still in the heap though no variable can reach ${leaked.length === 1 ? 'it' : 'them'}.`
      : 'Everything still in the heap is reachable from a variable.',
  );

  return {
    collector,
    capacity,
    finalObjects: [...heap.objects.values()].map((object) => heap.viewObject(object)),
    leaked,
    collections: heap.collections,
    freed: heap.freed,
    outOfMemory,
    trace: heap.recorder.finish(),
  };
}

/** Runs a program under all three collectors, so their results can sit side by side. */
export function rtHeapCompare(
  program: readonly HeapOp[],
  options: HeapRunOptions = {},
): HeapRunResult[] {
  return HEAP_COLLECTORS.map((collector) => rtHeapRun(program, collector, options));
}
