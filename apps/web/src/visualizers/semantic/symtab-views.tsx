import type {
  SymtabEntry,
  SymtabHashStructure,
  SymtabStackStructure,
  SymtabState,
  SymtabStructure,
  SymtabTreeNode,
  SymtabTreeStructure,
} from '@compilerlab/engine';

// One drawing for each way to organize a symbol table. All are plain SVG, so the page and the
// exported frames show the same thing. Whatever a step compared glows, and a lookup's answer is
// outlined in green.

const CHAR = 7.4;
const FONT = 12;

interface EntryLook {
  fill: string;
  stroke: string;
  ink: string;
  bold: boolean;
}

const PLAIN_LOOK: EntryLook = {
  fill: 'var(--surface)',
  stroke: 'var(--line-strong)',
  ink: 'var(--ink)',
  bold: false,
};
const COMPARED_LOOK: EntryLook = {
  fill: 'var(--accent-soft)',
  stroke: 'var(--accent)',
  ink: 'var(--accent)',
  bold: true,
};
const FOUND_LOOK: EntryLook = {
  fill: 'var(--diff-add)',
  stroke: 'var(--success)',
  ink: 'var(--diff-add-ink)',
  bold: true,
};

const entryText = (entry: SymtabEntry) => `${entry.name} : ${entry.type}`;

/** Two scopes can each declare a name, so a lookup's answer is matched on its scope too. */
const isFound = (state: SymtabState, entry: SymtabEntry) =>
  state.found?.name === entry.name && state.found.scope === entry.scope;

function EntryBox({
  x,
  y,
  width,
  height,
  text,
  look,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  look: EntryLook;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        width={width}
        height={height}
        rx={3}
        fill={look.fill}
        stroke={look.stroke}
        strokeWidth={look === PLAIN_LOOK ? 1 : 2}
      />
      <text
        x={8}
        y={height / 2}
        dominantBaseline="central"
        fontSize={FONT}
        fontWeight={look.bold ? 600 : 400}
        fill={look.ink}
        xmlSpace="preserve"
      >
        {text}
      </text>
    </g>
  );
}

// ------ Scoped stack ------

const FRAME_WIDTH_MIN = 240;
const FRAME_HEADER = 22;
const FRAME_ROW = 24;
const FRAME_GAP = 8;

function stackSize(structure: SymtabStackStructure) {
  const height = structure.frames.reduce(
    (sum, frame) => sum + FRAME_HEADER + frame.entries.length * FRAME_ROW + 8 + FRAME_GAP,
    4,
  );
  const longest = Math.max(
    0,
    ...structure.frames.flatMap((frame) => frame.entries.map((entry) => entryText(entry).length)),
  );
  return { width: Math.max(FRAME_WIDTH_MIN, longest * CHAR + 44), height };
}

