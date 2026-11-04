import { shuffledIndexes } from '@compilerlab/shared/assessment';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { PartMark, type AnswerInputProps } from './shared';

/** Drag a step to a new place, or use its buttons. Both change the same list. */
export function OrderInput({
  question,
  value,
  onChange,
  disabled,
  grade,
}: AnswerInputProps<'order'>) {
  // A question nobody has touched stays unanswered, and is shown in a shuffle fixed by its id.
  const order = value?.order ?? shuffledIndexes(question.id, question.items.length);
  const [announcement, setAnnouncement] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const refocus = useRef<{ item: number; direction: 'up' | 'down' } | null>(null);

  // React may move the row that holds focus, so the focus is put back on the same row's button.
  useEffect(() => {
    if (!refocus.current || !list.current) return;
    const { item, direction } = refocus.current;
    refocus.current = null;
    const opposite = direction === 'up' ? 'down' : 'up';
    const wanted = list.current.querySelector<HTMLButtonElement>(
      `[data-move="${item}-${direction}"]:not(:disabled)`,
    );
    const fallback = list.current.querySelector<HTMLButtonElement>(
      `[data-move="${item}-${opposite}"]:not(:disabled)`,
    );
    (wanted ?? fallback)?.focus();
  });

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = order.slice();
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    onChange({ type: 'order', order: next });
    setAnnouncement(`${question.items[item]} moved to position ${to + 1} of ${order.length}.`);
  };

  const onDrop = (event: DragEvent, position: number) => {
    event.preventDefault();
    if (dragFrom !== null) move(dragFrom, position);
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <>
      <p className="mb-1.5 text-sm text-ink-muted">
        {disabled
          ? 'Your order:'
          : 'Put these in the right order. Drag a step, or use its up and down buttons.'}
      </p>
      <ol ref={list} className="space-y-1.5">
        {order.map((item, position) => (
          <li
            key={item}
            draggable={!disabled}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', String(position));
              setDragFrom(position);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(position);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
            onDrop={(event) => onDrop(event, position)}
            className={cn(
              'flex items-start gap-2 rounded-md border bg-surface p-2 text-sm',
              dragOver === position && dragFrom !== position ? 'border-accent' : 'border-line',
              dragFrom === position && 'opacity-60',
            )}
          >
            {!disabled ? (
              <GripVertical
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 cursor-grab text-ink-muted"
              />
            ) : null}
            <span className="mt-0.5 font-mono text-xs text-ink-muted">{position + 1}</span>
            <span className="min-w-0 flex-1">
              {question.items[item]}
              <span className="block">
                <PartMark grade={grade} part={position} />
              </span>
            </span>
            {!disabled ? (
              <span className="flex shrink-0 gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  data-move={`${item}-up`}
                  aria-label={`Move "${question.items[item]}" up`}
                  disabled={position === 0}
                  onClick={() => {
                    refocus.current = { item, direction: 'up' };
                    move(position, position - 1);
                  }}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  data-move={`${item}-down`}
                  aria-label={`Move "${question.items[item]}" down`}
                  disabled={position === order.length - 1}
                  onClick={() => {
                    refocus.current = { item, direction: 'down' };
                    move(position, position + 1);
                  }}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
