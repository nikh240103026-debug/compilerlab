import {
  GRAMMAR_END_MARKER,
  type GrammarParserMove,
  type GrammarParserRun,
  type GrammarParserStep,
  type GrammarStackEntry,
} from '@compilerlab/engine';

const CELL_HEIGHT = 30;
const CHAR_WIDTH = 8;
const MIN_CELL = 30;
const TAPE_HEIGHT = 62;
const STACK_HEIGHT = 66;

const cellWidth = (text: string) => Math.max(MIN_CELL, text.length * CHAR_WIDTH + 14);

function moveColor(move: GrammarParserMove): string {
  if (move === 'accept') return 'var(--success)';
  if (move === 'error' || move === 'reject' || move === 'recover') return 'var(--danger)';
  return 'var(--accent)';
}

export function tokenTapeSize(tokens: readonly string[]) {
  const width = [...tokens, GRAMMAR_END_MARKER].reduce((sum, text) => sum + cellWidth(text), 8);
  return { width, height: TAPE_HEIGHT };
}

/** The input tape, with a marker on the next token. Tokens can be longer than one character. */
export function TokenTape({
  tokens,
  position,
  move,
  y = 0,
}: {
  tokens: readonly string[];
  position: number;
  move: GrammarParserMove;
  y?: number;
}) {
  const { width } = tokenTapeSize(tokens);
  const cells = [...tokens, GRAMMAR_END_MARKER];
  const color = moveColor(move);
  let at = 4;
  const remaining = cells.slice(position).join(' ');
  return (
    <svg
      role="img"
      aria-label={`Input still to read: ${remaining}`}
      y={y}
      width={width}
      height={TAPE_HEIGHT}
      viewBox={`0 0 ${width} ${TAPE_HEIGHT}`}
      fontFamily="monospace"
    >
      {cells.map((text, index) => {
        const read = index < position;
        const here = at;
        const cell = cellWidth(text);
        at += cell;
        return (
          <g key={index} transform={`translate(${here} 6)`}>
            <rect
              width={cell}
              height={CELL_HEIGHT}
              fill={read ? 'var(--surface-2)' : 'var(--surface)'}
              stroke={index === position ? color : 'var(--line-strong)'}
              strokeWidth={index === position ? 2 : 1}
            />
            <text
              x={cell / 2}
              y={CELL_HEIGHT / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fill={read ? 'var(--ink-muted)' : 'var(--ink)'}
            >
              {text}
            </text>
            {index === position ? (
              <polygon
                transform={`translate(${cell / 2} ${CELL_HEIGHT + 2})`}
                points="0,0 -6,10 6,10"
                fill={color}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

const stackCellWidth = (entry: GrammarStackEntry, label: (state: number) => string) =>
  Math.max(cellWidth(entry.symbol), entry.state === null ? 0 : cellWidth(label(entry.state)));

export function parserStackSize(
  steps: readonly { state: GrammarParserStep }[],
  label: (state: number) => string,
) {
  let width = MIN_CELL;
  for (const { state } of steps) {
    const here = state.stack.reduce((sum, entry) => sum + stackCellWidth(entry, label), 12);
    if (here > width) width = here;
  }
  return { width, height: STACK_HEIGHT };
}

/** The stack, lying on its side: the bottom is on the left and the top glows on the right. */
export function ParserStack({
  stack,
  label = String,
  width,
  y = 0,
}: {
  stack: readonly GrammarStackEntry[];
  /** The name of an LR state. */
  label?: (state: number) => string;
  /** A fixed size for exports. Otherwise it fits the stack. */
  width?: number;
  y?: number;
}) {
  const needed = stack.reduce((sum, entry) => sum + stackCellWidth(entry, label), 12);
  const drawn = width ?? needed;
  let at = 4;
  return (
    <svg
      role="img"
      aria-label={`Stack, from bottom to top: ${stack.map(({ symbol }) => symbol).join(' ')}`}
      y={y}
      width={drawn}
      height={STACK_HEIGHT}
      viewBox={`0 0 ${drawn} ${STACK_HEIGHT}`}
      fontFamily="monospace"
    >
      {stack.map((entry, index) => {
        const here = at;
        const cell = stackCellWidth(entry, label);
        at += cell;
        const isTop = index === stack.length - 1;
        return (
          <g key={index} transform={`translate(${here} 8)`}>
            {isTop ? (
              <rect
                x={-3}
                y={-3}
                width={cell + 6}
                height={CELL_HEIGHT + 6}
                rx={5}
                fill="var(--accent)"
                fillOpacity={0.22}
              />
            ) : null}
            <rect
              width={cell}
              height={CELL_HEIGHT}
              fill="var(--surface)"
              stroke={isTop ? 'var(--accent)' : 'var(--line-strong)'}
              strokeWidth={isTop ? 2 : 1}
            />
            <text
              x={cell / 2}
              y={CELL_HEIGHT / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontWeight={isTop ? 600 : 400}
              fill="var(--ink)"
            >
              {entry.symbol}
            </text>
            {entry.state !== null ? (
              <text
                x={cell / 2}
                y={CELL_HEIGHT + 13}
                textAnchor="middle"
                fontSize={11}
                fill="var(--ink-muted)"
              >
                {label(entry.state)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export interface MoveRow {
  stack: string;
  input: string;
  action: string;
}

/** The textbook's table of moves, one row per step of the run. */
export function moveRows(
  run: Pick<GrammarParserRun, 'tokens' | 'trace'>,
  label: (state: number) => string = String,
): MoveRow[] {
  return run.trace.map(({ state }) => ({
    stack: state.stack
      .map((entry) =>
        entry.state === null
          ? entry.symbol
          : entry.symbol === GRAMMAR_END_MARKER
            ? label(entry.state)
            : `${entry.symbol} ${label(entry.state)}`,
      )
      .join(' '),
    input: [...run.tokens.slice(state.position), GRAMMAR_END_MARKER].join(' '),
    action: state.action,
  }));
}

/** Shows the recent moves up to the current step. */
export function MovesTable({
  rows,
  current,
  shown = 8,
}: {
  rows: readonly MoveRow[];
  current: number;
  shown?: number;
}) {
  const from = Math.max(0, current - shown + 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">
        <caption className="sr-only">The parser&apos;s moves so far</caption>
        <thead>
          <tr>
            {['Stack', 'Input', 'Action'].map((header) => (
              <th
                key={header}
                scope="col"
                className="border border-line bg-surface-2 px-2 py-1 text-left font-medium"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(from, current + 1).map((row, offset) => (
            <tr
              key={from + offset}
              className={from + offset === current ? 'bg-accent-soft font-semibold' : ''}
            >
              <td className="border border-line px-2 py-1 whitespace-pre">{row.stack}</td>
              <td className="border border-line px-2 py-1 text-right whitespace-pre">
                {row.input}
              </td>
              <td className="border border-line px-2 py-1 whitespace-pre">{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
