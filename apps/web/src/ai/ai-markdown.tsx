import { lazy, Suspense, useDeferredValue } from 'react';
import { ErrorBoundary } from '@/components/ui/error-boundary';

// react-markdown and its parser are only needed once there is an answer to show.
const AiMarkdownBody = lazy(() => import('./ai-markdown-body'));

function PlainText({ text }: { text: string }) {
  return <p className="text-sm break-words whitespace-pre-wrap">{text}</p>;
}

/** AI text as Markdown. Until the parser has loaded, or if it cannot load, it shows as plain text. */
export function AiMarkdown({ text }: { text: string }) {
  // Keeps typing and scrolling smooth while an answer streams in.
  const deferred = useDeferredValue(text);
  return (
    <ErrorBoundary fallback={() => <PlainText text={text} />}>
      <Suspense fallback={<PlainText text={text} />}>
        <AiMarkdownBody text={deferred} />
      </Suspense>
    </ErrorBoundary>
  );
}
