import { Link } from 'react-router';
import { ErrorPanel } from '@/components/error-panel';
import { ModuleChip } from '@/components/module-chip';
import { Page, PageHeader } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useModules } from '@/hooks/use-system';
import { describeError } from '@/lib/api';

export function Component() {
  const { data: modules, error, refetch } = useModules();

  return (
    <Page>
      <PageHeader
        title="Course modules"
        lead="Nine modules take you from what a compiler is, through each phase, to modern practice."
      />
      {error ? (
        <ErrorPanel
          title="The course outline could not load"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {modules
            ? modules.map((module) => (
                <li key={module.id}>
                  <Link
                    to={`/learn/${module.id}`}
                    className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4 transition-colors duration-(--duration-fast) hover:border-line-strong hover:bg-surface-2"
                  >
                    <span className="flex items-center gap-2">
                      <ModuleChip number={module.number} />
                      <span className="font-medium">{module.title}</span>
                      {module.optional ? <Badge className="ml-auto">Optional</Badge> : null}
                    </span>
                    <span className="text-sm text-ink-muted">{module.summary}</span>
                    <span className="mt-auto pt-1 font-mono text-xs text-ink-muted">
                      {module.topics.length} topics
                      {module.visualizers.length > 0
                        ? ` · ${module.visualizers.length} visualizers`
                        : ''}
                    </span>
                  </Link>
                </li>
              ))
            : [0, 1, 2, 3, 4, 5].map((card) => (
                <li key={card}>
                  <Skeleton className="h-32 w-full rounded-lg" />
                </li>
              ))}
        </ul>
      )}
    </Page>
  );
}
