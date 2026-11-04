import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { useEngineJob } from '@/visualizers/engine/use-engine';
import { JobResult } from '@/visualizers/shared';
import type { TraceModel } from '../question-model';
import { simulateTraceMoves, traceMoveLabel } from '../trace-moves';
import {
  GrammarBlock,
  PartMark,
  tableCellClass,
  tableHeaderClass,
  type AnswerInputProps,
} from './shared';

const PARSER_NAMES: Readonly<Record<TraceModel['parser'], string>> = {
  ll1: 'table-driven LL(1)',
  lr0: 'LR(0)',
  slr: 'SLR(1)',
  lalr: 'LALR(1)',
  lr1: 'canonical LR(1)',
};

function TraceEditor({
  model,
  value,
  onChange,
  disabled,
  grade,
}: Omit<AnswerInputProps<'trace'>, 'question'> & { model: TraceModel }) {
  const moves = useMemo(() => value?.moves ?? [], [value]);
  const rows = useMemo(() => simulateTraceMoves(model, moves), [model, moves]);
  const [choice, setChoice] = useState(model.options[0]?.value ?? '');
  const selectId = useId();
  const latest = rows.at(-1);

  const setMoves = (next: string[]) => onChange({ type: 'trace', moves: next });

  return (
    <>
      <p className="mb-1.5 text-sm text-ink-muted">
        {disabled
          ? `Your moves, for a ${PARSER_NAMES[model.parser]} parser.`
          : `Give the moves of a ${PARSER_NAMES[model.parser]} parser, one at a time. The table plays out each move you add, whether or not it is right.`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[0.8125rem]">
          <caption className="sr-only">Your trace: the stack, the input and each move</caption>
          <thead>
            <tr>
              {['Step', 'Stack', 'Input', 'Move'].map((header) => (
                <th key={header} scope="col" className={tableHeaderClass}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td className={`${tableCellClass} px-2`}>{index + 1}</td>
                <td className={`${tableCellClass} px-2 whitespace-pre`}>{row.stack.join(' ')}</td>
                <td className={`${tableCellClass} px-2 whitespace-pre`}>{row.input.join(' ')}</td>
                <td className={`${tableCellClass} px-2`}>
                  {row.move === null ? (
                    <span className="text-ink-muted">{disabled ? 'End' : 'Next move below'}</span>
                  ) : (
                    <>
                      {traceMoveLabel(row.move)}
                      {row.problem ? (
                        <span className="block font-sans text-xs text-warning">{row.problem}</span>
                      ) : null}
                      <span className="block">
                        <PartMark grade={grade} part={index} showExpected={false} />
                      </span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice) setMoves([...moves, choice]);
          }}
        >
          <div className="min-w-56 flex-1">
            <label htmlFor={selectId} className="mb-1 block text-sm font-medium">
              Next move
            </label>
            <NativeSelect
              id={selectId}
              value={choice}
              className="font-mono text-[0.8125rem]"
              onChange={(event) => setChoice(event.target.value)}
            >
              {model.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button size="md" type="submit">
            Add this move
          </Button>
          <Button
            size="md"
            variant="ghost"
            disabled={moves.length === 0}
            onClick={() => setMoves(moves.slice(0, -1))}
          >
            Undo
          </Button>
          <Button
            size="md"
            variant="ghost"
            disabled={moves.length === 0}
            onClick={() => setMoves([])}
          >
            Clear
          </Button>
        </form>
      ) : null}
      {!disabled && latest ? (
        <p aria-live="polite" className="sr-only">
          {moves.length} moves. Stack: {latest.stack.join(' ')}. Input: {latest.input.join(' ')}.
        </p>
      ) : null}
    </>
  );
}

export function TraceInput({
  question,
  value,
  onChange,
  disabled,
  grade,
}: AnswerInputProps<'trace'>) {
  const input = useMemo(() => ({ question }), [question]);
  const { data } = useEngineJob('questionModel', input);
  return (
    <div>
      <GrammarBlock grammar={question.grammar} />
      <p className="mb-3 text-sm">
        <span className="font-medium">Input: </span>
        <code className="font-mono">{question.input.trim() || 'the empty string'}</code>
      </p>
      <JobResult result={data}>
        {(model) =>
          model?.kind === 'trace' ? (
            <TraceEditor
              model={model}
              value={value}
              onChange={onChange}
              disabled={disabled}
              grade={grade}
            />
          ) : null
        }
      </JobResult>
    </div>
  );
}
