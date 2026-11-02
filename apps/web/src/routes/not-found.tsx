import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';

export function Component() {
  return (
    <Page>
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon={<Compass aria-hidden="true" />}
        title="This page does not exist"
        actions={
          <>
            <Button asChild variant="primary">
              <Link to="/">Go to the dashboard</Link>
            </Button>
            <Button asChild>
              <Link to="/learn">See all modules</Link>
            </Button>
          </>
        }
      >
        The link may be out of date, or it may point to a section that has not been built yet.
      </EmptyState>
    </Page>
  );
}
