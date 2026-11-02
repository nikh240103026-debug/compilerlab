import {
  formatChar,
  SENTINEL,
  type BufferPointer,
  type InputBufferState,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useId, useState } from 'react';
import { Input, NativeSelect } from '@/components/ui/field';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import { Player } from './player/player';
import { JobResult, type VisualizerProps } from './shared';

const CELL = 32;
const ROW_GAP = 84;
const LEFT = 76;
const TOP = 28;
const STAGE_HEIGHT = TOP + ROW_GAP * 2 + 46;

function stageWidth(bufferSize: number) {
  return LEFT + (bufferSize + 1) * CELL + 24;
}

const pointerX = (pointer: BufferPointer) => LEFT + pointer.index * CELL + CELL / 2;
const rowY = (buffer: number) => TOP + buffer * ROW_GAP;

function Pointer({
  pointer,
  label,
  above,
  color,
}: {
  pointer: BufferPointer;
  label: string;
  above: boolean;
  color: string;
}) {
  const x = pointerX(pointer);
  const y = rowY(pointer.buffer);
  return above ? (
    <g fill={color}>
      <polygon points={`${x},${y - 2} ${x - 5},${y - 10} ${x + 5},${y - 10}`} />
      <text x={x} y={y - 13} textAnchor="middle" fontSize={10}>
        {label}
      </text>
    </g>
  ) : (
    <g fill={color}>
      <polygon
        points={`${x},${y + CELL + 2} ${x - 5},${y + CELL + 10} ${x + 5},${y + CELL + 10}`}
      />
      <text x={x} y={y + CELL + 21} textAnchor="middle" fontSize={10}>
        {label}
      </text>
    </g>
  );
}

function BufferStage({ state, bufferSize }: { state: InputBufferState; bufferSize: number }) {
  const width = stageWidth(bufferSize);
  return (
    <svg
      role="img"
      aria-label={`Two input buffers. The current lexeme is "${state.lexeme}".`}
      viewBox={`0 0 ${width} ${STAGE_HEIGHT}`}
      width={width}
      height={STAGE_HEIGHT}
      fontFamily="monospace"
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      {state.buffers.map((buffer, bufferIndex) => (
        <g key={bufferIndex}>
          <text
            x={LEFT - 10}
            y={rowY(bufferIndex) + CELL / 2}
            textAnchor="end"
            dominantBaseline="central"
            fontSize={11}
            fill="var(--ink-muted)"
          >
            Buffer {bufferIndex + 1}
          </text>
          {Array.from({ length: bufferSize + 1 }, (_, index) => {
            const char = buffer[index];
            const isSentinel = char === SENTINEL;
            return (
              <g key={index} transform={`translate(${LEFT + index * CELL} ${rowY(bufferIndex)})`}>
                <rect
                  width={CELL}
                  height={CELL}
                  fill={isSentinel ? 'var(--accent-soft)' : 'var(--surface)'}
                  stroke="var(--line-strong)"
                />
                {char ? (
                  <text
                    x={CELL / 2}
                    y={CELL / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={isSentinel ? 12 : 14}
                    fill={isSentinel ? 'var(--accent)' : 'var(--ink)'}
                  >
                    {isSentinel ? 'eof' : formatChar(char.codePointAt(0) as number)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      ))}
      <Pointer pointer={state.lexemeBegin} label="lexemeBegin" above color="var(--info)" />
      <Pointer pointer={state.forward} label="forward" above={false} color="var(--accent)" />
      <text x={LEFT} y={STAGE_HEIGHT - 8} fontSize={11} fill="var(--ink-muted)">
        {`${state.charactersRead} characters read, ${state.sentinelChecks} sentinel tests`}
      </text>
    </svg>
  );
}

export default function InputBuffer({ initial, onUsed }: VisualizerProps) {
  const [text, setText] = useState(initial?.text ?? 'position = initial + rate * 60');
  const [size, setSize] = useState(Number(initial?.size) || 8);
  const settled = useDebouncedValue(text);
  const { data } = useEngineJob('inputBuffer', { text: settled, size });
  const textId = useId();
  const sizeId = useId();

  const renderStage = useCallback(
    ({ state }: TraceStep<InputBufferState>) => (
      <div className="space-y-2">
        <BufferStage state={state} bufferSize={size} />
        <p className="text-xs text-ink-muted">
          Lexemes found:{' '}
          <span className="font-mono text-ink">{state.lexemes.join('  ') || 'none yet'}</span>
        </p>
      </div>
    ),
    [size],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor={textId} className="mb-1 block text-sm font-medium">
            Input
          </label>
          <Input
            id={textId}
            value={text}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={sizeId} className="mb-1 block text-sm font-medium">
            Buffer size
          </label>
          <NativeSelect
            id={sizeId}
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          >
            {[4, 8, 12, 16].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <JobResult result={data} source={settled}>
        {({ trace }) => (
          <Player
            key={`${settled}\n${size}`}
            trace={trace}
            name="input-buffer"
            renderStage={renderStage}
            {...(onUsed ? { onInteract: onUsed } : {})}
            stageExport={{
              width: stageWidth(size),
              height: STAGE_HEIGHT,
              render: ({ state }) => <BufferStage state={state} bufferSize={size} />,
            }}
          />
        )}
      </JobResult>
    </div>
  );
}
