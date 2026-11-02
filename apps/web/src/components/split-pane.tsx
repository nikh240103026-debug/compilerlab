/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
   A focusable separator is an interactive widget in ARIA, which these rules do not know. */
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';
import { readJson, writeJson } from '@/lib/storage';

const KEY_STEP = 0.02;

interface SplitPaneProps {
  start: ReactNode;
  end: ReactNode;
  /** Remembers this split's position between visits. */
  storageKey: string;
  label: string;
  defaultRatio?: number;
  min?: number;
  max?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Two resizable side-by-side panes that stack on narrow screens. */
export function SplitPane({
  start,
  end,
  storageKey,
  label,
  defaultRatio = 0.5,
  min = 0.25,
  max = 0.75,
}: SplitPaneProps) {
  const fullKey = `compilerlab.split.${storageKey}`;
  const [ratio, setRatio] = useState(() =>
    clamp(readJson<number>(fullKey) ?? defaultRatio, min, max),
  );
  const container = useRef<HTMLDivElement>(null);
  const sideBySide = useMediaQuery('(min-width: 768px)');

  const commit = (next: number) => {
    const value = clamp(next, min, max);
    setRatio(value);
    writeJson(fullKey, value);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = container.current?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      setRatio(clamp((event.clientX - rect.left) / rect.width, min, max));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: Record<string, number> = {
      ArrowLeft: ratio - KEY_STEP,
      ArrowRight: ratio + KEY_STEP,
      Home: min,
      End: max,
    };
    const value = next[event.key];
    if (value !== undefined) {
      event.preventDefault();
      commit(value);
    }
  };

  const style: CSSProperties | undefined = sideBySide
    ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 0.75rem minmax(0, ${1 - ratio}fr)` }
    : undefined;

  return (
    <div ref={container} className="grid gap-y-6 md:h-full" style={style}>
      <div className="min-w-0 md:overflow-y-auto">{start}</div>
      {sideBySide ? (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={label}
          aria-valuemin={Math.round(min * 100)}
          aria-valuemax={Math.round(max * 100)}
          aria-valuenow={Math.round(ratio * 100)}
          className="group flex cursor-col-resize touch-none justify-center"
          onKeyDown={onKeyDown}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={onPointerMove}
          onPointerUp={() => commit(ratio)}
        >
          <div className="h-full w-px bg-line transition-colors duration-(--duration-fast) group-hover:bg-accent group-focus-visible:bg-accent" />
        </div>
      ) : null}
      <div className="min-w-0 md:overflow-y-auto">{end}</div>
    </div>
  );
}
