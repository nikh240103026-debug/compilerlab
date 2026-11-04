import type { GradeResult } from '@compilerlab/shared';
import { useId, useMemo, type ReactNode } from 'react';
import { Input, NativeSelect } from '@/components/ui/field';
import { useEngineJob } from '@/visualizers/engine/use-engine';
import { JobResult } from '@/visualizers/shared';
import type { FirstFollowModel, Ll1Model, LrModel, TableSpec } from '../question-model';
import {
  GrammarBlock,
  PartMark,
  tableCellClass,
  tableHeaderClass,
  type AnswerInputProps,
} from './shared';

interface GridProps {
  cells: Readonly<Record<string, string>>;
  setCell: (key: string, text: string) => void;
  disabled: boolean;
  grade: GradeResult | null | undefined;
}

const cellInputClass = 'h-8 min-w-16 font-mono text-[0.8125rem]';

function TextCell({
  id,
  label,
  grid,
  wide = false,
}: {
  id: string;
  label: string;
  grid: GridProps;
  wide?: boolean;
}) {
  return (
    <td className={tableCellClass}>
      <Input
        aria-label={label}
        value={grid.cells[id] ?? ''}
        disabled={grid.disabled}
        spellCheck={false}
        autoComplete="off"
        className={wide ? `${cellInputClass} min-w-32` : cellInputClass}
        onChange={(event) => grid.setCell(id, event.target.value)}
      />
      <PartMark grade={grid.grade} part={id} />
    </td>
  );
}

