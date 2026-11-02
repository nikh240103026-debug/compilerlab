import type { CourseModule } from '@compilerlab/shared';
import type { Params } from 'react-router';
import { useMatches } from 'react-router';
import { useModules } from '@/hooks/use-system';

export interface RouteHandle {
  crumb:
    string | ((context: { params: Params; modules: readonly CourseModule[] }) => string | null);
}

export interface Crumb {
  label: string;
  to: string;
}

/** The breadcrumb trail for the current page, built from each matched route's handle. */
export function useCrumbs(): Crumb[] {
  const matches = useMatches();
  const { data: modules = [] } = useModules();
  return matches.flatMap((match) => {
    const crumb = (match.handle as RouteHandle | undefined)?.crumb;
    if (!crumb) return [];
    const label = typeof crumb === 'function' ? crumb({ params: match.params, modules }) : crumb;
    return label ? [{ label, to: match.pathname }] : [];
  });
}
