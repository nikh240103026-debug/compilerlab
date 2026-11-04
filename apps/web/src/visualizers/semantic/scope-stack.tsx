import type {
  SymtabComparison,
  SymtabOrganization,
  SymtabOutcome,
  SymtabState,
  TraceStep,
} from '@compilerlab/engine';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAiVisualizerInput } from '@/ai/context-store';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import { DataTable, type VisualizerProps } from '../shared';
import type { SymtabFormat, SymtabOutput } from './jobs';
import { CodeField, ScrollRegion, SourceResult } from './playground';
import { SYMTAB_BLOCKS, SYMTAB_PRESETS, type SymtabPreset } from './presets';
import { SVG_NOTE_HEIGHT, SvgNotes, type SvgNote } from './source-view';
import { describeStructure, SymtabDrawing, symtabSize } from './symtab-views';

const ORGANIZATIONS: readonly { value: SymtabOrganization; label: string }[] = [
  { value: 'stack', label: 'Scoped stack' },
  { value: 'hash', label: 'Hash table' },
  { value: 'tree', label: 'Binary tree' },
];

const ORGANIZATION_NOTES: Record<SymtabOrganization, string> = {
  stack:
    'One small table per scope. A lookup walks from the innermost scope outward, so it can be slow when a name is far away, but closing a scope just drops its table.',
  hash: 'One table for the whole program. The hash picks a chain, so a lookup rarely compares more than a few names. Closing a scope has to remove its names from their chains, which is why each scope also lists what it declared.',
  tree: 'One search tree keyed by name, with each node keeping a list of that name’s declarations. A lookup takes about as many comparisons as the tree is deep, and the names stay in sorted order.',
};

const FORMATS: readonly { value: SymtabFormat; label: string }[] = [
  { value: 'blocks', label: 'Program' },
  { value: 'script', label: 'Operations' },
];

const FORMAT_HINTS: Record<SymtabFormat, string> = {
  blocks:
    'Braces open and close scopes. int x; declares x, and x; uses it, which looks it up. Each use in any other statement is a lookup too.',
  script: 'One per line: enter, exit, insert x int, lookup x.',
};

const OUTCOME_TEXT: Record<SymtabOutcome, string> = {
  ok: 'done',
  found: 'found',
  not_found: 'not declared',
  redeclared: 'declared twice',
  no_scope: 'no scope to close',
};

function outcomeNote(state: SymtabState): SvgNote {
  const text =
    state.found !== null
      ? `Found: ${state.found.name} : ${state.found.type}, at level ${state.found.level}`
      : state.removed.length > 0
        ? `Removed: ${state.removed.map((entry) => entry.name).join(', ')}`
        : OUTCOME_TEXT[state.outcome];
  const failed =
    state.outcome === 'not_found' || state.outcome === 'redeclared' || state.outcome === 'no_scope';
  return {
    text: `${text}.  ${state.comparisons} comparison${state.comparisons === 1 ? '' : 's'} here, ${state.totalComparisons} so far.`,
    bold: true,
    ...(failed ? { fill: 'var(--danger)' } : {}),
  };
}

/** The work each organization did, with the current operation's row kept in view. */
function CompareTable({
  comparison,
  current,
  organization,
}: {
  comparison: SymtabComparison;
  current: number;
  organization: SymtabOrganization;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    const row = element?.querySelector('tbody')?.children[current];
    if (!element || !row) return;
    const top = row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (top < 32 || top > element.clientHeight - 32) {
      element.scrollTop += top - element.clientHeight / 2;
    }
  }, [current]);

  const column = { stack: 2, hash: 3, tree: 4 }[organization];
  const { totals } = comparison;
  return (
    <div ref={box} className="max-h-56 overflow-y-auto">
      <DataTable
        caption="Comparisons each organization made per operation"
        headers={['Operation', 'Result', 'Stack', 'Hash', 'Tree']}
        activeRow={current}
        activeColumn={column}
        rows={[
          ...comparison.rows.map((row) => [
            row.operation,
            row.found ?? OUTCOME_TEXT[row.outcome],
            row.stack,
            row.hash,
            row.tree,
          ]),
          ['Total', '', totals.stack, totals.hash, totals.tree],
        ]}
      />
    </div>
  );
}

