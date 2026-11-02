import type { VisualizerId } from '@compilerlab/shared/constants';
import { MotionConfig } from 'framer-motion';
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { ErrorPanel } from '@/components/error-panel';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettings } from '@/hooks/use-settings';
import { describeError } from '@/lib/api';
import { findVisualizer } from './registry';
import type { VisualizerProps } from './shared';

const components = new Map<string, LazyExoticComponent<ComponentType<VisualizerProps>>>();

function lazyComponent(id: VisualizerId) {
  const cached = components.get(id);
  if (cached) return cached;
  const entry = findVisualizer(id);
  if (!entry) return null;
  const component = lazy(entry.load);
  components.set(id, component);
  return component;
}

/** Loads a visualizer on demand and keeps any failure inside its own panel. */
export function VisualizerHost({
  id,
  initial,
  onUsed,
}: {
  id: VisualizerId;
  initial?: Readonly<Record<string, string>> | undefined;
  onUsed?: (() => void) | undefined;
}) {
  const { settings } = useSettings();
  const Visualizer = lazyComponent(id);
  if (!Visualizer) {
    return (
      <ErrorPanel
        title="This visualizer does not exist"
        message={`There is no visualizer named ${id}.`}
      />
    );
  }
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <ErrorPanel
          title="This visualizer could not run"
          message={describeError(error)}
          onRetry={reset}
        />
      )}
    >
      <Suspense
        fallback={
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        {/* Honors the system's reduced-motion setting, and scales with Settings > Animation speed. */}
        <MotionConfig reducedMotion="user" transition={{ duration: 0.2 / settings.animationSpeed }}>
          <Visualizer {...(initial ? { initial } : {})} {...(onUsed ? { onUsed } : {})} />
        </MotionConfig>
      </Suspense>
    </ErrorBoundary>
  );
}
