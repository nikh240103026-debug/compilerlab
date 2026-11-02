import type { CourseModule } from '@compilerlab/shared';
import { ArrowRight, BarChart3 } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorPanel } from '@/components/error-panel';
import { ModuleChip } from '@/components/module-chip';
import { Page, PageHeader, SectionTitle } from '@/components/page';
import { PhasePipeline } from '@/components/phase-pipeline';
import { ToolchainStatus } from '@/components/system-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useModules, useSystemStatus } from '@/hooks/use-system';
import { describeError } from '@/lib/api';

function AiStatus() {
  const { data: status } = useSystemStatus();
  if (!status) return <Skeleton className="h-5 w-40" />;
  return status.gemini.configured ? (
    <p className="text-sm text-ink-muted">
      A Gemini key is set, so the tutor can use{' '}
      <span className="font-mono text-[0.8125rem] text-ink">{status.gemini.model}</span>.
    </p>
  ) : (
    <p className="text-sm text-ink-muted">
      No Gemini key yet. Everything except AI features works without one. To add it, put{' '}
      <code className="font-mono text-[0.8125rem] text-ink">GEMINI_API_KEY</code> in{' '}
      <code className="font-mono text-[0.8125rem] text-ink">.env</code>.
    </p>
  );
}

function ModuleRow({ module }: { module: CourseModule }) {
  return (
    <li>
      <Link
        to={`/learn/${module.id}`}
        className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors duration-(--duration-fast) hover:bg-surface-2"
      >
        <ModuleChip number={module.number} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{module.title}</span>
          <span className="block text-[0.8125rem] text-ink-muted">{module.summary}</span>
        </span>
        {module.optional ? <Badge>Optional</Badge> : null}
      </Link>
    </li>
  );
}

export function Component() {
  const { data: modules, error, refetch } = useModules();
  const firstModule = modules?.[0];

  return (
    <Page>
      <PageHeader
        eyebrow="From source to target"
        title="Learn how a compiler works, one phase at a time"
        lead="Lessons, step-by-step visualizers, real Lex and Yacc labs, and exam practice. Everything runs on your computer."
        actions={
          firstModule ? (
            <Button asChild variant="primary">
              <Link to={`/learn/${firstModule.id}`}>
                Start with {firstModule.title}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null
        }
      />

      <section aria-labelledby="pipeline-title" className="mb-8">
        <h2 id="pipeline-title" className="sr-only">
          The compiler pipeline
        </h2>
        <Card className="px-5 py-6">
          {error ? (
            <ErrorPanel
              title="The course outline could not load"
              message={describeError(error)}
              onRetry={() => void refetch()}
            />
          ) : modules ? (
            <PhasePipeline modules={modules} />
          ) : (
            <Skeleton className="h-20 w-full" />
          )}
        </Card>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <section>
            <SectionTitle>Around the pipeline</SectionTitle>
            <Card className="p-2">
              <ul>
                {modules
                  ?.filter((module) => !module.pipelineStage)
                  .map((module) => (
                    <ModuleRow key={module.id} module={module} />
                  ))}
              </ul>
            </Card>
          </section>
          <section>
            <SectionTitle>Your progress</SectionTitle>
            <EmptyState icon={<BarChart3 aria-hidden="true" />} title="Nothing to show yet">
              Mastery per phase, streaks and time spent will appear here once you start working
              through lessons and quizzes.
            </EmptyState>
          </section>
        </div>

        <section>
          <SectionTitle>This computer</SectionTitle>
          <Card className="space-y-5 p-5">
            <ToolchainStatus showFix={false} />
            <div className="border-t border-line pt-4">
              <h3 className="mb-1 text-sm font-medium">AI tutor</h3>
              <AiStatus />
            </div>
            <Button asChild size="sm">
              <Link to="/settings#system">How to set these up</Link>
            </Button>
          </Card>
        </section>
      </div>
    </Page>
  );
}