function Headers({ first, columns }: { first: string; columns: readonly ReactNode[] }) {
  return (
    <thead>
      <tr>
        <th scope="col" className={tableHeaderClass}>
          {first}
        </th>
        {columns.map((column, index) => (
          <th key={index} scope="col" className={tableHeaderClass}>
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function RowHeader({ children }: { children: ReactNode }) {
  return (
    <th scope="row" className={tableHeaderClass}>
      {children}
    </th>
  );
}

function FirstFollowGrid({ model, grid }: { model: FirstFollowModel; grid: GridProps }) {
  const name = (kind: 'first' | 'follow') => (kind === 'first' ? 'FIRST' : 'FOLLOW');
  return (
    <>
      <p className="mb-1.5 text-sm text-ink-muted">
        Write each set with spaces or commas between its items, such as id, ( or a b. Use ε (or eps)
        for the empty string and $ for the end marker.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Your {model.sets.map(name).join(' and ')} sets, one row for each nonterminal
          </caption>
          <Headers first="Symbol" columns={model.sets.map(name)} />
          <tbody>
            {model.nonterminals.map((symbol) => (
              <tr key={symbol}>
                <RowHeader>{symbol}</RowHeader>
                {model.sets.map((kind) => (
                  <TextCell
                    key={kind}
                    id={`${kind}:${symbol}`}
                    label={`${name(kind)}(${symbol})`}
                    grid={grid}
                    wide
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Ll1Grid({ model, grid }: { model: Ll1Model; grid: GridProps }) {
  return (
    <>
      <p className="mb-1.5 text-sm text-ink-muted">
        Choose the production for each cell of the table M. Leave a cell blank if it has none.
      </p>
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <caption className="sr-only">
            The LL(1) table, with nonterminals as rows and terminals as columns
          </caption>
          <Headers first="M" columns={model.columns} />
          <tbody>
            {model.rows.map((row, rowIndex) => (
              <tr key={row}>
                <RowHeader>{row}</RowHeader>
                {model.columns.map((column, columnIndex) => {
                  const id = `${rowIndex}:${columnIndex}`;
                  return (
                    <td key={column} className={tableCellClass}>
                      <NativeSelect
                        aria-label={`M[${row}, ${column}]`}
                        value={grid.cells[id] ?? ''}
                        disabled={grid.disabled}
                        className="h-8 w-32 px-1 font-mono text-[0.8125rem]"
                        onChange={(event) => grid.setCell(id, event.target.value)}
                      >
                        <option value="">Empty</option>
                        {model.productions.map((production) => (
                          <option key={production} value={production}>
                            {production}
                          </option>
                        ))}
                      </NativeSelect>
                      <PartMark grade={grid.grade} part={id} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LrGrid({ model, grid }: { model: LrModel; grid: GridProps }) {
  const columns = [...model.actionColumns, ...model.gotoColumns];
  const asking = model.given.some((row) => row.some((cell) => cell !== null));
  return (
    <>
      <p className="mb-1.5 text-sm text-ink-muted">
        Write a shift as s5, a reduction as r2 using the numbers below, and accept as acc. In the
        GOTO columns write just the state. Leave a cell blank if it has no entry.
        {asking ? ' The cells already filled in are given.' : ''}
      </p>
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium">Productions</p>
          <ol className="font-mono text-[0.8125rem]">
            {model.productions.map((production) => (
              <li key={production}>{production}</li>
            ))}
          </ol>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">The states and their items</summary>
          <ul className="mt-1 space-y-1 font-mono text-[0.8125rem]">
            {model.states.map((state) => (
              <li key={state.label}>
                <span className="font-semibold">State {state.label}:</span>{' '}
                {state.items.join(';  ')}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <caption className="sr-only">
            The ACTION and GOTO table, with states as rows, terminals and then nonterminals as
            columns
          </caption>
          <Headers first="State" columns={columns} />
          <tbody>
            {model.rows.map((row, rowIndex) => (
              <tr key={row}>
                <RowHeader>{row}</RowHeader>
                {columns.map((column, columnIndex) => {
                  const given = model.given[rowIndex]?.[columnIndex] ?? null;
                  if (given !== null) {
                    return (
                      <td
                        key={columnIndex}
                        className={`${tableCellClass} px-2 py-1 font-mono text-[0.8125rem]`}
                      >
                        {given}
                      </td>
                    );
                  }
                  const isAction = columnIndex < model.actionColumns.length;
                  return (
                    <TextCell
                      key={columnIndex}
                      id={`${rowIndex}:${columnIndex}`}
                      label={`${isAction ? 'ACTION' : 'GOTO'}[${row}, ${column}]`}
                      grid={grid}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ValuesGrid({
  spec,
  grid,
}: {
  spec: Extract<TableSpec, { kind: 'values' }>;
  grid: GridProps;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse">
        <caption className="sr-only">The table to complete</caption>
        <Headers first="" columns={spec.columns} />
        <tbody>
          {spec.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <RowHeader>{row}</RowHeader>
              {spec.columns.map((column, columnIndex) => {
                if (spec.given?.[rowIndex]?.[columnIndex]) {
                  return (
                    <td
                      key={columnIndex}
                      className={`${tableCellClass} px-2 py-1 font-mono text-[0.8125rem]`}
                    >
                      {spec.answers[rowIndex]?.[columnIndex]}
                    </td>
                  );
                }
                return (
                  <TextCell
                    key={columnIndex}
                    id={`${rowIndex}:${columnIndex}`}
                    label={`${row}, ${column}`}
                    grid={grid}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableInput({
  question,
  value,
  onChange,
  disabled,
  grade,
}: AnswerInputProps<'table'>) {
  const spec = question.table;
  const headingId = useId();
  const needsEngine = spec.kind !== 'values';
  const input = useMemo(() => (needsEngine ? { question } : null), [needsEngine, question]);
  const { data } = useEngineJob('questionModel', input);

  const cells = value?.cells ?? {};
  const grid: GridProps = {
    cells,
    disabled,
    grade,
    setCell: (key, text) => onChange({ type: 'table', cells: { ...cells, [key]: text } }),
  };

  return (
    <div aria-labelledby={headingId} role="group">
      <p id={headingId} className="sr-only">
        Table to complete
      </p>
      {spec.kind !== 'values' ? <GrammarBlock grammar={spec.grammar} /> : null}
      {spec.kind === 'values' ? (
        <ValuesGrid spec={spec} grid={grid} />
      ) : (
        <JobResult result={data}>
          {(model) => {
            if (model?.kind === 'first-follow')
              return <FirstFollowGrid model={model} grid={grid} />;
            if (model?.kind === 'll1') return <Ll1Grid model={model} grid={grid} />;
            if (model?.kind === 'lr') return <LrGrid model={model} grid={grid} />;
            return null;
          }}
        </JobResult>
      )}
    </div>
  );
}
