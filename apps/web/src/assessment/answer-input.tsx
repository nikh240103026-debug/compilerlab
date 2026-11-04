import type { GradeResult, PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { ErrorPanel } from '@/components/error-panel';
import { describeError } from '@/lib/api';
import { McqInput, MatchInput, MultiInput } from './inputs/choice-inputs';
import { OrderInput } from './inputs/order-input';
import { TableInput } from './inputs/table-input';
import { FillInput, GrammarInput, OutputInput, RegexInput, ShortInput } from './inputs/text-inputs';
import { TraceInput } from './inputs/trace-input';

// React Flow is large, so it only loads for a question that draws.
const AutomatonInput = lazy(() => import('./inputs/automaton-input'));

/**
 * The right control for any question. The value is this question's answer, or null, and each input
 * only ever sends back an answer of its own type.
 */
export function AnswerInput({
  question,
  value,
  onChange,
  disabled = false,
  grade,
}: {
  question: PracticeProblem;
  value: QuestionAnswer | null;
  onChange: (answer: QuestionAnswer) => void;
  disabled?: boolean | undefined;
  grade?: GradeResult | null | undefined;
}) {
  const common = { onChange, disabled, grade };
  switch (question.type) {
    case 'mcq':
      return (
        <McqInput {...common} question={question} value={value?.type === 'mcq' ? value : null} />
      );
    case 'multi':
      return (
        <MultiInput
          {...common}
          question={question}
          value={value?.type === 'multi' ? value : null}
        />
      );
    case 'short':
      return (
        <ShortInput
          {...common}
          question={question}
          value={value?.type === 'short' ? value : null}
        />
      );
    case 'regex':
      return (
        <RegexInput
          {...common}
          question={question}
          value={value?.type === 'regex' ? value : null}
        />
      );
    case 'fill':
      return (
        <FillInput {...common} question={question} value={value?.type === 'fill' ? value : null} />
      );
    case 'match':
      return (
        <MatchInput
          {...common}
          question={question}
          value={value?.type === 'match' ? value : null}
        />
      );
    case 'order':
      return (
        <OrderInput
          {...common}
          question={question}
          value={value?.type === 'order' ? value : null}
        />
      );
    case 'table':
      return (
        <TableInput
          {...common}
          question={question}
          value={value?.type === 'table' ? value : null}
        />
      );
    case 'grammar':
      return (
        <GrammarInput
          {...common}
          question={question}
          value={value?.type === 'grammar' ? value : null}
        />
      );
    case 'trace':
      return (
        <TraceInput
          {...common}
          question={question}
          value={value?.type === 'trace' ? value : null}
        />
      );
    case 'output':
      return (
        <OutputInput
          {...common}
          question={question}
          value={value?.type === 'output' ? value : null}
        />
      );
    case 'automaton':
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <ErrorPanel
              title="The drawing canvas could not load"
              message={describeError(error)}
              onRetry={reset}
            />
          )}
        >
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <AutomatonInput
              {...common}
              question={question}
              value={value?.type === 'automaton' ? value : null}
            />
          </Suspense>
        </ErrorBoundary>
      );
  }
}
