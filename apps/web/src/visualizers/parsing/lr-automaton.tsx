import {
  lrFormatAction,
  type LrBuildStep,
  type LrTableKind,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { GrammarField, GrammarResult, PrecedenceField, ProblemList } from './grammar-field';
import type { LrAutomatonOutput } from './jobs';
import { LrAutomatonSvg, LrFlowGraph, type LrHighlights } from './lr-graph';
import { layoutItemSets } from './lr-layout';
import {
  AMBIGUOUS_EXPRESSION,
  DANGLING_ELSE,
  EXPRESSION,
  NOT_LALR,
  NOT_SLR,
  TWO_C,
  type GrammarPreset,
} from './presets';
import { lrHeaders, lrRows, numberedProductions } from './table-rows';
import { measureParsingTable, ParsingSvgTable, ParsingTable, type CellTone } from './tables';

const PRESETS = [EXPRESSION, TWO_C, NOT_SLR, NOT_LALR, DANGLING_ELSE, AMBIGUOUS_EXPRESSION];
/** Past this many boxes a canvas helps nobody, so the table and the state list stand alone. */
const MAX_GRAPH_STATES = 150;
const KINDS: readonly { value: LrTableKind; label: string }[] = [
  { value: 'lr0', label: 'LR(0)' },
  { value: 'slr', label: 'SLR(1)' },
  { value: 'lr1', label: 'LR(1)' },
  { value: 'lalr', label: 'LALR(1)' },
];
const GRAPH_GAP = 16;

type View = 'steps' | 'finished';

/** A deep link's state or conflict, such as initial.conflict = "4:else". */
function parseConflict(text: string | undefined): { state: number; terminal: string } | null {
  if (!text) return null;
  const split = text.indexOf(':');
  const state = Number(text.slice(0, split));
  if (split < 1 || !Number.isInteger(state)) return null;
  return { state, terminal: text.slice(split + 1) };
}

function parseState(text: string | undefined): number | null {
  if (text === undefined || text === '') return null;
  const state = Number(text);
  return Number.isInteger(state) ? state : null;
}

function Result({
  output,
  view,
  startState,
  startConflict,
  onUsed,
}: {
  output: LrAutomatonOutput;
  view: View;
  startState: number | null;
  startConflict: { state: number; terminal: string } | null;
  onUsed: (() => void) | undefined;
}) {
  const { table, trace } = output;
  const { automaton } = table;
  const stateCount = automaton.states.length;
  const drawGraph = stateCount <= MAX_GRAPH_STATES;
  const stateSelectId = useId();

  const finalStep = (trace.at(-1) as TraceStep<LrBuildStep>).state;
  const shownTrace = useMemo(() => (view === 'finished' ? trace.slice(-1) : trace), [trace, view]);
  const [step, setStep] = useState<LrBuildStep>(shownTrace[0]?.state ?? finalStep);
  const onStep = useCallback((next: TraceStep<LrBuildStep>) => setStep(next.state), []);

  const validState = (state: number | null) =>
    state !== null && state >= 0 && state < stateCount ? state : null;
  const [selected, setSelected] = useState<number | null>(
    validState(startConflict?.state ?? startState),
  );
  const [conflictKey, setConflictKey] = useState<string | null>(
    startConflict ? `${startConflict.state}:${startConflict.terminal}` : null,
  );

  const layout = useMemo(() => layoutItemSets(automaton), [automaton]);
  const headers = useMemo(() => lrHeaders(table), [table]);
  const rows = useMemo(() => lrRows(table), [table]);
  const conflictStates = useMemo(() => new Set(table.conflicts.map(({ state }) => state)), [table]);
  const highlights = useMemo<LrHighlights>(
    () => ({ selected, conflicts: conflictStates }),
    [selected, conflictStates],
  );
  const conflictColumn = useMemo(() => {
    if (!conflictKey) return null;
    const conflict = table.conflicts.find(
      (item) => `${item.state}:${item.terminal}` === conflictKey,
    );
    return conflict
      ? { state: conflict.state, column: table.terminals.indexOf(conflict.terminal) + 1 }
      : null;
  }, [conflictKey, table]);

  const toneFor = useCallback(
    (state: LrBuildStep) =>
      (row: number, column: number): CellTone => {
        if (conflictColumn?.state === row && conflictColumn.column === column) return 'active';
        const isAction = column >= 1 && column <= table.terminals.length;
        if (isAction && (table.cells[row]?.[column - 1]?.length ?? 0) > 1) return 'conflict';
        if (column === 0 && (state.activeState === row || selected === row)) return 'active';
        return null;
      },
    [conflictColumn, selected, table],
  );

  const renderStage = useCallback(
    ({ state }: TraceStep<LrBuildStep>) =>
      state.filledRows > 0 ? (
        <ParsingTable
          caption="The ACTION and GOTO table so far"
          headers={headers}
          rows={rows.slice(0, state.filledRows)}
          tone={toneFor(state)}
          onRowClick={(row) => setSelected(row)}
        />
      ) : (
        <p className="text-sm text-ink-muted">
          {state.stage === 'collection'
            ? `Building the automaton above: ${state.stateCount} of ${stateCount} states so far. The table comes next.`
            : 'Each state of the automaton gets one row in this table.'}
        </p>
      ),
    [headers, rows, stateCount, toneFor],
  );

  const tableSize = measureParsingTable([headers, ...rows]);
  const graphWidth = drawGraph ? layout.width : 0;
  const graphHeight = drawGraph ? layout.height + GRAPH_GAP : 0;
  const selectedState = selected === null ? null : automaton.states[selected];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>
          {stateCount} state{stateCount === 1 ? '' : 's'}
        </Badge>
        {table.kind === 'lalr' ? (
          <Badge>merged from {automaton.canonicalStateCount} canonical LR(1) states</Badge>
        ) : null}
        {table.conflicts.length === 0 ? (
          <Badge tone="success">No conflicts</Badge>
        ) : (
          <Badge tone="danger">
            {table.shiftReduceCount} shift/reduce, {table.reduceReduceCount} reduce/reduce
          </Badge>
        )}
      </div>

      {drawGraph ? (
        <LrFlowGraph
          automaton={automaton}
          layout={layout}
          step={step}
          highlights={highlights}
          onSelect={setSelected}
        />
      ) : (
        <p className="rounded-md bg-surface-2 p-3 text-sm">
          This automaton has {stateCount} states, too many to draw clearly. Use the table and the
          state list below.
        </p>
      )}

      <Player
        key={view}
        trace={shownTrace}
        name="lr-automaton"
        renderStage={renderStage}
        onStep={onStep}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          width: Math.max(graphWidth, tableSize.width),
          height: graphHeight + tableSize.height,
          render: ({ state }) => (
            <>
              {drawGraph ? (
                <LrAutomatonSvg
                  automaton={automaton}
                  layout={layout}
                  step={state}
                  highlights={highlights}
                />
              ) : null}
              <ParsingSvgTable
                y={graphHeight}
                rows={[headers, ...rows.slice(0, state.filledRows)]}
                tone={toneFor(state)}
              />
            </>
          ),
        }}
      />

      <ProblemList
        label="Conflicts"
        problems={table.conflicts.map((conflict) => {
          const key = `${conflict.state}:${conflict.terminal}`;
          return {
            key,
            message: conflict.message,
            detail: (
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs whitespace-pre-wrap text-ink-muted">
                  {conflict.items.join('    ')}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={conflictKey === key}
                  onClick={() => {
                    setSelected(conflict.state);
                    setConflictKey(key);
                  }}
                >
                  Show in the table
                </Button>
              </div>
            ),
          };
        })}
        question={(message) =>
          `My LR parser has this conflict: ${message} Why, and how do I fix it?`
        }
      />

      {table.resolutions.length > 0 ? (
        <div className="rounded-md bg-surface-2 p-2 text-sm">
          <p className="font-medium">Settled by precedence</p>
          <ul className="mt-1 space-y-0.5 text-ink-muted">
            {table.resolutions.map((item, index) => (
              <li key={index}>
                State {automaton.states[item.state]?.label} on {item.terminal}: {item.winner}.{' '}
                {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={stateSelectId} className="mb-1 block text-sm font-medium">
            Look at a state
          </label>
          <NativeSelect
            id={stateSelectId}
            className="font-mono"
            value={selected === null ? '' : String(selected)}
            onChange={(event) =>
              setSelected(event.target.value === '' ? null : Number(event.target.value))
            }
          >
            <option value="">None</option>
            {automaton.states.map((state) => (
              <option key={state.id} value={state.id}>
                State {state.label}
                {conflictStates.has(state.id) ? ' (conflict)' : ''}
              </option>
            ))}
          </NativeSelect>
          {selectedState ? (
            <div className="mt-2 space-y-1 font-mono text-[0.8125rem]">
              <ul aria-label={`The items in state ${selectedState.label}`}>
                {(layout.lines.get(selectedState.id) ?? []).map((line) => (
                  <li key={line.text} className={line.kernel ? 'font-semibold' : 'text-ink-muted'}>
                    {line.text}
                  </li>
                ))}
              </ul>
              {selectedState.sources.length > 1 ? (
                <p className="font-sans text-xs text-ink-muted">
                  Merged from canonical LR(1) states {selectedState.sources.join(', ')}.
                </p>
              ) : null}
              <ul
                aria-label={`What state ${selectedState.label} does on each terminal`}
                className="font-sans text-xs text-ink-muted"
              >
                {table.terminals.map((terminal, column) => {
                  const cell = table.cells[selectedState.id]?.[column] ?? [];
                  return cell.length > 0 ? (
                    <li key={terminal}>
                      On <span className="font-mono">{terminal}</span>:{' '}
                      <span className="font-mono">
                        {cell.map((action) => lrFormatAction(table, action)).join(' or ')}
                      </span>
                    </li>
                  ) : null;
                })}
              </ul>
            </div>
          ) : null}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Production numbers, for the r entries</p>
          <ol className="font-mono text-[0.8125rem]">
            {numberedProductions(table.grammar).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/**
 * The LR automaton and its table. `initial` can set everything, so other pages can link straight
 * to a particular spot:
 *
 *   grammar     The grammar text.
 *   kind        'lr0', 'slr', 'lr1' or 'lalr'. Defaults to 'slr'.
 *   precedence  %left, %right and %nonassoc lines.
 *   state       A state number to select.
 *   conflict    A conflict to show, as "state:terminal", such as "4:else".
 *
 * A link with a state or a conflict opens on the finished automaton, not at the first step.
 * /visualize/lr-automaton?grammar=...&kind=lalr&conflict=4:else works the same way.
 */
export default function LrAutomaton({ initial, onUsed }: VisualizerProps) {
  const startConflict = parseConflict(initial?.conflict);
  const startState = parseState(initial?.state);
  const deepLinked = startConflict !== null || startState !== null;
  const startKind = KINDS.find(({ value }) => value === initial?.kind)?.value ?? 'slr';

  const [text, setText] = useState(initial?.grammar ?? NOT_SLR.grammar);
  const [kind, setKind] = useState<LrTableKind>(startKind);
  const [view, setView] = useState<View>(deepLinked ? 'finished' : 'steps');
  const [precedence, setPrecedence] = useState(initial?.precedence ?? '');
  const settled = useDebouncedValue(text, 400);
  const settledPrecedence = useDebouncedValue(precedence, 400);
  const input = useMemo(
    () => ({ grammar: settled, kind, precedence: settledPrecedence }),
    [settled, kind, settledPrecedence],
  );
  const { data } = useEngineJob('lrAutomaton', input);

  const pickPreset = (preset: GrammarPreset) => {
    setText(preset.grammar);
    setPrecedence(preset.precedence ?? '');
  };

  // A deep link's state only means something for the grammar and kind it was made for.
  const untouched = settled === (initial?.grammar ?? NOT_SLR.grammar) && kind === startKind;

  return (
    <div className="space-y-3">
      <div className="@container">
        <div className="grid gap-3 @2xl:grid-cols-2">
          <GrammarField value={text} onChange={setText} presets={PRESETS} onPreset={pickPreset} />
          <PrecedenceField value={precedence} onChange={setPrecedence} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="lr-kind"
          legend="Which kind of LR table to build"
          value={kind}
          options={KINDS}
          onChange={setKind}
        />
        <Segmented
          name="lr-view"
          legend="How to show the automaton"
          value={view}
          options={[
            { value: 'steps', label: 'Step through it' },
            { value: 'finished', label: 'Finished' },
          ]}
          onChange={setView}
        />
      </div>
      <GrammarResult result={data} grammar={settled} precedence={settledPrecedence}>
        {(output) => (
          <Result
            key={`${settled}\n${kind}\n${settledPrecedence}`}
            output={output}
            view={view}
            startState={untouched ? startState : null}
            startConflict={untouched ? startConflict : null}
            onUsed={onUsed}
          />
        )}
      </GrammarResult>
    </div>
  );
}
