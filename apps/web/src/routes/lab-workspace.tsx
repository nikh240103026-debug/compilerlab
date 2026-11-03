import type { LabWorkspace } from '@compilerlab/shared';
import { SCRATCH_WORKSPACE } from '@compilerlab/shared/lab';
import { Link, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorPanel } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLabExercises, useSavedWorkspace } from '@/hooks/use-lab';
import { describeError } from '@/lib/api';
import { DEFAULT_TEMPLATE } from '@/lab/templates';
import { Workspace } from '@/lab/workspace';

export const PRACTICE_PATH = 'practice';

export function Component() {
  const { exerciseId } = useParams();
  const isPractice = exerciseId === PRACTICE_PATH;
  const exercises = useLabExercises();
  const exercise = exercises.data?.find((item) => item.id === exerciseId) ?? null;
  const workspaceId = isPractice ? SCRATCH_WORKSPACE : (exerciseId ?? '');
  const known = isPractice || exercise !== null;
  const saved = useSavedWorkspace(workspaceId, known);

  const failure = exercises.error ?? saved.error;
  if (failure) {
    return (
      <div className="p-6">
        <ErrorPanel title="The lab could not load" message={describeError(failure)} />
      </div>
    );
  }
  if (!exercises.data || (known && saved.isPending)) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (!known) {
    return (
      <div className="p-6">
        <EmptyState
          title="There is no exercise with that name"
          actions={
            <Button asChild size="sm">
              <Link to="/lab">Go to the lab</Link>
            </Button>
          }
        >
          It may have been renamed. The lab lists every exercise.
        </EmptyState>
      </div>
    );
  }

  const initial: LabWorkspace =
    saved.data ??
    (exercise
      ? { files: exercise.files, stdin: exercise.stdin, pipeline: exercise.pipeline }
      : {
          files: DEFAULT_TEMPLATE.files,
          stdin: DEFAULT_TEMPLATE.stdin,
          pipeline: DEFAULT_TEMPLATE.pipeline,
        });

  return (
    <Workspace
      key={workspaceId}
      id={workspaceId}
      title={exercise?.title ?? 'Free practice'}
      exercise={exercise}
      initial={initial}
    />
  );
}
