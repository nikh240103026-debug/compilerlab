import type { AiContext } from '@compilerlab/shared';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AskAiPanel, type AskRequest } from '@/ai/ask-ai-panel';
import { AiOfflineNotice } from '@/ai/offline-notice';
import { useAiStatus } from '@/ai/use-ai-status';
import { Page, PageHeader } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const SUGGESTIONS = [
  'What is the difference between an NFA and a DFA?',
  'Why does a lexer use the longest match?',
  'How does the subset construction work?',
  'What do FIRST and FOLLOW mean? Show me a small grammar.',
  'What are the phases of a compiler, and what does each one hand to the next?',
  'What does a shift/reduce conflict mean?',
];

const STATE_LABELS = {
  ready: { label: 'Ready', tone: 'success' },
  no_key: { label: 'No key', tone: 'warning' },
  offline: { label: 'Offline', tone: 'warning' },
  rate_limited: { label: 'Waiting for quota', tone: 'warning' },
} as const;

function ConnectionCard() {
  const { data: status } = useAiStatus();
  return (
    <Card className="p-4">
      <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        Gemini connection
        {status ? (
          <Badge tone={STATE_LABELS[status.state].tone}>{STATE_LABELS[status.state].label}</Badge>
        ) : null}
      </h2>
      {status ? (
        <div className="space-y-2 text-sm text-ink-muted">
          {status.configured ? (
            <p>
              Using <code className="font-mono text-[0.8125rem] text-ink">{status.model}</code>.
              Your key stays on the local server and never reaches this page.
            </p>
          ) : (
            <p>
              Create a key at aistudio.google.com/apikey and put it in .env as GEMINI_API_KEY, then
              restart the app. Lessons, visualizers, the lab and quizzes all work without one.
            </p>
          )}
          {status.state === 'offline' || status.state === 'rate_limited' ? (
            <AiOfflineNotice compact />
          ) : null}
        </div>
      ) : (
        <Skeleton className="h-10 w-full" />
      )}
    </Card>
  );
}

function PrivacyCard() {
  return (
    <Card className="p-4 text-sm text-ink-muted">
      <h2 className="mb-2 text-sm font-semibold text-ink">What leaves this computer</h2>
      <p>
        Your question and the listed context go to Google&apos;s Gemini API, and nothing else does.
        Answers are saved in the local database, so asking the same thing again uses no quota.
      </p>
    </Card>
  );
}

function HowItHelpsCard() {
  return (
    <Card className="p-4 text-sm text-ink-muted">
      <h2 className="mb-2 text-sm font-semibold text-ink">How it answers</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>It looks up the course&apos;s lessons first and shows which ones it used.</li>
        <li>When the engine has computed a result, it is told to use that and not to guess.</li>
        <li>AI can still be wrong. Use Report wrong answer when you spot a mistake.</li>
      </ul>
    </Card>
  );
}

export function Component() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { ask?: string; context?: AiContext } | null;
  const ask = state?.ask;
  const [request, setRequest] = useState<AskRequest | null>(null);
  const [context, setContext] = useState<AiContext | undefined>(state?.context);

  // An Ask AI button arrives with its question. Clearing it from the page's history state means a
  // reload does not ask again, and asking again from elsewhere still works.
  useEffect(() => {
    if (!ask) return;
    setRequest({ id: location.key, question: ask });
    setContext(state?.context);
    void navigate(location.pathname, { replace: true, state: null });
    // Only a new arrival should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  return (
    <Page>
      <PageHeader
        title="AI tutor"
        lead="A patient compiler-design professor that knows which lesson, grammar or build error you are looking at."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <AskAiPanel
          conversationId="tutor"
          label="Ask the tutor"
          request={request}
          context={context}
          suggestions={SUGGESTIONS}
          className="h-[min(44rem,calc(100dvh-14rem))] min-h-96"
        />
        <div className="space-y-3">
          <ConnectionCard />
          <HowItHelpsCard />
          <PrivacyCard />
        </div>
      </div>
    </Page>
  );
}
