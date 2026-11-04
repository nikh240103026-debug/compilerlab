import type { AiAnswerMeta, AiSource } from '@compilerlab/shared';
import { Sparkles, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AiMarkdown } from './ai-markdown';
import { ReportWrongAnswer } from './report-button';

/** Every piece of AI output carries this, so it is never mistaken for checked course content. */
export function AiLabel() {
  return (
    <Badge tone="accent">
      <Sparkles aria-hidden="true" className="size-3" />
      AI-generated
    </Badge>
  );
}

function Sources({ sources }: { sources: readonly AiSource[] }) {
  if (sources.length === 0) return null;
  return (
    <p className="text-xs text-ink-muted">
      Based on:{' '}
      {sources.map((source, index) => (
        <span key={`${source.topicId}-${source.heading}`}>
          {index > 0 ? ', ' : ''}
          <Link
            to={`/learn/${source.module}/${source.topicId}`}
            className="underline underline-offset-2 hover:text-ink"
          >
            {source.topicTitle}
          </Link>
        </span>
      ))}
    </p>
  );
}

/** The label, notes and report button around any AI output. */
export function AiResultFrame({
  meta,
  source,
  question,
  answer,
  topicId,
  children,
}: {
  meta: AiAnswerMeta | null | undefined;
  /** Where this appeared, for the report: "chat", or a task name. */
  source: string;
  question: string;
  /** The text saved if the student reports it. */
  answer: string;
  topicId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <AiLabel />
        {meta?.cached ? (
          <span className="text-xs text-ink-muted">Saved answer, using no quota</span>
        ) : null}
      </div>
      {children}
      {meta?.truncated ? (
        <p className="text-xs text-warning">
          This answer reached its length limit and was cut off.
        </p>
      ) : null}
      {meta ? <Sources sources={meta.sources} /> : null}
      <p className="text-xs text-ink-muted">AI can be wrong. Check anything important.</p>
      <ReportWrongAnswer
        source={source}
        question={question}
        answer={answer}
        model={meta?.model}
        topicId={topicId}
      />
    </div>
  );
}

/** A streamed or finished answer. */
export function AiAnswer({
  text,
  streaming = false,
  note,
  meta,
  question,
  source = 'chat',
  topicId,
  onStop,
}: {
  text: string;
  streaming?: boolean;
  note?: string | null | undefined;
  meta?: AiAnswerMeta | null | undefined;
  question: string;
  source?: string;
  topicId?: string | undefined;
  onStop?: (() => void) | undefined;
}) {
  if (streaming) {
    return (
      <div className="space-y-2 rounded-md border border-line bg-surface p-3" aria-busy="true">
        <div className="flex flex-wrap items-center gap-2">
          <AiLabel />
          <span className="text-xs text-ink-muted">{note ?? 'Thinking...'}</span>
          {onStop ? (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onStop}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          ) : null}
        </div>
        {text ? <AiMarkdown text={text} /> : null}
      </div>
    );
  }
  return (
    <AiResultFrame meta={meta} source={source} question={question} answer={text} topicId={topicId}>
      <AiMarkdown text={text} />
    </AiResultFrame>
  );
}