function Result({
  output,
  organization,
  onUsed,
}: {
  output: SymtabOutput;
  organization: SymtabOrganization;
  onUsed: (() => void) | undefined;
}) {
  const { trace } = output.runs[organization];
  const indexOf = useMemo(
    () => new Map<TraceStep<SymtabState>, number>(trace.map((step, index) => [step, index])),
    [trace],
  );
  // Sized once for the whole run, so nothing jumps and a GIF's frames all line up.
  const size = useMemo(() => {
    let width = 0;
    let height = 0;
    for (const { state } of trace) {
      const here = symtabSize(state.structure);
      width = Math.max(width, here.width);
      height = Math.max(height, here.height);
    }
    return { width, height };
  }, [trace]);

  const renderStage = useCallback(
    (step: TraceStep<SymtabState>) => {
      const { state } = step;
      const note = outcomeNote(state);
      return (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={note.fill ? 'danger' : state.outcome === 'found' ? 'success' : 'neutral'}>
              {OUTCOME_TEXT[state.outcome]}
            </Badge>
            <span className="font-mono text-xs">{note.text}</span>
          </p>
          <ScrollRegion label="The symbol table's structure">
            <svg
              role="img"
              aria-label={describeStructure(state.structure)}
              viewBox={`0 0 ${size.width} ${size.height}`}
              width={size.width}
              height={size.height}
              className="block max-w-none"
            >
              <SymtabDrawing state={state} width={size.width} />
            </svg>
          </ScrollRegion>
          <p className="text-xs text-ink-muted">{ORGANIZATION_NOTES[organization]}</p>
          <CompareTable
            comparison={output.comparison}
            current={indexOf.get(step) ?? 0}
            organization={organization}
          />
        </div>
      );
    },
    [output, organization, size, indexOf],
  );

  if (trace.length === 0) {
    return <p className="text-sm text-ink-muted">This has no symbol table operations to show.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-muted">Total comparisons:</span>
        <Badge tone={organization === 'stack' ? 'accent' : 'neutral'}>
          Stack {output.comparison.totals.stack}
        </Badge>
        <Badge tone={organization === 'hash' ? 'accent' : 'neutral'}>
          Hash {output.comparison.totals.hash}
        </Badge>
        <Badge tone={organization === 'tree' ? 'accent' : 'neutral'}>
          Tree {output.comparison.totals.tree}
        </Badge>
      </div>
      <Player
        trace={trace}
        name="scope-stack"
        renderStage={renderStage}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          width: size.width,
          height: size.height + SVG_NOTE_HEIGHT + 4,
          render: ({ state }) => (
            <>
              <SvgNotes notes={[outcomeNote(state)]} x={4} />
              <g transform={`translate(0 ${SVG_NOTE_HEIGHT + 4})`}>
                <SymtabDrawing state={state} width={size.width} />
              </g>
            </>
          ),
        }}
      />
    </div>
  );
}

function parseBuckets(text: string): number {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 211 ? value : 7;
}

/**
 * Scoped symbol tables at work, one operation at a time. All three organizations run the same
 * operations, and the switch keeps the same step, so a student can compare where the work goes.
 */
export default function ScopeStack({ initial, onUsed }: VisualizerProps) {
  const [source, setSource] = useState(initial?.source ?? SYMTAB_BLOCKS.text);
  const [format, setFormat] = useState<SymtabFormat>(
    initial?.format === 'script' ? 'script' : 'blocks',
  );
  const [organization, setOrganization] = useState<SymtabOrganization>(
    ORGANIZATIONS.find(({ value }) => value === initial?.organization)?.value ?? 'stack',
  );
  const [buckets, setBuckets] = useState(initial?.buckets ?? '7');
  const settled = useDebouncedValue(source, 400);
  const settledBuckets = useDebouncedValue(buckets, 400);
  const input = useMemo(
    () => ({ source: settled, format, buckets: parseBuckets(settledBuckets) }),
    [settled, format, settledBuckets],
  );
  const { data } = useEngineJob('symtabRun', input);
  useAiVisualizerInput(settled);
  const bucketsId = useId();

  const pickPreset = (preset: SymtabPreset) => {
    setSource(preset.text);
    setFormat(preset.format);
  };

  return (
    <div className="space-y-3">
      <CodeField
        label={format === 'blocks' ? 'Block-structured program' : 'Symbol table operations'}
        value={source}
        onChange={setSource}
        rows={6}
        hint={FORMAT_HINTS[format]}
        presets={SYMTAB_PRESETS}
        onPreset={pickPreset}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="symtab-format"
          legend="How the input is written"
          value={format}
          options={FORMATS}
          onChange={setFormat}
        />
        <Segmented
          name="symtab-organization"
          legend="How the symbol table is organized"
          value={organization}
          options={ORGANIZATIONS}
          onChange={setOrganization}
        />
        {organization === 'hash' ? (
          <label htmlFor={bucketsId} className="flex items-center gap-2 text-sm">
            Buckets
            <Input
              id={bucketsId}
              type="number"
              min={1}
              max={211}
              value={buckets}
              className="w-20"
              onChange={(event) => setBuckets(event.target.value)}
            />
          </label>
        ) : null}
      </div>
      <SourceResult result={data} text={settled}>
        {(output) => (
          <Result
            key={`${settled}\n${format}\n${parseBuckets(settledBuckets)}`}
            output={output}
            organization={organization}
            onUsed={onUsed}
          />
        )}
      </SourceResult>
    </div>
  );
}
