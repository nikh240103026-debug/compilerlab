import { AI_LIMITS } from '@compilerlab/shared/ai';
import { Flag } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { api, describeError } from '@/lib/api';

/**
 * Part 8's Report wrong answer button. It saves the question, the answer and an optional note in
 * the local database, and nothing is sent anywhere else.
 */
export function ReportWrongAnswer({
  source,
  question,
  answer,
  model,
  topicId,
}: {
  /** Where the answer appeared: "chat", or a task name. */
  source: string;
  question: string;
  answer: string;
  model?: string | undefined;
  topicId?: string | undefined;
}) {
  const [state, setState] = useState<'idle' | 'open' | 'saving' | 'saved'>('idle');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();

  if (state === 'saved') {
    return (
      <p role="status" className="text-xs text-ink-muted">
        Thanks. Your report is saved on this computer.
      </p>
    );
  }
  if (state === 'idle') {
    return (
      <Button size="sm" variant="ghost" className="-ml-2" onClick={() => setState('open')}>
        <Flag aria-hidden="true" />
        Report wrong answer
      </Button>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState('saving');
    setProblem(null);
    try {
      await api.aiFeedback({
        source,
        question: question.slice(0, AI_LIMITS.question),
        answer: answer.slice(0, AI_LIMITS.notes),
        ...(note.trim() ? { note: note.trim().slice(0, AI_LIMITS.excerpt) } : {}),
        ...(topicId ? { topicId } : {}),
        ...(model ? { model } : {}),
      });
      setState('saved');
    } catch (error) {
      setProblem(describeError(error));
      setState('open');
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-1 space-y-1">
      <label htmlFor={noteId} className="block text-xs font-medium">
        What is wrong with it? This is optional.
      </label>
      <textarea
        id={noteId}
        rows={2}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="w-full rounded-md border border-line-strong bg-surface p-2 text-xs text-ink"
      />
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={state === 'saving'}>
          Save report
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setState('idle')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
