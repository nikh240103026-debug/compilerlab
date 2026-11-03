import { CircleCheck, FlaskConical } from 'lucide-react';
import { Link } from 'react-router';
import { ErrorPanel } from '@/components/error-panel';
import { Page, PageHeader } from '@/components/page';
import { ToolchainStatus } from '@/components/system-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLabExercises, useLabProgress } from '@/hooks/use-lab';
import { useModules } from '@/hooks/use-system';
import { describeError } from '@/lib/api';

const DIFFICULTY_TONE = { easy: 'success', medium: 'warning', hard: 'danger' } as const;

function ExerciseList() {
  const { data: exercises, error, refetch } = useLabExercises();
  const { data: progress } = useLabProgress();
  const { data: modules } = useModules();

  if (error) {
    return (
      <ErrorPanel
        title="The exercises could not load"
        message={describeError(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!exercises) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  const passed = new Set(progress?.map((item) => item.exerciseId));
  const moduleIds = [...new Set(exercises.map((exercise) => exercise.module))];
  return (
    <div className="space-y-6">
      {moduleIds.map((moduleId) => {
        const inModule = exercises.filter((exercise) => exercise.module === moduleId);
        const done = inModule.filter((exercise) => passed.has(exercise.id)).length;
        return (
          <section key={moduleId} aria-labelledby={`lab-module-${moduleId}`}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id={`lab-module-${moduleId}`} className="text-base font-semibold">
                {modules?.find((module) => module.id === moduleId)?.title ?? moduleId}
              </h2>
              <span className="text-xs text-ink-muted">
                {done} of {inModule.length} passed
              </span>
            </div>
            <ul className="space-y-2">
              {inModule.map((exercise) => (
                <li key={exercise.id}>
                  <Link
                    to={`/lab/${exercise.id}`}
                    className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 transition-colors duration-(--duration-fast) hover:border-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{exercise.title}</span>
                        <Badge tone={DIFFICULTY_TONE[exercise.difficulty]}>
                          {exercise.difficulty}
                        </Badge>
                        {passed.has(exercise.id) ? (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <CircleCheck aria-hidden="true" className="size-3.5" />
                            Passed
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-[0.8125rem] text-ink-muted">
                        {exercise.brief}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function Component() {
  return (
    <Page>
      <PageHeader
        title="Lab"
        lead="Write Lex, C and C++ programs and run them with the real tools. Each exercise has starter code, hints, a solution and tests that check your work."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ExerciseList />
        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-1 text-base font-semibold">Free practice</h2>
            <p className="mb-3 text-sm text-ink-muted">
              An open workspace with no tests, for trying out your own programs.
            </p>
            <Button asChild size="sm">
              <Link to="/lab/practice">
                <FlaskConical aria-hidden="true" />
                Open a workspace
              </Link>
            </Button>
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 text-base font-semibold">Your toolchain</h2>
            <ToolchainStatus />
          </Card>
        </div>
      </div>
    </Page>
  );
}
