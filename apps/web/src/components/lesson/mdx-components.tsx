import { BookCheck, Info, Play, TriangleAlert } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export interface TryRequest {
  visualizer: string;
  props: Record<string, string>;
}

/** Lets a button inside the lesson text load an example into the visualizer pane. */
export const TryItContext = createContext<(request: TryRequest) => void>(() => {});

const CALLOUTS = {
  note: { icon: Info, label: 'Note', className: 'border-info' },
  warning: { icon: TriangleAlert, label: 'Watch out', className: 'border-warning' },
  textbook: { icon: BookCheck, label: 'Check against the textbook', className: 'border-accent' },
};

export function Callout({
  kind = 'note',
  title,
  children,
}: {
  kind?: keyof typeof CALLOUTS;
  title?: string;
  children: ReactNode;
}) {
  const { icon: Icon, label, className } = CALLOUTS[kind];
  return (
    <aside className={cn('my-4 rounded-md border-l-4 bg-surface-2 p-3 text-sm', className)}>
      <p className="mb-1 flex items-center gap-1.5 font-semibold">
        <Icon aria-hidden="true" className="size-4" />
        {title ?? label}
      </p>
      <div className="callout-body">{children}</div>
    </aside>
  );
}

/** A button in the text. Everything besides `visualizer` becomes that visualizer's input. */
export function TryIt({
  visualizer,
  children,
  ...props
}: {
  visualizer: string;
  children?: ReactNode;
} & Record<string, unknown>) {
  const open = useContext(TryItContext);
  return (
    <Button
      size="sm"
      className="my-1"
      onClick={() => open({ visualizer, props: props as Record<string, string> })}
    >
      <Play aria-hidden="true" />
      {children ?? 'Try it'}
    </Button>
  );
}

const LazyFigure = lazy(() => import('@/visualizers/automaton-figure'));

export function AutomatonFigure(props: ComponentProps<typeof LazyFigure>) {
  return (
    <Suspense fallback={<Skeleton className="my-4 h-40 w-full" />}>
      <LazyFigure {...props} />
    </Suspense>
  );
}

function LessonLink({ href = '', children, ...rest }: ComponentProps<'a'>) {
  if (href.startsWith('/')) return <Link to={href}>{children}</Link>;
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

function ScrollingTable(props: ComponentProps<'table'>) {
  return (
    <div className="my-4 overflow-x-auto">
      <table {...props} />
    </div>
  );
}

/** Every component a lesson may use. A content test checks lessons use only these. */
export const MDX_COMPONENTS = {
  Callout,
  TryIt,
  AutomatonFigure,
  a: LessonLink,
  table: ScrollingTable,
};
