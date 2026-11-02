import { describe, expect, it } from 'vitest';
import { layoutGraph, routeEdge, STATE_RADIUS, type Point } from './layout';

// The Thompson NFA for (a|b)*abb.
const KEYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EDGES = [
  [0, 1],
  [0, 7],
  [1, 2],
  [1, 4],
  [2, 3],
  [4, 5],
  [3, 6],
  [5, 6],
  [6, 1],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
].map(([from, to]) => ({ from: from as number, to: to as number }));

describe('layoutGraph', () => {
  const layout = layoutGraph(KEYS, EDGES, 0);
  const at = (key: number) => layout.positions.get(key) as Point;

  it('places every state', () => {
    expect(layout.positions.size).toBe(KEYS.length);
  });

  it('never stacks two states on each other', () => {
    const points = [...layout.positions.values()];
    points.forEach((a, i) => {
      points.slice(i + 1).forEach((b) => {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(STATE_RADIUS * 2);
      });
    });
  });

  it('keeps every state inside the drawing', () => {
    for (const { x, y } of layout.positions.values()) {
      expect(x).toBeGreaterThanOrEqual(STATE_RADIUS);
      expect(x).toBeLessThanOrEqual(layout.width - STATE_RADIUS);
      expect(y).toBeGreaterThanOrEqual(STATE_RADIUS);
      expect(y).toBeLessThanOrEqual(layout.height - STATE_RADIUS);
    }
  });

  it('flows left to right along forward edges, despite the loop', () => {
    expect(at(0).x).toBeLessThan(at(1).x);
    expect(at(3).x).toBeLessThan(at(6).x);
    expect(at(6).x).toBeLessThan(at(7).x);
    expect(at(9).x).toBeLessThan(at(10).x);
    expect(at(6).x).toBeGreaterThan(at(1).x);
  });

  it('gives parallel branches their own rows', () => {
    expect(at(2).x).toBe(at(4).x);
    expect(at(2).y).not.toBe(at(4).y);
  });

  it('is deterministic, so frames stay stable across renders', () => {
    const again = layoutGraph(KEYS, EDGES, 0);
    expect([...again.positions]).toEqual([...layout.positions]);
  });

  it('handles a single state, self-loops and unreachable states', () => {
    expect(layoutGraph([0], [], 0).positions.size).toBe(1);
    expect(layoutGraph([0], [{ from: 0, to: 0 }], 0).positions.size).toBe(1);
    const stray = layoutGraph(
      [0, 1, 2],
      [
        { from: 0, to: 1 },
        { from: 2, to: 2 },
      ],
      0,
    );
    expect(stray.positions.size).toBe(3);
  });

  it('copes with cycles that do not include the start state', () => {
    const cycle = layoutGraph(
      [0, 1, 2],
      [
        { from: 1, to: 2 },
        { from: 2, to: 1 },
      ],
      0,
    );
    expect(cycle.positions.size).toBe(3);
  });
});

describe('routeEdge', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 200, y: 0 };
  const blocker = { x: 100, y: 0 };

  it('draws a straight line when nothing is in the way', () => {
    expect(routeEdge(a, b, [a, b], false).path).toBe('M22,0 Q100,0 177,0');
  });

  it('arcs around a state in the way', () => {
    const routed = routeEdge(a, b, [a, b, blocker], false);
    const control = /Q([\d.-]+),([\d.-]+)/.exec(routed.path);
    expect(Math.abs(Number(control?.[2]))).toBeGreaterThan(STATE_RADIUS);
  });

  it('curves reciprocal edges apart', () => {
    const there = routeEdge(a, b, [a, b], true);
    const back = routeEdge(b, a, [a, b], true);
    expect(there.label.y).not.toBe(back.label.y);
  });

  it('draws a self-loop above the state', () => {
    const routed = routeEdge(a, a, [a], false);
    expect(routed.path).toContain('C');
    expect(routed.label.y).toBeLessThan(-STATE_RADIUS);
  });

  it('ends on the edge of the circle, not its center', () => {
    expect(routeEdge(a, b, [a, b], false).arrow.startsWith('177,0')).toBe(true);
  });
});
