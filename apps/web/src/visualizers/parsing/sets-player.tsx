import type { GrammarSetsState, Trace, TraceStep } from '@compilerlab/engine';
import { useCallback } from 'react';
import { Player } from '../player/player';
import {
  measureParsingTable,
  ParsingSvgTable,
  ParsingTable,
  SET_HEADERS,
  setRows,
  type CellTone,
} from './tables';

const PHASE_COLUMN = { nullable: 1, first: 2, follow: 3, done: -1 } as const;

function toneFor(state: GrammarSetsState) {
  return (row: number, column: number): CellTone => {
    if (state.symbol === null || state.first[row]?.symbol !== state.symbol) return null;
    return column === PHASE_COLUMN[state.phase] ? 'added' : null;
  };
}

const rowsOf = (state: GrammarSetsState) => setRows(state.nullable, state.first, state.follow);

/** Plays nullable, FIRST and FOLLOW being computed, with each new item marked. */
export function SetsPlayer({
  trace,
  name,
  onUsed,
}: {
  trace: Trace<GrammarSetsState>;
  name: string;
  onUsed: (() => void) | undefined;
}) {
  const renderStage = useCallback(
    ({ state }: TraceStep<GrammarSetsState>) => (
      <ParsingTable
        caption="Nullable, FIRST and FOLLOW for each nonterminal"
        headers={SET_HEADERS}
        rows={rowsOf(state)}
        tone={toneFor(state)}
      />
    ),
    [],
  );
  const last = (trace.at(-1) as TraceStep<GrammarSetsState>).state;
  const size = measureParsingTable([SET_HEADERS, ...rowsOf(last)]);
  return (
    <Player
      trace={trace}
      name={name}
      renderStage={renderStage}
      {...(onUsed ? { onInteract: onUsed } : {})}
      stageExport={{
        width: size.width,
        height: size.height,
        render: ({ state }) => (
          <ParsingSvgTable rows={[SET_HEADERS, ...rowsOf(state)]} tone={toneFor(state)} />
        ),
      }}
    />
  );
}
