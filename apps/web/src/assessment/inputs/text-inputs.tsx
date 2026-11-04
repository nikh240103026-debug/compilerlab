import { splitAtBlanks } from '@compilerlab/shared/assessment';
import { Fragment, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { useDebouncedValue, useEngineJob } from '@/visualizers/engine/use-engine';
import { InputError } from '@/visualizers/shared';
import { PartMark, type AnswerInputProps } from './shared';

const areaClass = 'w-full rounded-md border border-line-strong bg-surface p-2 text-sm text-ink';
const codeAreaClass = `${areaClass} font-mono text-[0.8125rem] leading-snug`;

export function ShortInput({ value, onChange, disabled }: AnswerInputProps<'short'>) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Your answer
      </label>
      <textarea
        id={id}
        rows={4}
        value={value?.text ?? ''}
        disabled={disabled}
        onChange={(event) => onChange({ type: 'short', text: event.target.value })}
        className={areaClass}
      />
    </>
  );
}

export function RegexInput({ value, onChange, disabled }: AnswerInputProps<'regex'>) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Your regular expression
      </label>
      <Input
        id={id}
        value={value?.text ?? ''}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        className="max-w-md font-mono"
        onChange={(event) => onChange({ type: 'regex', text: event.target.value })}
      />
    </>
  );
}

export function OutputInput({ question, value, onChange, disabled }: AnswerInputProps<'output'>) {
  const id = useId();
  return (
    <>
      <p className="mb-1 text-sm font-medium">The program</p>
      <pre className="mb-3 overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[0.8125rem] leading-snug">
        <code>{question.code}</code>
      </pre>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        What does it print?
      </label>
      <textarea
        id={id}
        rows={4}
        value={value?.text ?? ''}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange({ type: 'output', text: event.target.value })}
        className={codeAreaClass}
      />
      <p className="mt-0.5 text-xs text-ink-muted">
        Line endings and spaces at the ends of lines do not matter. Everything else does.
      </p>
    </>
  );
}

export function GrammarInput({ question, value, onChange, disabled }: AnswerInputProps<'grammar'>) {
  const id = useId();
  const hintId = useId();
  const text = value?.text ?? '';
  const settled = useDebouncedValue(text, 400);
  // This only reads the grammar, to catch typing mistakes. It says nothing about the examples.
  const { data } = useEngineJob('grammarSets', settled.trim() ? { grammar: settled } : null);
  return (
    <>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Your grammar
      </label>
      <textarea
        id={id}
        rows={6}
        value={text}
        disabled={disabled}
        spellCheck={false}
        aria-describedby={hintId}
        onChange={(event) => onChange({ type: 'grammar', text: event.target.value })}
        className={codeAreaClass}
      />
      <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
        One rule per line, such as S -&gt; a S b | ε. Put spaces between symbols. A symbol with a
        production is a nonterminal, and the first head is the start symbol.
      </p>
      {!disabled ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {['ε', '→', '|'].map((symbol) => (
            <Button
              key={symbol}
              size="sm"
              variant="ghost"
              aria-label={`Add ${symbol} to the end of the grammar`}
              onClick={() => onChange({ type: 'grammar', text: `${text}${symbol}` })}
            >
              <span className="font-mono">{symbol}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {data && !data.ok && settled.trim() && !disabled ? (
        <div className="mt-2">
          <InputError error={data.error} />
        </div>
      ) : null}
      {question.requires?.length ? (
        <p className="mt-2 text-sm">
          It must also be:{' '}
          {question.requires
            .map((item) =>
              item === 'll1'
                ? 'LL(1)'
                : item === 'no-left-recursion'
                  ? 'free of left recursion'
                  : 'unambiguous',
            )
            .join(', ')}
          .
        </p>
      ) : null}
    </>
  );
}

export function FillInput({
  question,
  value,
  onChange,
  disabled,
  grade,
}: AnswerInputProps<'fill'>) {
  const pieces = splitAtBlanks(question.text);
  const blanks = question.blanks.map((_, index) => value?.blanks[index] ?? '');
  const setBlank = (index: number, text: string) => {
    const next = blanks.slice();
    next[index] = text;
    onChange({ type: 'fill', blanks: next });
  };
  return (
    <p className="text-sm leading-loose whitespace-pre-line">
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {piece}
          {index < question.blanks.length ? (
            <span className="mx-1 inline-flex flex-col align-top">
              <Input
                aria-label={`Blank ${index + 1} of ${question.blanks.length}`}
                value={blanks[index]}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                className="inline-block h-8 w-36"
                onChange={(event) => setBlank(index, event.target.value)}
              />
              <PartMark grade={grade} part={index} />
            </span>
          ) : null}
        </Fragment>
      ))}
    </p>
  );
}
