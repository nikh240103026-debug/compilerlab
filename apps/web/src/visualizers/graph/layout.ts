export interface Point {
  x: number;
  y: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  positions: ReadonlyMap<number, Point>;
}

export const STATE_RADIUS = 22;
const COLUMN_GAP = 104;
const ROW_GAP = 84;
const MARGIN_X = 64;
/** Extra room at the top for self-loops, and for arcs that swing over other states. */
const MARGIN_Y = 92;

interface EdgeEnds {
  from: number;
  to: number;
}

/** Marks edges that close a cycle, found with a depth-first walk from the start state. */
function findBackEdges(keys: readonly number[], edges: readonly EdgeEnds[], start: number) {
  const out = new Map<number, number[]>(keys.map((key) => [key, []]));
  for (const { from, to } of edges) out.get(from)?.push(to);

  const back = new Set<string>();
  const seen = new Set<number>();
  const onPath = new Set<number>();
  const visit = (key: number) => {
    seen.add(key);
    onPath.add(key);
    for (const next of out.get(key) ?? []) {
      if (onPath.has(next)) back.add(`${key}>${next}`);
      else if (!seen.has(next)) visit(next);
    }
    onPath.delete(key);
  };
  if (out.has(start)) visit(start);
  for (const key of keys) if (!seen.has(key)) visit(key);
  return back;
}

/**
 * A layered left-to-right layout, the way textbooks draw automata. Each state's column is its
 * longest distance from the start, ignoring back edges, and states in a column are ordered to
 * sit near their neighbors, which keeps crossings down.
 */
export function layoutGraph(
  keys: readonly number[],
  edges: readonly EdgeEnds[],
  start: number,
): GraphLayout {
  const back = findBackEdges(keys, edges, start);
  const forward = edges.filter(({ from, to }) => from !== to && !back.has(`${from}>${to}`));

  const rank = new Map<number, number>(keys.map((key) => [key, 0]));
  // A forward graph has no cycles, so this settles within one pass per state.
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const { from, to } of forward) {
      const next = (rank.get(from) ?? 0) + 1;
      if (next > (rank.get(to) ?? 0)) {
        rank.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columnCount = Math.max(0, ...rank.values()) + 1;
  const columns: number[][] = Array.from({ length: columnCount }, () => []);
  for (const key of keys) columns[rank.get(key) ?? 0]?.push(key);

  const neighbors = new Map<number, number[]>(keys.map((key) => [key, []]));
  for (const { from, to } of forward) {
    neighbors.get(from)?.push(to);
    neighbors.get(to)?.push(from);
  }

  const place = new Map<number, number>();
  const refreshPlaces = () => {
    for (const column of columns)
      column.forEach((key, i) => place.set(key, i - (column.length - 1) / 2));
  };
  refreshPlaces();
  const average = (key: number) => {
    const around = neighbors.get(key) ?? [];
    if (around.length === 0) return place.get(key) ?? 0;
    return around.reduce((sum, other) => sum + (place.get(other) ?? 0), 0) / around.length;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const column of columns) {
      const scored = column.map((key) => [key, average(key)] as const);
      scored.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      column.splice(0, column.length, ...scored.map(([key]) => key));
    }
    refreshPlaces();
  }

  const tallest = Math.max(1, ...columns.map((column) => column.length));
  const width = MARGIN_X * 2 + (columnCount - 1) * COLUMN_GAP;
  const height = MARGIN_Y * 2 + (tallest - 1) * ROW_GAP;
  const positions = new Map<number, Point>();
  columns.forEach((column, columnIndex) => {
    column.forEach((key, i) => {
      positions.set(key, {
        x: MARGIN_X + columnIndex * COLUMN_GAP,
        y: height / 2 + (i - (column.length - 1) / 2) * ROW_GAP,
      });
    });
  });
  return { width, height, positions };
}

export interface RoutedEdge {
  path: string;
  arrow: string;
  label: Point;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function curvePoint(a: Point, control: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
  };
}

function towards(from: Point, to: Point, length: number): Point {
  const span = distance(from, to) || 1;
  return {
    x: from.x + ((to.x - from.x) / span) * length,
    y: from.y + ((to.y - from.y) / span) * length,
  };
}

function arrowHead(tip: Point, from: Point): string {
  const span = distance(from, tip) || 1;
  const ux = (tip.x - from.x) / span;
  const uy = (tip.y - from.y) / span;
  const size = 8;
  const wing = 4;
  const baseX = tip.x - ux * size;
  const baseY = tip.y - uy * size;
  return [
    `${tip.x},${tip.y}`,
    `${baseX - uy * wing},${baseY + ux * wing}`,
    `${baseX + uy * wing},${baseY - ux * wing}`,
  ].join(' ');
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Computes one edge's curve. Tries a straight line first, then arcs of growing size, and keeps
 * the first that clears every other state. Reciprocal edges always arc, so they don't overlap.
 */
export function routeEdge(
  from: Point,
  to: Point,
  obstacles: readonly Point[],
  hasReverse: boolean,
): RoutedEdge {
  if (from.x === to.x && from.y === to.y) {
    const y = from.y - STATE_RADIUS + 3;
    const tip = { x: from.x + 11, y };
    return {
      path: `M${from.x - 11},${y} C${from.x - 44},${from.y - 76} ${from.x + 44},${from.y - 76} ${tip.x},${tip.y}`,
      arrow: arrowHead(tip, { x: from.x + 24, y: from.y - 56 }),
      label: { x: from.x, y: from.y - 68 },
    };
  }

  const span = distance(from, to);
  const nx = -(to.y - from.y) / span;
  const ny = (to.x - from.x) / span;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const bends = hasReverse ? [26, 60, 96] : [0, -44, 44, -84, 84, -128, 128, -176, 176];
  const clearance = STATE_RADIUS + 9;
  const others = obstacles.filter((point) => distance(point, from) > 1 && distance(point, to) > 1);

  const controlFor = (bend: number): Point => ({
    x: mid.x + nx * bend * 2,
    y: mid.y + ny * bend * 2,
  });
  const clears = (control: Point) => {
    for (let t = 0.05; t < 1; t += 0.05) {
      const point = curvePoint(from, control, to, t);
      if (others.some((other) => distance(point, other) < clearance)) return false;
    }
    return true;
  };

  const bend = bends.find((candidate) => clears(controlFor(candidate))) ?? (bends.at(-1) as number);
  const control = controlFor(bend);
  const start = towards(from, control, STATE_RADIUS);
  const end = towards(to, control, STATE_RADIUS + 1);
  const middle = curvePoint(start, control, end, 0.5);
  const side = bend < 0 ? -1 : bend > 0 ? 1 : -1;
  // A straight edge's label sits above it. A curved edge's label sits on the outside of the bend.
  const offset = bend === 0 ? (ny < 0 ? -11 : 11) * -1 : side * 11;
  return {
    path: `M${round(start.x)},${round(start.y)} Q${round(control.x)},${round(control.y)} ${round(end.x)},${round(end.y)}`,
    arrow: arrowHead(end, control),
    label: { x: round(middle.x + nx * offset), y: round(middle.y + ny * offset) },
  };
}
