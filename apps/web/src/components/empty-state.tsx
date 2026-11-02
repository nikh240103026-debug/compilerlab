import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      {icon ? (
        <div className="mx-auto mb-3 flex justify-center text-ink-muted [&_svg]:size-6">{icon}</div>
      ) : null}
      <h2 className="text-base font-semibold">{title}</h2>
      {children ? (
        <div className="mx-auto mt-2 max-w-md text-sm text-ink-muted">{children}</div>
      ) : null}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
