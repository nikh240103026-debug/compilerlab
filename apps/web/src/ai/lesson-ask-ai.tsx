/* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- Escape closes a panel from anywhere inside it, which needs one listener on the panel itself. */
import type { LessonSummary } from '@compilerlab/shared';
import { Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { AskAiPanel, type AskRequest } from './ask-ai-panel';
import { useAiContextSection } from './context-store';

const ACTIONS = [
  { label: 'Explain simply', question: (quote: string) => `Explain this simply: "${quote}"` },
  { label: 'Give an example', question: (quote: string) => `Give an example of this: "${quote}"` },
  { label: 'Why?', question: (quote: string) => `Why is this true? "${quote}"` },
] as const;

type Action = (typeof ACTIONS)[number];

const MIN_SELECTION_CHARS = 2;
/** The whole passage goes in the context, so the question only needs to name it. */
const QUOTE_CHARS = 160;
const TOOLBAR_HEIGHT = 44;
const TOOLBAR_HALF_WIDTH = 170;
const SELECTION_DELAY_MS = 150;

interface LessonSelection {
  text: string;
  top: number;
  left: number;
}

function quoteOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > QUOTE_CHARS ? `${oneLine.slice(0, QUOTE_CHARS)}...` : oneLine;
}

/** Follows the student's text selection inside the lesson. */
function useLessonSelection(articleRef: RefObject<HTMLElement>): LessonSelection | null {
  const [selection, setSelection] = useState<LessonSelection | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const current = window.getSelection();
      const article = articleRef.current;
      if (!current || !article || current.isCollapsed || current.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = current.getRangeAt(0);
      const text = current.toString().trim();
      if (!article.contains(range.commonAncestorContainer) || text.length < MIN_SELECTION_CHARS) {
        setSelection(null);
        return;
      }
      const box = range.getBoundingClientRect();
      const above = box.top - TOOLBAR_HEIGHT - 8;
      setSelection({
        text,
        top: above > TOOLBAR_HEIGHT ? above : box.bottom + 8,
        left: Math.min(
          window.innerWidth - TOOLBAR_HALF_WIDTH,
          Math.max(TOOLBAR_HALF_WIDTH, box.left + box.width / 2),
        ),
      });
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(read, SELECTION_DELAY_MS);
    };
    document.addEventListener('selectionchange', soon);
    // The lesson scrolls inside its pane, and the toolbar has to follow the text.
    window.addEventListener('scroll', soon, true);
    window.addEventListener('resize', soon);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', soon);
      window.removeEventListener('scroll', soon, true);
      window.removeEventListener('resize', soon);
    };
  }, [articleRef]);

  return selection;
}

/**
 * Part 8's doubt clearing on every lesson: a floating panel with a level selector, and actions on
 * any selected text. This is a lazy chunk, and the chat's Markdown renderer is another one.
 */
export default function LessonAskAi({
  lesson,
  articleRef,
}: {
  lesson: LessonSummary;
  articleRef: RefObject<HTMLElement>;
}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const [request, setRequest] = useState<AskRequest | null>(null);
  const [excerpt, setExcerpt] = useState('');
  const selection = useLessonSelection(articleRef);
  const launcher = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const nextRequest = useRef(1);

  // The launcher is hidden while the panel is open, so focus can only return after it reappears.
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      launcher.current?.focus();
    }
  }, [open]);

  // The last thing selected stays in the context until a new selection replaces it or the
  // student removes it, because moving focus to the question box clears the selection.
  useEffect(() => {
    if (selection) setExcerpt(selection.text);
  }, [selection]);

  useAiContextSection('topic', () => ({
    id: lesson.id,
    title: lesson.title,
    ...(excerpt ? { excerpt } : {}),
  }));

  const show = useCallback(() => {
    setOpen(true);
    setEverOpened(true);
    setOpenCount((count) => count + 1);
  }, []);

  const hide = () => {
    returnFocus.current = true;
    setOpen(false);
  };

  const runAction = (action: Action, text: string) => {
    setExcerpt(text);
    window.getSelection()?.removeAllRanges();
    show();
    setRequest({ id: nextRequest.current++, question: action.question(quoteOf(text)) });
  };

  return (
    <>
      <Button ref={launcher} size="sm" variant="primary" hidden={open} onClick={show}>
        <Sparkles aria-hidden="true" />
        Ask AI
      </Button>

      {selection ? (
        <div
          role="toolbar"
          aria-label="Ask the AI about the selected text"
          style={{ top: selection.top, left: selection.left }}
          className="fixed z-40 flex -translate-x-1/2 gap-0.5 rounded-md border border-line-strong bg-surface p-1 shadow-lg"
        >
          {ACTIONS.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant="ghost"
              // Pressing a button must not clear the selection it acts on.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runAction(action, selection.text)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {everOpened ? (
        <section
          aria-label="Ask AI about this lesson"
          hidden={!open}
          onKeyDown={(event) => {
            if (event.key === 'Escape') hide();
          }}
          className="fixed right-4 bottom-14 z-30 flex h-[min(38rem,calc(100dvh-8rem))] w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-line-strong bg-surface p-3 shadow-xl"
        >
          <header className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles aria-hidden="true" className="size-4 text-accent" />
              Ask AI about this lesson
            </h2>
            <Button size="icon" variant="ghost" aria-label="Close the AI panel" onClick={hide}>
              <X aria-hidden="true" />
            </Button>
          </header>

          {excerpt ? (
            <div className="rounded-md border border-line p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-ink-muted">
                  <span className="font-medium text-ink">Selected: </span>
                  {quoteOf(excerpt)}
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  className="-mt-1 -mr-1 shrink-0"
                  aria-label="Stop using the selected text"
                  onClick={() => setExcerpt('')}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {ACTIONS.map((action) => (
                  <Button
                    key={action.label}
                    size="sm"
                    variant="ghost"
                    onClick={() => runAction(action, excerpt)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">
              Select any text in the lesson to have it explained.
            </p>
          )}

          <AskAiPanel
            conversationId={`lesson:${lesson.id}`}
            label="Ask about this lesson"
            placeholder={`Ask about ${lesson.title}`}
            request={request}
            focusKey={open ? openCount : undefined}
            className="min-h-0 flex-1"
          />
        </section>
      ) : null}
    </>
  );
}
