import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Page, PageHeader } from './page';

/** A section that a later milestone delivers. Says plainly what is coming and what works now. */
export function PlannedFeature({
  title,
  lead,
  milestone,
  points,
  children,
}: {
  title: string;
  lead: string;
  milestone: string;
  points: readonly string[];
  children?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader title={title} lead={lead} actions={<Badge tone="accent">{milestone}</Badge>} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-base font-semibold">What this section will do</h2>
          <ul className="space-y-2">
            {points.map((point) => (
              <li key={point} className="flex gap-2 text-sm text-ink-muted">
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                {point}
              </li>
            ))}
          </ul>
        </Card>
        {children}
      </div>
    </Page>
  );
}
