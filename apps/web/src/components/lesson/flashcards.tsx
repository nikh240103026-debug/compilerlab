import type { Flashcard } from '@compilerlab/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function Flashcards({ cards }: { cards: readonly Flashcard[] }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const card = cards[index];
  if (!card) return null;

  const go = (next: number) => {
    setIndex((next + cards.length) % cards.length);
    setFlipped(false);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setFlipped(!flipped)}
        aria-label={
          flipped
            ? `Answer: ${card.back}. Show the question.`
            : `Question: ${card.front}. Show the answer.`
        }
        className="flex min-h-32 w-full flex-col items-center justify-center rounded-lg border border-line-strong bg-surface p-4 text-center transition-colors duration-(--duration-fast) hover:bg-surface-2"
      >
        <span className="eyebrow mb-2">{flipped ? 'Answer' : 'Question'}</span>
        <span className="text-sm">{flipped ? card.back : card.front}</span>
      </button>
      <div className="mt-2 flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={() => go(index - 1)}>
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <span className="font-mono text-xs text-ink-muted">
          {index + 1}/{cards.length}
        </span>
        <Button size="sm" variant="ghost" onClick={() => go(index + 1)}>
          Next
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
