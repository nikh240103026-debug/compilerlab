import { formatChar, type SimulationState } from '@compilerlab/engine';

const CELL = 30;
const HEIGHT = 74;

export function tapeSize(length: number) {
  return { width: Math.max(1, length) * CELL + 8, height: HEIGHT };
}

const STATUS_COLOR = {
  running: 'var(--accent)',
  accepted: 'var(--success)',
  rejected: 'var(--danger)',
};

/** The input drawn as a tape, with a marker at the next character to read. */
export function Tape({ state, y = 0 }: { state: SimulationState; y?: number }) {
  const { width } = tapeSize(state.input.length);
  const color = STATUS_COLOR[state.status];
  return (
    <svg
      role="img"
      aria-label={`Input: ${state.input.join('') || 'the empty string'}. ${state.position} characters read.`}
      y={y}
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      fontFamily="monospace"
    >
      {state.input.length === 0 ? (
        <text x={4} y={32} fontSize={13} fill="var(--ink-muted)">
          (empty input)
        </text>
      ) : null}
      {state.input.map((char, index) => {
        const read = index < state.position;
        return (
          <g key={index} transform={`translate(${4 + index * CELL} 14)`}>
            <rect
              width={CELL}
              height={CELL}
              fill={read ? 'var(--surface-2)' : 'var(--surface)'}
              stroke="var(--line-strong)"
            />
            <text
              x={CELL / 2}
              y={CELL / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={14}
              fill={read ? 'var(--ink-muted)' : 'var(--ink)'}
            >
              {formatChar(char.codePointAt(0) as number)}
            </text>
          </g>
        );
      })}
      <polygon
        transform={`translate(${4 + state.position * CELL} 50)`}
        points="0,0 -6,10 6,10"
        fill={color}
      />
    </svg>
  );
}
