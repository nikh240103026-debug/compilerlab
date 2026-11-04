import {
  formatGrammarBody,
  type GrammarRuleRow,
  type GrammarTransformResult,
  type GrammarTransformStep,
  type TraceStep,
} from '@compilerlab/engine';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/cn';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { Player } from '../player/player';
import type { VisualizerProps } from '../shared';
import { GrammarField, GrammarResult, GrammarWarnings } from './grammar-field';
import type { GrammarWorkbenchOutput } from './jobs';
import {
  AMBIGUOUS_EXPRESSION,
  BALANCED,
  DANGLING_ELSE,
  EXPRESSION,
  INDIRECT_RECURSION,
} from './presets';
import { SetsPlayer } from './sets-player';
import { ParsingTable, SET_HEADERS, setRows } from './tables';

const PRESETS = [EXPRESSION, INDIRECT_RECURSION, DANGLING_ELSE, AMBIGUOUS_EXPRESSION, BALANCED];

type WorkbenchView = 'recursion' | 'factoring' | 'sets';

const LINE_HEIGHT = 20;
const CHAR_WIDTH = 7.6;

const ruleText = ({ head, bodies }: GrammarRuleRow) =>
  `${head} → ${bodies.map(formatGrammarBody).join(' | ')}`;

function RulesView({ step }: { step: GrammarTransformStep }) {
  return (
    <div className="space-y-2 font-mono text-[0.8125rem]">
      <ul aria-label="The grammar at this step" className="space-y-0.5">
        {step.rules.map((rule) => (
          <li
            key={rule.head}
            className={cn(
              'rounded-sm px-1',
              rule.head === step.activeHead && 'bg-accent-soft font-semibold',
            )}
          >
            {ruleText(rule)}
          </li>
        ))}
      </ul>
      {step.removed.length + step.added.length > 0 ? (
        <ul aria-label="What this step changed" className="space-y-0.5 border-t border-line pt-2">
          {step.removed.map((line, index) => (
            <li
              key={`r${index}`}
              className="rounded-sm bg-(--diff-remove) px-1 text-(--diff-remove-ink)"
            >
              − {line}
            </li>
          ))}
          {step.added.map((line, index) => (
            <li key={`a${index}`} className="rounded-sm bg-(--diff-add) px-1 text-(--diff-add-ink)">
              + {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RulesSvg({ step }: { step: GrammarTransformStep }) {
  const lines = [
    ...step.rules.map((rule) => ({
      text: ruleText(rule),
      fill: 'var(--ink)',
      weight: rule.head === step.activeHead ? 700 : 400,
    })),
    ...step.removed.map((text) => ({
      text: `− ${text}`,
      fill: 'var(--diff-remove-ink)',
      weight: 400,
    })),
    ...step.added.map((text) => ({
      text: `+ ${text}`,
      fill: 'var(--diff-add-ink)',
      weight: 400,
    })),
  ];
  return (
    <g fontFamily="monospace" fontSize={13}>
      {lines.map((line, index) => (
        <text
          key={index}
          x={16}
          y={20 + index * LINE_HEIGHT}
          fill={line.fill}
          fontWeight={line.weight}
        >
          {line.text}
        </text>
      ))}
    </g>
  );
}

function transformSize(trace: GrammarTransformResult['trace']) {
  let lines = 1;
  let longest = 20;
  for (const { state } of trace) {
    const texts = [...state.rules.map(ruleText), ...state.removed, ...state.added];
    lines = Math.max(lines, texts.length);
    for (const text of texts) longest = Math.max(longest, text.length + 2);
  }
  return { width: longest * CHAR_WIDTH + 32, height: lines * LINE_HEIGHT + 24 };
}

function TransformPlayer({
  result,
  name,
  onUsed,
}: {
  result: GrammarTransformResult;
  name: string;
  onUsed: (() => void) | undefined;
}) {
  const renderStage = useCallback(
    ({ state }: TraceStep<GrammarTransformStep>) => <RulesView step={state} />,
    [],
  );
  return (
    <div className="space-y-2">
      {result.notes.map((note, index) => (
        <p key={index} className="rounded-md bg-surface-2 p-2 text-sm text-ink-muted">
          {note}
        </p>
      ))}
      <Player
        trace={result.trace}
        name={name}
        renderStage={renderStage}
        {...(onUsed ? { onInteract: onUsed } : {})}
        stageExport={{
          ...transformSize(result.trace),
          render: ({ state }) => <RulesSvg step={state} />,
        }}
      />
    </div>
  );
}

function Workbench({
  output,
  onUsed,
  onUse,
}: {
  output: GrammarWorkbenchOutput;
  onUsed: (() => void) | undefined;
  onUse: (text: string) => void;
}) {
  const [view, setView] = useState<WorkbenchView>('recursion');
  const { grammar, sets, ambiguity } = output;
  const changed = output.leftRecursion.changed || output.leftFactoring.changed;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>
          {grammar.nonterminals.length} nonterminal{grammar.nonterminals.length === 1 ? '' : 's'}
        </Badge>
        <Badge>
          {grammar.terminals.length} terminal{grammar.terminals.length === 1 ? '' : 's'}
        </Badge>
        <Badge tone={output.isLl1 ? 'success' : 'warning'}>
          {output.isLl1 ? 'LL(1)' : 'Not LL(1)'}
        </Badge>
        {ambiguity.witness ? <Badge tone="danger">Ambiguous</Badge> : null}
      </div>

      <GrammarWarnings warnings={output.warnings} />

      <p className="rounded-md bg-surface-2 p-2 text-sm">
        <span className="font-medium">Ambiguity check: </span>
        {ambiguity.message}
      </p>

      <div>
        <p className="mb-1 text-sm font-semibold">FIRST and FOLLOW</p>
        <ParsingTable
          caption="Nullable, FIRST and FOLLOW for each nonterminal"
          headers={SET_HEADERS}
          rows={setRows(sets.nullable, sets.first, sets.follow)}
        />
      </div>

      <div>
        <p className="mb-1 text-sm font-semibold">
          {changed ? 'After removing left recursion and left factoring' : 'Transformations'}
        </p>
        {changed ? (
          <>
            <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[0.8125rem]">
              {output.transformedText}
            </pre>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Button size="sm" onClick={() => onUse(output.transformedText)}>
                Use this grammar
              </Button>
              <span className="text-ink-muted">
                {output.transformedIsLl1
                  ? 'This version is LL(1).'
                  : 'This version is still not LL(1). No rewrite can fix every grammar.'}
              </span>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            This grammar has no left recursion and no common prefixes, so both transformations leave
            it as it is.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Segmented
          name="workbench-view"
          legend="Which algorithm to step through"
          value={view}
          options={[
            { value: 'recursion', label: 'Left recursion' },
            { value: 'factoring', label: 'Left factoring' },
            { value: 'sets', label: 'FIRST and FOLLOW' },
          ]}
          onChange={setView}
        />
        {view === 'recursion' ? (
          <TransformPlayer
            key="recursion"
            result={output.leftRecursion}
            name="left-recursion"
            onUsed={onUsed}
          />
        ) : view === 'factoring' ? (
          <TransformPlayer
            key="factoring"
            result={output.leftFactoring}
            name="left-factoring"
            onUsed={onUsed}
          />
        ) : (
          <SetsPlayer key="sets" trace={sets.trace} name="first-follow" onUsed={onUsed} />
        )}
      </div>
    </div>
  );
}

export default function GrammarWorkbench({ initial, onUsed }: VisualizerProps) {
  const [text, setText] = useState(initial?.grammar ?? EXPRESSION.grammar);
  const settled = useDebouncedValue(text, 400);
  const { data } = useEngineJob('grammarWorkbench', { grammar: settled });

  return (
    <div className="space-y-3">
      <GrammarField value={text} onChange={setText} presets={PRESETS} />
      <GrammarResult result={data} grammar={settled}>
        {(output) => <Workbench key={settled} output={output} onUsed={onUsed} onUse={setText} />}
      </GrammarResult>
    </div>
  );
}
