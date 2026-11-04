import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { Check, X } from 'lucide-react';

export interface AnswerInputProps<T extends PracticeProblem['type']> {
  question: Extract<PracticeProblem, { type: T }>;
  /** Null until the student gives an answer. */
  value: Extract<QuestionAnswer, { type: T }> | null;
  onChange: (answer: Extract<QuestionAnswer, { type: T }>) => void;
  /** True once the answer can no longer change, as in review. */
  disabled: boolean;
  /** Set once the answer has been marked. Parts of it then show as right or wrong. */
  grade?: GradeResult | null | undefined;
}

/** Marks a part only once it has been graded, with words as well as a color. */
export function PartMark({
  grade,
  part,
  showExpected = true,
}: {
  grade: GradeResult | null | undefined;
  part: string | number;
  showExpected?: boolean;
}) {
  const right = grade?.parts?.[part];
  if (right === undefined) return null;
  const expected = grade?.expected?.[part];
  return (
    <span className="inline-flex items-start gap-1 text-xs">
      {right ? (
        <>
          <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
          <span className="sr-only">Right</span>
        </>
      ) : (
        <>
          <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />
          <span className={showExpected && expected !== undefined ? 'text-ink-muted' : 'sr-only'}>
            {showExpected && expected !== undefined ? `Should be: ${expected}` : 'Wrong'}
          </span>
        </>
      )}
    </span>
  );
}

/** A grammar printed exactly as the question wrote it. */
export function GrammarBlock({ grammar, label = 'Grammar' }: { grammar: string; label?: string }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-sm font-medium">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-[0.8125rem] leading-snug">
        {grammar}
      </pre>
    </div>
  );
}

export const tableCellClass = 'border border-line p-1 align-top';
export const tableHeaderClass =
  'border border-line bg-surface-2 px-2 py-1 text-left font-mono text-[0.8125rem] font-medium';
