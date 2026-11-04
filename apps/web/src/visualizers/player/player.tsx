/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be focusable. */
import type { Trace, TraceStep } from '@compilerlab/engine';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Pause,
  Play,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/hooks/use-settings';
import { describeError } from '@/lib/api';
import { toast } from '@/stores/toasts';
import { ExportFrame } from './export-frame';
import { MAX_SPEED, MIN_SPEED, SPEED_STEP, usePlayer } from './use-player';

// "Why did this step happen?" and "Predict the next step". A chunk of its own, so a visualizer's
// drawing never waits for AI code.
const StepCompanion = lazy(() => import('@/ai/step-companion'));

export interface StageExport<S> {
  /** The drawing for one step. Must render pure SVG, with a fixed size for the whole trace. */
  render: (step: TraceStep<S>) => ReactElement;
  width: number;
  height: number;
}

interface PlayerProps<S> {
  trace: Trace<S>;
  renderStage: (step: TraceStep<S>) => ReactNode;
  /** The name of downloaded files. */
  name: string;
  stageExport?: StageExport<S>;
  onInteract?: () => void;
  /** Reports the current step, for visualizers that draw outside the player. */
  onStep?: (step: TraceStep<S>) => void;
}

function ExportButtons<S>({
  trace,
  index,
  name,
  stageExport,
}: {
  trace: Trace<S>;
  index: number;
  name: string;
  stageExport: StageExport<S>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const frameAt = (at: number) => {
    const step = trace[at] as TraceStep<S>;
    return (
      <ExportFrame
        title={step.title}
        explanation={step.explanation}
        step={at}
        total={trace.length}
        width={stageExport.width}
        height={stageExport.height}
      >
        {stageExport.render(step)}
      </ExportFrame>
    );
  };

  const run = async (label: string, task: (tools: typeof import('./export')) => Promise<void>) => {
    setBusy(label);
    try {
      await task(await import('./export'));
    } catch (error) {
      toast({
        tone: 'danger',
        title: `The ${label} could not be made`,
        description: describeError(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Export">
      <Download aria-hidden="true" className="size-3.5 text-ink-muted" />
      <Button
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() =>
          void run('PNG', (tools) => tools.exportPng(frameAt(index), `${name}-step-${index + 1}`))
        }
      >
        PNG
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() =>
          void run('SVG', (tools) => tools.exportSvg(frameAt(index), `${name}-step-${index + 1}`))
        }
      >
        SVG
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() =>
          void run('GIF', (tools) =>
            tools.exportGif(frameAt, trace.length, name, (fraction) =>
              setBusy(`GIF ${Math.round(fraction * 100)}%`),
            ),
          )
        }
      >
        {busy?.startsWith('GIF') ? busy : 'GIF'}
      </Button>
    </div>
  );
}

/**
 * The common player for every visualizer: play, pause, step, scrub, change speed, read why each
 * step happened, and export. Keys: Space plays, arrows step, Home and End jump, + and - set speed.
 */
export function Player<S>({
  trace,
  renderStage,
  name,
  stageExport,
  onInteract,
  onStep,
}: PlayerProps<S>) {
  const { settings } = useSettings();
  const player = usePlayer(trace.length, {
    speedFactor: settings.animationSpeed,
    ...(onInteract ? { onInteract } : {}),
  });
  const {
    index,
    playing,
    speed,
    atStart,
    atEnd,
    togglePlay,
    stepForward,
    stepBack,
    seek,
    setSpeed,
  } = player;
  const step = trace[index] as TraceStep<S> | undefined;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step) onStep?.(step);
  }, [step, onStep]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // Typing fields and sliders keep their own keys, and buttons keep Space and Enter.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === ' ' && target.tagName === 'BUTTON') return;
      if (event.key.startsWith('Arrow') && 'scrollRegion' in target.dataset) return;
      const actions: Record<string, () => void> = {
        ' ': togglePlay,
        ArrowRight: stepForward,
        ArrowLeft: stepBack,
        Home: () => seek(0),
        End: () => seek(trace.length - 1),
        '+': () => setSpeed(speed + SPEED_STEP),
        '=': () => setSpeed(speed + SPEED_STEP),
        '-': () => setSpeed(speed - SPEED_STEP),
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [togglePlay, stepForward, stepBack, seek, setSpeed, speed, trace.length]);

  const stage = useMemo(() => (step ? renderStage(step) : null), [step, renderStage]);

  const pause = useCallback(() => {
    if (playing) togglePlay();
  }, [playing, togglePlay]);

  if (!step) return null;

  return (
    <div
      ref={root}
      role="group"
      aria-label={`${name} player`}
      className="flex min-w-0 flex-col gap-3"
    >
      <div
        // Focusable, so keyboard users can scroll a large automaton with the arrow keys.
        tabIndex={0}
        data-scroll-region=""
        role="group"
        aria-label="Visualization"
        className="min-w-0 overflow-x-auto rounded-md border border-line bg-surface p-2"
      >
        {stage}
      </div>

      <div
        aria-live={playing ? 'off' : 'polite'}
        className="min-h-[5.5rem] rounded-md bg-surface-2 p-3"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={index}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <p className="text-sm font-semibold">{step.title}</p>
            <p className="mt-0.5 text-sm text-ink-muted">{step.explanation}</p>
          </motion.div>
        </AnimatePresence>
      </div>

      <Suspense fallback={null}>
        <StepCompanion
          name={name}
          index={index}
          total={trace.length}
          step={step}
          next={trace[index + 1] ?? null}
          onPause={pause}
          onReveal={stepForward}
        />
      </Suspense>

      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label="Scrub through the steps"
          className="h-5 min-w-0 flex-1"
          min={0}
          max={trace.length - 1}
          value={index}
          aria-valuetext={`Step ${index + 1} of ${trace.length}: ${step.title}`}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="shrink-0 font-mono text-xs text-ink-muted">
          {index + 1}/{trace.length}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Go to the first step"
            aria-disabled={atStart}
            onClick={() => seek(0)}
          >
            <ChevronsLeft aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Step back"
            aria-disabled={atStart}
            onClick={stepBack}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="primary"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={togglePlay}
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Step forward"
            aria-disabled={atEnd}
            onClick={stepForward}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Go to the last step"
            aria-disabled={atEnd}
            onClick={() => seek(trace.length - 1)}
          >
            <ChevronsRight aria-hidden="true" />
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Speed
          <input
            type="range"
            className="h-5 w-20"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={SPEED_STEP}
            value={speed}
            aria-valuetext={`${speed} times`}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
          <span className="w-8 font-mono">{speed}x</span>
        </label>
        {stageExport ? (
          <div className="ml-auto">
            <ExportButtons trace={trace} index={index} name={name} stageExport={stageExport} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
