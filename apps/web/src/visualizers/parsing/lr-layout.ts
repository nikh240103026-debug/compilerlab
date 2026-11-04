import { lrFormatItem, type LrAutomaton } from '@compilerlab/engine';
import { layoutGraph, type Point } from '../graph/layout';

export const ITEM_LINE_HEIGHT = 18;
export const ITEM_HEADER_HEIGHT = 30;
const ITEM_PADDING = 8;
const BORDER = 2;
const CHAR_WIDTH = 7.2;
const COLUMN_GAP = 96;
const ROW_GAP = 30;
const MARGIN_X = 32;
/** Extra room on top for self-loops. */
const MARGIN_Y = 52;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ItemLine {
  text: string;
  kernel: boolean;
}

export interface ItemSetLayout {
  width: number;
  height: number;
  boxes: ReadonlyMap<number, Box>;
  lines: ReadonlyMap<number, readonly ItemLine[]>;
}

/**
 * Item sets are boxes of very different sizes, so this borrows the column and order choices from
 * the automaton layout, then sizes each column to fit its boxes.
 */
export function layoutItemSets(automaton: LrAutomaton): ItemSetLayout {
  const lines = new Map<number, ItemLine[]>();
  const sizes = new Map<number, { width: number; height: number }>();
  for (const state of automaton.states) {
    const itemLines = state.items.map((item) => ({
      text: lrFormatItem(automaton.grammar, item),
      kernel: item.kernel,
    }));
    lines.set(state.id, itemLines);
    const longest = Math.max(10, ...itemLines.map(({ text }) => text.length));
    sizes.set(state.id, {
      width: longest * CHAR_WIDTH + ITEM_PADDING * 2 + BORDER * 2,
      height: ITEM_HEADER_HEIGHT + itemLines.length * ITEM_LINE_HEIGHT + ITEM_PADDING + BORDER * 2,
    });
  }

  const base = layoutGraph(
    automaton.states.map(({ id }) => id),
    automaton.edges,
    0,
  );
  const columns = new Map<number, number[]>();
  for (const { id } of automaton.states) {
    const x = base.positions.get(id)?.x ?? 0;
    columns.set(x, [...(columns.get(x) ?? []), id]);
  }

  const orderedColumns = [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ids]) =>
      ids.sort((a, b) => (base.positions.get(a)?.y ?? 0) - (base.positions.get(b)?.y ?? 0)),
    );
  const heightOf = (ids: readonly number[]) =>
    ids.reduce((sum, id) => sum + (sizes.get(id)?.height ?? 0), 0) +
    Math.max(0, ids.length - 1) * ROW_GAP;
  const tallest = Math.max(0, ...orderedColumns.map(heightOf));

  const boxes = new Map<number, Box>();
  let x = MARGIN_X;
  for (const ids of orderedColumns) {
    const columnWidth = Math.max(...ids.map((id) => sizes.get(id)?.width ?? 0));
    let y = MARGIN_Y + (tallest - heightOf(ids)) / 2;
    for (const id of ids) {
      const size = sizes.get(id) as { width: number; height: number };
      boxes.set(id, { x, y, width: size.width, height: size.height });
      y += size.height + ROW_GAP;
    }
    x += columnWidth + COLUMN_GAP;
  }
  return {
    width: x - COLUMN_GAP + MARGIN_X,
    height: tallest + MARGIN_Y * 2,
    boxes,
    lines,
  };
}

export interface BoxRoute {
  path: string;
  arrow: string;
  label: Point;
}

function arrowHead(tip: Point, from: Point): string {
  const span = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / span;
  const uy = (tip.y - from.y) / span;
  const baseX = tip.x - ux * 8;
  const baseY = tip.y - uy * 8;
  return [
    `${tip.x},${tip.y}`,
    `${baseX - uy * 4},${baseY + ux * 4}`,
    `${baseX + uy * 4},${baseY - ux * 4}`,
  ].join(' ');
}

const round = (value: number) => Math.round(value * 10) / 10;

function cubic(a: Point, b: Point, c: Point, d: Point): BoxRoute {
  return {
    path: `M${round(a.x)},${round(a.y)} C${round(b.x)},${round(b.y)} ${round(c.x)},${round(c.y)} ${round(d.x)},${round(d.y)}`,
    arrow: arrowHead(d, c),
    label: {
      x: round((a.x + 3 * b.x + 3 * c.x + d.x) / 8),
      y: round((a.y + 3 * b.y + 3 * c.y + d.y) / 8),
    },
  };
}

/** One edge between two boxes: forward edges run right, back edges loop under, loops sit on top. */
export function routeBoxEdge(from: Box, to: Box, sameBox: boolean): BoxRoute {
  if (sameBox) {
    const right = from.x + from.width;
    const start = { x: right - 34, y: from.y };
    const end = { x: right - 12, y: from.y };
    return cubic(
      start,
      { x: start.x - 12, y: from.y - 38 },
      { x: end.x + 12, y: from.y - 38 },
      end,
    );
  }
  const fromRight = from.x + from.width;
  const toRight = to.x + to.width;
  const fromMiddleY = from.y + from.height / 2;
  const toMiddleY = to.y + to.height / 2;

  if (to.x >= fromRight) {
    const span = (to.x - fromRight) / 2;
    return cubic(
      { x: fromRight, y: fromMiddleY },
      { x: fromRight + span, y: fromMiddleY },
      { x: to.x - span, y: toMiddleY },
      { x: to.x, y: toMiddleY },
    );
  }
  if (toRight <= from.x) {
    // Backwards. Under both boxes, so it does not lie on top of an edge going the other way.
    const start = { x: from.x + from.width / 2, y: from.y + from.height };
    const end = { x: to.x + to.width / 2, y: to.y + to.height };
    const depth = Math.max(start.y, end.y) + 22 + Math.abs(start.x - end.x) * 0.08;
    return cubic(start, { x: start.x, y: depth }, { x: end.x, y: depth }, end);
  }
  // In the same column. Offset sideways, so two boxes that point at each other get two lines.
  const fromAbove = from.y < to.y;
  const offset = fromAbove ? 18 : -18;
  const start = {
    x: from.x + from.width / 2 + offset,
    y: fromAbove ? from.y + from.height : from.y,
  };
  const end = { x: to.x + to.width / 2 + offset, y: fromAbove ? to.y : to.y + to.height };
  const middle = (start.y + end.y) / 2;
  return cubic(start, { x: start.x, y: middle }, { x: end.x, y: middle }, end);
}
