import type {
  Grammar,
  GrammarSetAnswer,
  GrammarSetKind,
  GrammarSetVerdict,
  GrammarSets,
} from '@compilerlab/engine';
import { Check, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { useDebouncedValue, useEngineJob } from '../engine/use-engine';
import { InputError, type VisualizerProps } from '../shared';
import { GrammarField, GrammarResult } from './grammar-field';
import { BALANCED, EXPRESSION_LL, INDIRECT_RECURSION, TWO_C } from './presets';
import { SetsPlayer } from './sets-player';

const PRESETS = [EXPRESSION_LL, TWO_C, BALANCED, INDIRECT_RECURSION];

const answerKey = (kind: GrammarSetKind, symbol: string) => `${kind}\u0000${symbol}`;

/** Names what the student wrote that is wrong, but only counts what is missing. */
function Feedback({ verdict, revealed }: { verdict: GrammarSetVerdict; revealed: boolean }) {
  if (verdict.correct) {
    return (
      <p className="mt-0.5 flex items-center gap-1 text-xs text-success">
        <Check aria-hidden="true" className="size-3.5" />
        Correct
      </p>
    );
  }
  const parts: string[] = [];
  if (verdict.extra.length > 0) parts.push(`Does not belong: ${verdict.extra.join(' ')}`);
  if (verdict.missing.length > 0) {
    parts.push(
      revealed
        ? `Missing: ${verdict.missing.join(' ')}`
        : `${verdict.missing.length} missing item${verdict.missing.length === 1 ? '' : 's'}`,
    );
  }
  return (
    <p className="mt-0.5 flex items-start gap-1 text-xs text-danger">
      <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {parts.join('. ')}
    </p>
  );
}

function FillIn({
  source,
  grammar,
  sets,
  onUsed,
}: {
  source: string;
  grammar: Grammar;
  sets: GrammarSets;
  onUsed: (() => void) | undefined;
}) {
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const [submitted, setSubmitted] = useState<readonly GrammarSetAnswer[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const { data } = useEngineJob(
    'grammarCheckSets',
    submitted ? { grammar: source, answers: submitted } : null,
  );

  const verdicts = useMemo(() => {
    const byKey = new Map<string, GrammarSetVerdict>();
    if (data?.ok) {
      for (const verdict of data.value.verdicts) {
        byKey.set(answerKey(verdict.kind, verdict.symbol), verdict);
      }
    }
    return byKey;
  }, [data]);

  const answerOf = (kind: GrammarSetKind, symbol: string) =>
    answers.get(answerKey(kind, symbol)) ?? '';

  /** A mark only counts for the text it was given to, so it goes away once that text changes. */
  const isMarked = (kind: GrammarSetKind, symbol: string) =>
    submitted?.find((item) => item.kind === kind && item.symbol === symbol)?.text ===
    answerOf(kind, symbol);

  const check = () => {
    onUsed?.();
    const next: GrammarSetAnswer[] = [];
    for (const kind of ['first', 'follow'] as const) {
      for (const symbol of grammar.nonterminals) {
        next.push({ kind, symbol, text: answerOf(kind, symbol) });
      }
    }
    setSubmitted(next);
  };

  const cell = (kind: GrammarSetKind, symbol: string) => {
    const name = `${kind === 'first' ? 'FIRST' : 'FOLLOW'}(${symbol})`;
    const verdict = verdicts.get(answerKey(kind, symbol));
    return (
      <td className="border border-line p-1 align-top">
        <Input
          aria-label={name}
          value={answerOf(kind, symbol)}
          spellCheck={false}
          autoComplete="off"
          className="h-8 font-mono text-[0.8125rem]"
          onChange={(event) => {
            const next = new Map(answers);
            next.set(answerKey(kind, symbol), event.target.value);
            setAnswers(next);
          }}
        />
        {verdict && isMarked(kind, symbol) ? (
          <Feedback verdict={verdict} revealed={revealed} />
        ) : null}
      </td>
    );
  };

  const total = grammar.nonterminals.length * 2;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Write each set with spaces or commas between its items, such as id, ( or a b. Use ε (or eps)
        for the empty string and $ for the end marker.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[0.8125rem]">
          <caption className="sr-only">Your FIRST and FOLLOW sets</caption>
          <thead>
            <tr>
              {['Symbol', 'FIRST', 'FOLLOW'].map((header, index) => (
                <th
                  key={index}
                  scope="col"
                  className="border border-line bg-surface-2 px-2 py-1 text-left font-medium"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grammar.nonterminals.map((symbol) => (
              <tr key={symbol}>
                <th scope="row" className="border border-line px-2 py-1 text-left font-medium">
                  {symbol}
                </th>
                {cell('first', symbol)}
                {cell('follow', symbol)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={check}>
          Check my answers
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRevealed((value) => !value)}>
          {revealed ? 'Hide the working' : 'Show the working'}
        </Button>
        {data?.ok ? (
          <p role="status" className="text-sm">
            {data.value.allCorrect
              ? `All ${total} sets are right.`
              : `${data.value.correctCount} of ${total} sets are right.`}
          </p>
        ) : null}
      </div>
      {data && !data.ok ? <InputError error={data.error} /> : null}

      {revealed ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">How the engine works them out</p>
          <SetsPlayer trace={sets.trace} name="first-follow" onUsed={onUsed} />
        </div>
      ) : null}
    </div>
  );
}

export default function FirstFollowFill({ initial, onUsed }: VisualizerProps) {
  const [text, setText] = useState(initial?.grammar ?? EXPRESSION_LL.grammar);
  const settled = useDebouncedValue(text, 400);
  const { data } = useEngineJob('grammarSets', { grammar: settled });

  return (
    <div className="space-y-3">
      <GrammarField value={text} onChange={setText} presets={PRESETS} />
      <GrammarResult result={data} grammar={settled}>
        {({ grammar, sets }) => (
          <FillIn key={settled} source={settled} grammar={grammar} sets={sets} onUsed={onUsed} />
        )}
      </GrammarResult>
    </div>
  );
}