/** A stack drawn the way one is pictured, with the innermost scope on top. */
function StackDrawing({
  structure,
  state,
  width,
}: {
  structure: SymtabStackStructure;
  state: SymtabState;
  width: number;
}) {
  const topFirst = structure.frames.map((frame, index) => ({ frame, index })).reverse();
  let y = 4;
  return (
    <g fontFamily="monospace">
      {topFirst.map(({ frame, index }, place) => {
        const here = y;
        const frameHeight = FRAME_HEADER + frame.entries.length * FRAME_ROW + 8;
        y += frameHeight + FRAME_GAP;
        const isTop = place === 0;
        return (
          <g key={frame.scope} transform={`translate(4 ${here})`}>
            {isTop ? (
              <rect
                x={-3}
                y={-3}
                width={width - 8 + 6}
                height={frameHeight + 6}
                rx={8}
                fill="var(--accent)"
                fillOpacity={0.12}
              />
            ) : null}
            <rect
              width={width - 8}
              height={frameHeight}
              rx={6}
              fill="var(--surface-2)"
              stroke={isTop ? 'var(--accent)' : 'var(--line-strong)'}
              strokeWidth={isTop ? 2 : 1}
            />
            <text x={10} y={15} fontSize={11} fontWeight={600} fill="var(--ink-muted)">
              {`Level ${frame.level}${isTop ? ', the current scope' : ''}`}
            </text>
            {frame.entries.length === 0 ? null : (
              <>
                {frame.entries
                  .map((entry, entryIndex) => ({ entry, entryIndex }))
                  .reverse()
                  .map(({ entry, entryIndex }, row) => {
                    const compared = structure.visited.some(
                      (mark) => mark.frame === index && mark.index === entryIndex,
                    );
                    return (
                      <EntryBox
                        key={entry.name}
                        x={10}
                        y={FRAME_HEADER + row * FRAME_ROW}
                        width={width - 28}
                        height={FRAME_ROW - 3}
                        text={entryText(entry)}
                        look={
                          isFound(state, entry) ? FOUND_LOOK : compared ? COMPARED_LOOK : PLAIN_LOOK
                        }
                      />
                    );
                  })}
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ------ Hash table ------

const BUCKET_ROW = 30;
const BUCKET_LABEL = 36;
const CHAIN_GAP = 22;
const HASH_FORMULA = 26;
/** Past this many buckets, only the ones with something in them are drawn. */
const MAX_DRAWN_EMPTY_BUCKETS = 31;

const hashEntryText = (entry: SymtabEntry) => `${entry.name} : ${entry.type} @${entry.level}`;
const hashEntryWidth = (entry: SymtabEntry) => hashEntryText(entry).length * CHAR + 16;

function drawnBuckets(structure: SymtabHashStructure): number[] {
  const all = structure.buckets.map((_, index) => index);
  if (structure.size <= MAX_DRAWN_EMPTY_BUCKETS) return all;
  return all.filter(
    (index) => (structure.buckets[index]?.length ?? 0) > 0 || structure.hash?.bucket === index,
  );
}

function hashSize(structure: SymtabHashStructure) {
  const rows = drawnBuckets(structure);
  const longestChain = Math.max(
    0,
    ...rows.map((row) =>
      (structure.buckets[row] ?? []).reduce(
        (sum, entry) => sum + hashEntryWidth(entry) + CHAIN_GAP,
        0,
      ),
    ),
  );
  const scopeLines = structure.scopeLists.length;
  const scopeWidth = Math.max(
    0,
    ...structure.scopeLists.map(
      (scope) => (`Level ${scope.level}: ${scope.names.join(', ')}`.length + 1) * CHAR,
    ),
  );
  return {
    width: Math.max(280, BUCKET_LABEL + longestChain + 28, scopeWidth + 12),
    height: HASH_FORMULA + rows.length * BUCKET_ROW + 24 + scopeLines * 18 + 8,
  };
}

/** Each bucket points to a chain, newest first, so an inner declaration is always found first. */
function HashDrawing({ structure, state }: { structure: SymtabHashStructure; state: SymtabState }) {
  const rows = drawnBuckets(structure);
  const scopesY = HASH_FORMULA + rows.length * BUCKET_ROW + 8;
  return (
    <g fontFamily="monospace">
      <text
        x={4}
        y={16}
        fontSize={13}
        fontWeight={600}
        fill={structure.hash ? 'var(--accent)' : 'var(--ink-muted)'}
      >
        {structure.hash
          ? structure.hash.formula
          : 'h(name) = the sum of its character codes, mod the bucket count'}
      </text>
      {rows.map((bucket, row) => {
        const y = HASH_FORMULA + row * BUCKET_ROW;
        const lit = structure.hash?.bucket === bucket;
        let x = BUCKET_LABEL + 16;
        return (
          <g key={bucket}>
            <rect
              x={4}
              y={y}
              width={BUCKET_LABEL - 4}
              height={BUCKET_ROW - 4}
              fill={lit ? 'var(--accent-soft)' : 'var(--surface-2)'}
              stroke={lit ? 'var(--accent)' : 'var(--line-strong)'}
              strokeWidth={lit ? 2 : 1}
            />
            <text
              x={4 + (BUCKET_LABEL - 4) / 2}
              y={y + (BUCKET_ROW - 4) / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={FONT}
              fontWeight={lit ? 600 : 400}
              fill={lit ? 'var(--accent)' : 'var(--ink)'}
            >
              {bucket}
            </text>
            {(structure.buckets[bucket] ?? []).map((entry, index) => {
              const width = hashEntryWidth(entry);
              const here = x;
              x += width + CHAIN_GAP;
              const compared = structure.visited.some(
                (mark) => mark.bucket === bucket && mark.index === index,
              );
              const arrowStart = index === 0 ? BUCKET_LABEL : here - CHAIN_GAP;
              const middle = y + (BUCKET_ROW - 4) / 2;
              return (
                <g key={`${entry.name}:${entry.scope}`}>
                  <path
                    d={`M${arrowStart},${middle} H${here - 7}`}
                    stroke="var(--line-strong)"
                    strokeWidth={1.5}
                  />
                  <polygon
                    points={`${here},${middle} ${here - 7},${middle - 3.5} ${here - 7},${middle + 3.5}`}
                    fill="var(--line-strong)"
                  />
                  <EntryBox
                    x={here}
                    y={y}
                    width={width}
                    height={BUCKET_ROW - 4}
                    text={hashEntryText(entry)}
                    look={
                      isFound(state, entry) ? FOUND_LOOK : compared ? COMPARED_LOOK : PLAIN_LOOK
                    }
                  />
                </g>
              );
            })}
          </g>
        );
      })}
      <text x={4} y={scopesY + 12} fontSize={11} fontWeight={600} fill="var(--ink-muted)">
        What each open scope declared, so closing it needs no search:
      </text>
      {structure.scopeLists.map((scope, index) => (
        <text
          key={index}
          x={4}
          y={scopesY + 30 + index * 18}
          fontSize={FONT}
          fill="var(--ink)"
          xmlSpace="preserve"
        >
          {`Level ${scope.level}: ${scope.names.join(', ') || 'nothing yet'}`}
        </text>
      ))}
    </g>
  );
}

// ------ Binary search tree ------

const TREE_LEVEL = 92;
const TREE_RADIUS = 20;
const TREE_MIN_GAP = 56;
const TREE_MARGIN = 16;
const BINDING_LINE = 16;

const bindingText = (entry: SymtabEntry) => `${entry.type} @${entry.level}`;

interface PlacedNode {
  node: SymtabTreeNode;
  x: number;
  y: number;
}

/**
 * A search tree must show which side a child is on, which a tidy layout would hide when a node has
 * one child. So x is the order an in-order walk visits nodes, and y is the depth.
 */
function placeTree(structure: SymtabTreeStructure) {
  const byId = new Map(structure.nodes.map((node) => [node.id, node]));
  const placed = new Map<number, PlacedNode>();
  let x = TREE_MARGIN;
  let deepest = 0;
  const visit = (id: number | null, depth: number): void => {
    if (id === null) return;
    const node = byId.get(id) as SymtabTreeNode;
    visit(node.left, depth + 1);
    const longest = Math.max(1, ...node.bindings.map((entry) => bindingText(entry).length));
    const width = Math.max(TREE_MIN_GAP, longest * CHAR + 14);
    placed.set(id, { node, x: x + width / 2, y: TREE_RADIUS + 8 + depth * TREE_LEVEL });
    deepest = Math.max(deepest, depth);
    x += width;
    visit(node.right, depth + 1);
  };
  visit(structure.root, 0);
  const lowest = Math.max(
    0,
    ...[...placed.values()].map(
      (item) => item.y + TREE_RADIUS + item.node.bindings.length * BINDING_LINE,
    ),
  );
  return { placed, width: Math.max(280, x + TREE_MARGIN), height: Math.max(80, lowest + 12) };
}

function treeSize(structure: SymtabTreeStructure) {
  const { width, height } = placeTree(structure);
  return { width, height };
}

function TreeDrawing({ structure, state }: { structure: SymtabTreeStructure; state: SymtabState }) {
  const { placed } = placeTree(structure);
  const items = [...placed.values()];
  const last = structure.path.at(-1);
  if (items.length === 0) {
    return (
      <text x={8} y={24} fontSize={FONT} fontFamily="monospace" fill="var(--ink-muted)">
        The tree is empty.
      </text>
    );
  }
  return (
    <g fontFamily="monospace">
      {items.flatMap((item) =>
        [item.node.left, item.node.right].map((child) => {
          const to = child === null ? undefined : placed.get(child);
          if (!to) return null;
          const onPath =
            structure.path.includes(item.node.id) && structure.path.includes(to.node.id);
          return (
            <line
              key={`${item.node.id}-${to.node.id}`}
              x1={item.x}
              y1={item.y}
              x2={to.x}
              y2={to.y}
              stroke={onPath ? 'var(--accent)' : 'var(--line-strong)'}
              strokeWidth={onPath ? 2.25 : 1.5}
            />
          );
        }),
      )}
      {items.map(({ node, x, y }) => {
        const compared = structure.path.includes(node.id);
        const found = state.found !== null && state.found.name === node.name;
        const glowing = found || node.id === last;
        const stroke = found ? 'var(--success)' : compared ? 'var(--accent)' : 'var(--ink-muted)';
        return (
          <g key={node.id} transform={`translate(${x} ${y})`}>
            {glowing ? (
              <circle
                r={TREE_RADIUS + 6}
                fill={found ? 'var(--success)' : 'var(--accent)'}
                fillOpacity={0.22}
              />
            ) : null}
            <circle
              r={TREE_RADIUS}
              fill="var(--surface)"
              stroke={stroke}
              strokeWidth={compared ? 2.5 : 1.75}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={node.name.length > 4 ? 10 : 13}
              fontWeight={600}
              fill="var(--ink)"
            >
              {node.name}
            </text>
            {node.bindings.map((entry, index) => {
              const inEffect = index === node.bindings.length - 1;
              return (
                <text
                  key={entry.scope}
                  y={TREE_RADIUS + 13 + index * BINDING_LINE}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={inEffect ? 600 : 400}
                  fill={inEffect ? 'var(--ink)' : 'var(--ink-muted)'}
                  textDecoration={inEffect ? undefined : 'line-through'}
                >
                  {bindingText(entry)}
                </text>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

// ------ Together ------

export function symtabSize(structure: SymtabStructure): { width: number; height: number } {
  switch (structure.organization) {
    case 'stack':
      return stackSize(structure);
    case 'hash':
      return hashSize(structure);
    case 'tree':
      return treeSize(structure);
  }
}

/** One step's structure, for the page or for an exported frame. */
export function SymtabDrawing({ state, width }: { state: SymtabState; width: number }) {
  const { structure } = state;
  switch (structure.organization) {
    case 'stack':
      return <StackDrawing structure={structure} state={state} width={width} />;
    case 'hash':
      return <HashDrawing structure={structure} state={state} />;
    case 'tree':
      return <TreeDrawing structure={structure} state={state} />;
  }
}

/** Words for a screen reader, since the drawing is one image to it. */
export function describeStructure(structure: SymtabStructure): string {
  switch (structure.organization) {
    case 'stack':
      return `A stack of ${structure.frames.length} scopes. From the top: ${[...structure.frames]
        .reverse()
        .map(
          (frame) =>
            `level ${frame.level} has ${frame.entries.map(entryText).join(', ') || 'nothing'}`,
        )
        .join('; ')}.`;
    case 'hash':
      return `A hash table with ${structure.size} buckets. ${structure.buckets
        .flatMap((chain, index) =>
          chain.length > 0 ? [`Bucket ${index}: ${chain.map(entryText).join(', ')}`] : [],
        )
        .join('. ')}.`;
    case 'tree':
      return `A binary search tree with ${structure.nodes.length} nodes: ${structure.nodes
        .map((node) => node.name)
        .join(', ')}.`;
  }
}
