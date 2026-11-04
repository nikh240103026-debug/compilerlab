import type { Ll1Table as Ll1TableData, Ll1TableStep, TraceStep } from '@compilerlab/engine';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { GrammarField, GrammarResult, ProblemList } from './grammar-field';
import { DANGLING_ELSE, EXPRESSION, EXPRESSION_LL, TWO_C } from './presets';
import { ll1Headers, ll1Rows } from './table-rows';
import {
  measureParsingTable,
  ParsingSvgTable,
  ParsingTable,
  SET_HEADERS,
  setRows,
  type CellTone,
} from './tables';

const PRESETS = [EXPRESSION_LL, EXPRESSION, DANGLING_ELSE, TWO_C];

/** Column 0 of the drawn table is the row header, so data columns are one further along. */
function toneFor(state: Ll1TableStep) {
  const added = new Set(state.added.map(({ row, column }) => `${row}:${column}`));
  return (row: number, column: number): CellTone => {
    if (column === 0) return null;
    if ((state.cells[row]?.[column - 1]?.length ?? 0) > 1) return 'conflict';
    return added.has(`${row}:${column - 1}`) ? 'added' : null;
  };
}

function Result({ table, onUsed }: { table: Ll1TableData; onUsed: (() => void) | undefined }) {
  const [showSynch, setShowSynch] = useState(false);
  const headers = ll1Headers(table);
  const rowsAt = useCallback(
    (state: Ll1TableStep) => ll1Rows(table, state.cells, showSynch),
    [table, showSynch],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<Ll1TableStep>) => (
      <ParsingTable
        caption="The LL(1) parsing table so far"
        headers={headers}
        rows={rowsAt(state)}
        tone={toneFor(state)}
      />
    ),
    [headers, rowsAt],
  );

  const size = measureParsingTable([headers, ...ll1Rows(table, table.cells, showSynch)]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={table.isLl1 ? 'success' : 'danger'}>
          {table.isLl1
            ? 'This grammar is LL(1)'
            : `Not LL(1): ${table.conflicts.length} conflict${table.conflicts.length === 1 ? '' : 's'}`}
        </Badge>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showSynch}
            onChange={(event) => setShowSynch(event.target.checked)}
          />
          Show the synch entries panic mode uses
        </label>
      </div>
      <Player
        trace={table.trace}
        name="ll1-table"
        renderStage={renderStage}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          width: size.width,
          height: size.height,
          render: ({ state }) => (
            <ParsingSvgTable rows={[headers, ...rowsAt(state)]} tone={toneFor(state)} />
          ),
        }}
      />
      <ProblemList
        label="Conflicts"
        problems={table.conflicts.map((conflict) => ({
          key: `${conflict.row}:${conflict.column}`,
          message: conflict.message,
        }))}
        question={(message) =>
          `My LL(1) table has this conflict: ${message} Why, and how do I fix it?`
        }
      />
      <div>
        <p className="mb-1 text-sm font-semibold">The sets the table is built from</p>
        <ParsingTable
          caption="Nullable, FIRST and FOLLOW for each nonterminal"
          headers={SET_HEADERS}
          rows={setRows(table.nullable, table.first, table.follow)}
        />
      </div>
    </div>
  );
}

export default function Ll1Table({ initial, onUsed }: VisualizerProps) {
  const [text, setText] = useState(initial?.grammar ?? EXPRESSION_LL.grammar);
  const settled = useDebouncedValue(text, 400);
  const { data } = useEngineJob('ll1Table', { grammar: settled });

  return (
    <div className="space-y-3">
      <GrammarField value={text} onChange={setText} presets={PRESETS} />
      <GrammarResult result={data} grammar={settled}>
        {(table) => <Result key={settled} table={table} onUsed={onUsed} />}
      </GrammarResult>
    </div>
  );
}
