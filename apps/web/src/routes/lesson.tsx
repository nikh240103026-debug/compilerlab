import type { LessonSummary, TopicBank } from '@compilerlab/shared';
import type { VisualizerId } from '@compilerlab/shared/constants';
import { isTopicComplete, topicMastery } from '@compilerlab/shared/progress';
import 'katex/dist/katex.min.css';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  Clock,
  Compass,
  FlaskConical,
  Sparkles,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorPanel, useAskAi } from '@/components/error-panel';
import { Flashcards } from '@/components/lesson/flashcards';
import { MDX_COMPONENTS, TryItContext, type TryRequest } from '@/components/lesson/mdx-components';
import { Question } from '@/components/lesson/question';
import { Quiz } from '@/components/lesson/quiz';
import { ModuleChip } from '@/components/module-chip';
import { Page } from '@/components/page';
import { SplitPane } from '@/components/split-pane';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { Skeleton } from '@/components/ui/skeleton';
import { useLessons, useProgress, useTopicBank, useUpdateProgress } from '@/hooks/use-lessons';
import { useModules } from '@/hooks/use-system';
import { describeError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { findVisualizer } from '@/visualizers/registry';
import { VisualizerHost } from '@/visualizers/visualizer-host';

const lessonFiles = import.meta.glob<{ default: ComponentType<{ components?: object }> }>(
  '../../../../packages/content/lessons/**/*.mdx',
);

const lessonComponents = new Map<
  string,
  LazyExoticComponent<ComponentType<{ components?: object }>>
>();

function lessonBody(path: string) {
  const cached = lessonComponents.get(path);
  if (cached) return cached;
  const file = Object.keys(lessonFiles).find((key) => key.endsWith(`/lessons/${path}`));
  const load = file ? lessonFiles[file] : undefined;
  if (!load) return null;
  const component = lazy(load);
  lessonComponents.set(path, component);
  return component;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="mb-3 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function MasteryMeter({ lesson }: { lesson: LessonSummary }) {
  const { data: all = [] } = useProgress();
  const progress = all.find((item) => item.topicId === lesson.id);
  const hasVisualizer = lesson.visualizers.length > 0;
  const mastery = topicMastery(progress, hasVisualizer);
  const complete = isTopicComplete(progress, hasVisualizer);
  const items = [
    ['Read the lesson', progress?.read ?? false],
    ...(hasVisualizer ? [['Used a visualizer', progress?.visualizerUsed ?? false] as const] : []),
    [
      `Passed the quiz${progress?.bestQuizScore != null ? ` (best ${progress.bestQuizScore}%)` : ''}`,
      (progress?.bestQuizScore ?? 0) >= 70,
    ],
  ] as const;
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{complete ? 'Topic complete' : 'Mastery'}</span>
        <span className="font-mono text-xs">{mastery}%</span>
      </div>
      <div
        role="meter"
        aria-label="Mastery of this topic"
        aria-valuenow={mastery}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--duration-slow)"
          style={{ width: `${mastery}%` }}
        />
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {items.map(([label, done]) => (
          <li key={label} className="flex items-center gap-1">
            {done ? (
              <Check aria-hidden="true" className="size-3.5 text-success" />
            ) : (
              <Circle aria-hidden="true" className="size-3" />
            )}
            {label}
            <span className="sr-only">{done ? ': done' : ': not yet'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LessonHeader({
  lesson,
  moduleNumber,
  moduleTitle,
  lessons,
}: {
  lesson: LessonSummary;
  moduleNumber: number;
  moduleTitle: string;
  lessons: readonly LessonSummary[];
}) {
  const prerequisites = lesson.prerequisites.flatMap((id) => {
    const found = lessons.find((candidate) => candidate.id === id);
    return found ? [found] : [];
  });
  return (
    <header>
      <p className="eyebrow mb-2 flex items-center gap-2">
        <ModuleChip number={moduleNumber} />
        {moduleTitle}
      </p>
      <h1 className="text-[1.75rem] font-semibold">{lesson.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
        <span className="flex items-center gap-1">
          <Clock aria-hidden="true" className="size-3.5" />
          About {lesson.estimatedMinutes} minutes
        </span>
        {prerequisites.length > 0 ? (
          <span>
            Before this:{' '}
            {prerequisites.map((item, index) => (
              <span key={item.id}>
                {index > 0 ? ', ' : ''}
                <Link
                  to={`/learn/${item.module}/${item.id}`}
                  className="text-accent underline underline-offset-2"
                >
                  {item.title}
                </Link>
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="mt-3">
        <MasteryMeter lesson={lesson} />
      </div>
      <div className="mt-3">
        <p className="text-sm font-medium">You will be able to:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
          {lesson.outcomes.map((outcome) => (
            <li key={outcome}>{outcome}</li>
          ))}
        </ul>
      </div>
    </header>
  );
}

function BankSections({ lesson, bank }: { lesson: LessonSummary; bank: TopicBank }) {
  const { mutate } = useUpdateProgress(lesson.id);
  const askAi = useAskAi();
  return (
    <>
      <Section id="practice-heading" title="Practice">
        <ol className="space-y-3">
          {bank.practice.map((problem, index) => (
            <Question key={problem.id} question={problem} number={index + 1} />
          ))}
        </ol>
      </Section>

      <Section id="lab-heading" title="Lab">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4 text-sm">
          <p className="min-w-0 flex-1">
            Hands-on exercises with real flex and gcc for this topic arrive with the lab in
            Milestone 3.
          </p>
          <Button asChild size="sm">
            <Link to="/lab">
              <FlaskConical aria-hidden="true" />
              Open the lab
            </Link>
          </Button>
        </div>
      </Section>

      <Section id="quiz-heading" title="Quiz">
        <Quiz questions={bank.quiz} onComplete={(quizScore) => mutate({ quizScore })} />
      </Section>

      <Section id="summary-heading" title="Summary">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {bank.summary.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </Section>

      <Section id="flashcards-heading" title="Flashcards">
        <Flashcards cards={bank.flashcards} />
      </Section>

      <Section id="ask-heading" title="Still unsure?">
        <Button
          onClick={() =>
            void askAi(`I am studying "${lesson.title}". Can you help me understand it?`)
          }
        >
          <Sparkles aria-hidden="true" />
          Ask AI about this topic
        </Button>
      </Section>
    </>
  );
}

function ReadSentinel({ onSeen }: { onSeen: () => void }) {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = marker.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        onSeen();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onSeen]);
  return <div ref={marker} aria-hidden="true" className="h-px" />;
}

function VisualizerPane({
  tabs,
  request,
  onUsed,
}: {
  tabs: LessonSummary['visualizers'];
  request: (TryRequest & { nonce: number }) | null;
  onUsed: () => void;
}) {
  const [picked, setPicked] = useState(0);
  // A Try it button wins until the student picks a tab.
  const [useRequest, setUseRequest] = useState(false);
  useEffect(() => {
    if (request) setUseRequest(true);
  }, [request]);

  const tab = tabs[picked];
  const showing = useRequest && request ? request.visualizer : tab?.id;
  // A button only states what it changes. Anything else, such as lexer rules, comes from the tab.
  const requestedTab = tabs.find((item) => item.id === request?.visualizer);
  const initial = useRequest && request ? { ...requestedTab?.props, ...request.props } : tab?.props;
  const entry = findVisualizer(showing);

  if (tabs.length === 0 && !request) {
    return (
      <div className="p-6">
        <EmptyState icon={<Compass aria-hidden="true" />} title="No visualizer for this topic yet">
          The 3D pipeline fly-through for this module arrives in Milestone 9. Meanwhile, every other
          visualizer is on the{' '}
          <Link to="/visualize" className="text-accent underline underline-offset-2">
            Visualize page
          </Link>
          .
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="p-4">
      {tabs.length > 1 ? (
        <div
          role="tablist"
          aria-label="Visualizers for this topic"
          className="mb-3 flex flex-wrap gap-1"
        >
          {tabs.map((item, index) => {
            const selected = !useRequest && index === picked;
            return (
              <button
                key={`${item.id}-${index}`}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setPicked(index);
                  setUseRequest(false);
                }}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[0.8125rem] font-medium',
                  selected
                    ? 'bg-accent text-on-accent'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                {item.label ?? findVisualizer(item.id)?.title}
              </button>
            );
          })}
        </div>
      ) : null}
      {entry ? (
        <>
          <h2 className="mb-2 text-base font-semibold">{entry.title}</h2>
          <VisualizerHost
            key={`${entry.id}-${useRequest ? request?.nonce : picked}`}
            id={entry.id as VisualizerId}
            initial={initial}
            onUsed={onUsed}
          />
        </>
      ) : null}
    </div>
  );
}

function LessonPage({
  lesson,
  lessons,
  moduleNumber,
  moduleTitle,
}: {
  lesson: LessonSummary;
  lessons: readonly LessonSummary[];
  moduleNumber: number;
  moduleTitle: string;
}) {
  const { mutate } = useUpdateProgress(lesson.id);
  const { data: bank, error: bankError, refetch } = useTopicBank(lesson.id);
  const { data: allProgress = [] } = useProgress();
  const [request, setRequest] = useState<(TryRequest & { nonce: number }) | null>(null);

  const already = allProgress.find((item) => item.topicId === lesson.id);
  const usedOnce = useRef(already?.visualizerUsed ?? false);
  const markUsed = useCallback(() => {
    if (usedOnce.current) return;
    usedOnce.current = true;
    mutate({ visualizerUsed: true });
  }, [mutate]);
  const markRead = useCallback(() => mutate({ read: true }), [mutate]);

  const tryIt = useCallback(
    (next: TryRequest) => setRequest((current) => ({ ...next, nonce: (current?.nonce ?? 0) + 1 })),
    [],
  );

  const Body = lessonBody(lesson.path);
  const siblings = useMemo(
    () => lessons.filter((item) => item.module === lesson.module),
    [lessons, lesson.module],
  );
  const index = siblings.findIndex((item) => item.id === lesson.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];

  return (
    <TryItContext.Provider value={tryIt}>
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <SplitPane
            storageKey="lesson"
            label="Resize the lesson and visualizer panes"
            defaultRatio={0.52}
            min={0.3}
            max={0.72}
            start={
              <article className="p-6">
                <LessonHeader
                  lesson={lesson}
                  moduleNumber={moduleNumber}
                  moduleTitle={moduleTitle}
                  lessons={lessons}
                />
                <div className="lesson-prose mt-6">
                  <ErrorBoundary
                    fallback={(error, reset) => (
                      <ErrorPanel
                        title="This lesson could not be shown"
                        message={describeError(error)}
                        onRetry={reset}
                      />
                    )}
                  >
                    <Suspense
                      fallback={
                        <div className="space-y-3" aria-busy="true">
                          <Skeleton className="h-6 w-1/2" />
                          <Skeleton className="h-32 w-full" />
                        </div>
                      }
                    >
                      {Body ? <Body components={MDX_COMPONENTS} /> : null}
                    </Suspense>
                  </ErrorBoundary>
                </div>
                <ReadSentinel onSeen={markRead} />
                {bankError ? (
                  <div className="mt-8">
                    <ErrorPanel
                      title="The questions for this topic could not load"
                      message={describeError(bankError)}
                      onRetry={() => void refetch()}
                    />
                  </div>
                ) : bank ? (
                  <BankSections lesson={lesson} bank={bank} />
                ) : (
                  <Skeleton className="mt-8 h-40 w-full" />
                )}
              </article>
            }
            end={<VisualizerPane tabs={lesson.visualizers} request={request} onUsed={markUsed} />}
          />
        </div>
        <nav
          aria-label="Topic"
          className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-surface px-4 py-2"
        >
          {previous ? (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/learn/${previous.module}/${previous.id}`}>
                <ArrowLeft aria-hidden="true" />
                {previous.title}
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/learn/${next.module}/${next.id}`}>
                {next.title}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </nav>
      </div>
    </TryItContext.Provider>
  );
}

export function Component() {
  const { moduleId, topicId } = useParams();
  const { data: lessons, error, refetch } = useLessons();
  const { data: modules } = useModules();

  if (error) {
    return (
      <Page>
        <ErrorPanel
          title="This lesson could not load"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }
  if (!lessons || !modules) {
    return (
      <Page>
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Page>
    );
  }

  const lesson = lessons.find((item) => item.id === topicId && item.module === moduleId);
  const courseModule = modules.find((item) => item.id === moduleId);
  if (!lesson || !courseModule) {
    return (
      <Page>
        <h1 className="sr-only">Topic not found</h1>
        <EmptyState
          icon={<Compass aria-hidden="true" />}
          title="There is no topic with that name"
          actions={
            <Button asChild variant="primary">
              <Link to={moduleId ? `/learn/${moduleId}` : '/learn'}>See the topics</Link>
            </Button>
          }
        >
          The link may be out of date.
        </EmptyState>
      </Page>
    );
  }

  return (
    <LessonPage
      key={lesson.id}
      lesson={lesson}
      lessons={lessons}
      moduleNumber={courseModule.number}
      moduleTitle={courseModule.title}
    />
  );
}
