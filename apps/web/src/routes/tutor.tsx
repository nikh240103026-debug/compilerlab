import { useLocation } from 'react-router';
import { PlannedFeature } from '@/components/planned-feature';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSystemStatus } from '@/hooks/use-system';

export function Component() {
  const { state } = useLocation();
  const question = (state as { ask?: string } | null)?.ask;
  const { data: status } = useSystemStatus();

  return (
    <PlannedFeature
      title="AI tutor"
      lead="A patient compiler-design professor that knows which lesson, grammar or build error you are looking at."
      milestone="Arrives in Milestone 4"
      points={[
        'Doubt clearing on any lesson, at your level',
        'Explanations of compiler errors and Lex or Yacc conflicts, with hints first',
        'Generated quizzes, study plans and viva practice',
        'Answers grounded in the course and in results the engine computes',
      ]}
    >
      <div className="space-y-6">
        {question ? (
          <Card className="p-5">
            <h2 className="mb-2 text-base font-semibold">Your question</h2>
            <p className="text-sm break-words text-ink-muted">{question}</p>
            <p className="mt-3 text-sm">
              The tutor cannot answer yet. It arrives in Milestone 4, and this button will send your
              question straight to it.
            </p>
          </Card>
        ) : null}
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            Gemini connection
            {status ? (
              <Badge tone={status.gemini.configured ? 'success' : 'warning'}>
                {status.gemini.configured ? 'Key set' : 'No key'}
              </Badge>
            ) : null}
          </h2>
          {status ? (
            <p className="text-sm text-ink-muted">
              {status.gemini.configured
                ? 'Your key stays on the local server and is never sent to this page.'
                : 'Everything except AI features works without a key. Create one at aistudio.google.com/apikey and put it in .env as GEMINI_API_KEY, then restart the app.'}
            </p>
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </Card>
      </div>
    </PlannedFeature>
  );
}
