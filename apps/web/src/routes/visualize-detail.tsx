import { Compass } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { findVisualizer } from '@/visualizers/registry';
import { VisualizerHost } from '@/visualizers/visualizer-host';

export function Component() {
  const { visualizerId } = useParams();
  const entry = findVisualizer(visualizerId);
  // So another page can link straight to a visualizer with its inputs filled in.
  const [params] = useSearchParams();

  if (!entry) {
    return (
      <Page>
        <h1 className="sr-only">Visualizer not found</h1>
        <EmptyState
          icon={<Compass aria-hidden="true" />}
          title="There is no visualizer with that name"
          actions={
            <Button asChild variant="primary">
              <Link to="/visualize">See all visualizers</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title={entry.title} lead={entry.description} />
      <VisualizerHost
        key={params.toString()}
        id={entry.id}
        {...(params.size > 0 ? { initial: Object.fromEntries(params) } : {})}
      />
    </Page>
  );
}
