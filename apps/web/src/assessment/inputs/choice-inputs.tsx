import { Check, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { NativeSelect } from '@/components/ui/field';
import { PartMark, type AnswerInputProps } from './shared';

function OptionRow({
  tone,
  control,
  mark,
  children,
}: {
  tone: 'right' | 'wrong' | 'plain';
  control: ReactNode;
  mark: ReactNode;
  children: ReactNode;
}) {
  const border =
    tone === 'right'
      ? 'border-success'
      : tone === 'wrong'
        ? 'border-danger'
        : 'border-line hover:bg-surface-2';
  return (
    <li>
      <label
        className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${border}`}
      >
        {control}
        <span className="min-w-0 flex-1">{children}</span>
        {mark}
      </label>
    </li>
  );
}

const RIGHT_MARK = <Check aria-label="Correct answer" className="size-4 shrink-0 text-success" />;
const WRONG_MARK = <X aria-label="Your answer" className="size-4 shrink-0 text-danger" />;

export function McqInput({ question, value, onChange, disabled, grade }: AnswerInputProps<'mcq'>) {
  const name = useId();
  const chosen = value?.choice ?? null;
  const graded = Boolean(grade);
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">Choose one answer</legend>
      <ul className="space-y-1.5">
        {question.options.map((option, index) => {
          const isAnswer = graded && index === question.answer;
          const isWrongChoice = graded && index === chosen && !isAnswer;
          return (
            <OptionRow
              key={index}
              tone={isAnswer ? 'right' : isWrongChoice ? 'wrong' : 'plain'}
              mark={isAnswer ? RIGHT_MARK : isWrongChoice ? WRONG_MARK : null}
              control={
                <input
                  type="radio"
                  name={name}
                  className="mt-1"
                  checked={chosen === index}
                  onChange={() => onChange({ type: 'mcq', choice: index })}
                />
              }
            >
              {option}
            </OptionRow>
          );
        })}
      </ul>
    </fieldset>
  );
}

export function MultiInput({
  question,
  value,
  onChange,
  disabled,
  grade,
}: AnswerInputProps<'multi'>) {
  const chosen = new Set(value?.choices ?? []);
  const graded = Boolean(grade);
  const toggle = (index: number) => {
    const next = new Set(chosen);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onChange({ type: 'multi', choices: [...next].sort((a, b) => a - b) });
  };
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-sm text-ink-muted">Choose every answer that applies.</legend>
      <ul className="space-y-1.5">
        {question.options.map((option, index) => {
          const isAnswer = graded && question.answers.includes(index);
          const isWrongChoice = graded && chosen.has(index) && !isAnswer;
          return (
            <OptionRow
              key={index}
              tone={isAnswer ? 'right' : isWrongChoice ? 'wrong' : 'plain'}
              mark={isAnswer ? RIGHT_MARK : isWrongChoice ? WRONG_MARK : null}
              control={
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={chosen.has(index)}
                  onChange={() => toggle(index)}
                />
              }
            >
              {option}
            </OptionRow>
          );
        })}
      </ul>
    </fieldset>
  );
}

export function MatchInput({
  question,
  value,
  onChange,
  disabled,
  grade,
}: AnswerInputProps<'match'>) {
  const baseId = useId();
  const choices = question.left.map((_, index) => value?.choices[index] ?? null);
  const choose = (index: number, choice: number | null) => {
    const next = choices.slice();
    next[index] = choice;
    onChange({ type: 'match', choices: next });
  };
  return (
    <ul className="space-y-2">
      {question.left.map((item, index) => {
        const id = `${baseId}-${index}`;
        return (
          <li key={index} className="grid gap-1.5 sm:grid-cols-2 sm:items-center">
            <label htmlFor={id} className="text-sm">
              {item}
            </label>
            <div>
              <NativeSelect
                id={id}
                disabled={disabled}
                value={choices[index] ?? ''}
                onChange={(event) =>
                  choose(index, event.target.value === '' ? null : Number(event.target.value))
                }
              >
                <option value="">Choose a match</option>
                {question.right.map((option, optionIndex) => (
                  <option key={optionIndex} value={optionIndex}>
                    {option}
                  </option>
                ))}
              </NativeSelect>
              <PartMark grade={grade} part={index} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
