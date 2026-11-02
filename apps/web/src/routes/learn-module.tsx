import type { CourseModule } from '@compilerlab/shared';
import { ArrowLeft, ArrowRight, Compass, Workflow } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorPanel } from '@/components/error-panel';
import { ModuleChip } from '@/components/module-chip';
import { Page } from '@/components/page';
import { SplitPane } from '@/components/split-pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useModules } from '@/hooks/use-system';
import { describeError } from '@/lib/api';

function Overview({ module }: { module: CourseModule }) {
  return (
    <div className="p-6">
      <p className="eyebrow mb-2 flex items-center gap-2">
        <ModuleChip number={module.number} />
        Module {module.number}
      </p>
      <h1 className="text-[1.75rem] font-semibold">{module.title}</h1>
      <p className="mt-2 text-ink-muted">{module.summary}</p>
      <p className="mt-3 flex flex-wrap gap-2">
        <Badge tone="accent">Lessons arrive in Milestone {module.lessonsMilestone}</Badge>
        {module.optional ? <Badge>Optional track</Badge> : null}
      </p>
      <h2 className="mt-8 mb-3 text-base font-semibold">Topics</h2>
      <ol className="space-y-2">
        {module.topics.map((topic, index) => (
          <li key={topic} className="flex gap-3 text-sm">
            <span className="w-5 shrink-0 text-right font-mono text-xs leading-5 text-ink-muted">
              {index + 1}
            </span>
            {topic}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Visualizers({ module }: { module: CourseModule }) {
  return (
    <div className="p-6">
      <h2 className="mb-3 text-base font-semibold">Visualizers</h2>
      {module.visualizers.length > 0 ? (
        <ul className="space-y-2">
          {module.visualizers.map((visualizer) => (
            <li
              key={visualizer}
              className="flex items-start gap-2 rounded-md border border-line bg-surface p-3 text-sm"
            >
              <Workflow aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
              {visualizer}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          This track is reading and discussion, with no visualizers of its own.
        </p>
      )}
    </div>
  );
}

export function Component() {
  const { moduleId } = useParams();
  const { data: modules, error, refetch } = useModules();

  if (error) {
    return (
      <Page>
        <ErrorPanel
          title="This module could not load"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }
  if (!modules) {
    return (
      <Page>
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Page>
    );
  }

  const index = modules.findIndex((candidate) => candidate.id === moduleId);
  const module = modules[index];
  if (!module) {
    return (
      <Page>
        <EmptyState
          icon={<Compass aria-hidden="true" />}
          title="There is no module with that name"
          actions={
            <Button asChild variant="primary">
              <Link to="/learn">See all modules</Link>
            </Button>
          }
        >
          The link may be out of date. All nine modules are listed on the Learn page.
        </EmptyState>
      </Page>
    );
  }

  const previous = modules[index - 1];
  const next = modules[index + 1];

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <SplitPane
          storageKey="learn-module"
          label="Resize the lesson and visualizer panes"
          defaultRatio={0.58}
          start={<Overview module={module} />}
          end={<Visualizers module={module} />}
        />
      </div>
      <nav
        aria-label="Module"
        className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-surface px-4 py-2"
      >
        {previous ? (
          <Button asChild size="sm" variant="ghost">
            <Link to={`/learn/${previous.id}`}>
              <ArrowLeft aria-hidden="true" />
              {previous.title}
            </Link>
          </Button>
        ) : (
          <span />
        )}
        {next ? (
          <Button asChild size="sm" variant="ghost">
            <Link to={`/learn/${next.id}`}>
              {next.title}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </nav>
    </div>
  );
}
