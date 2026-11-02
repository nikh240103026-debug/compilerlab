import type { RouteObject } from 'react-router';
import { RouteError } from '@/components/route-error';
import { AppShell, ShellFallback } from '@/layout/app-shell';
import type { RouteHandle } from '@/layout/use-crumbs';
import { findVisualizer } from '@/visualizers/registry';

// Every page is its own chunk. Each loader is a stable import() so preloading reuses it.
export const pages = {
  dashboard: () => import('@/routes/dashboard'),
  learn: () => import('@/routes/learn'),
  learnModule: () => import('@/routes/learn-module'),
  lesson: () => import('@/routes/lesson'),
  visualize: () => import('@/routes/visualize'),
  visualizeDetail: () => import('@/routes/visualize-detail'),
  lab: () => import('@/routes/lab'),
  practice: () => import('@/routes/practice'),
  exam: () => import('@/routes/exam'),
  tutor: () => import('@/routes/tutor'),
  projects: () => import('@/routes/projects'),
  settings: () => import('@/routes/settings'),
  notFound: () => import('@/routes/not-found'),
};

function page(path: string, lazy: () => Promise<object>, crumb: RouteHandle['crumb']): RouteObject {
  return { path, lazy, handle: { crumb } satisfies RouteHandle };
}

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: AppShell,
    HydrateFallback: ShellFallback,
    ErrorBoundary: RouteError,
    children: [
      {
        // A pathless layer so a failing page shows its error inside the shell.
        ErrorBoundary: RouteError,
        children: [
          {
            index: true,
            lazy: pages.dashboard,
            handle: { crumb: 'Dashboard' } satisfies RouteHandle,
          },
          {
            path: 'learn',
            handle: { crumb: 'Learn' } satisfies RouteHandle,
            children: [
              { index: true, lazy: pages.learn },
              {
                path: ':moduleId',
                handle: {
                  crumb: ({ params, modules }) =>
                    modules.find((module) => module.id === params.moduleId)?.title ?? null,
                } satisfies RouteHandle,
                children: [
                  { index: true, lazy: pages.learnModule },
                  page(':topicId', pages.lesson, ({ params, lessons }) => {
                    return lessons.find((lesson) => lesson.id === params.topicId)?.title ?? null;
                  }),
                ],
              },
            ],
          },
          {
            path: 'visualize',
            handle: { crumb: 'Visualize' } satisfies RouteHandle,
            children: [
              { index: true, lazy: pages.visualize },
              page(
                ':visualizerId',
                pages.visualizeDetail,
                ({ params }) => findVisualizer(params.visualizerId)?.title ?? null,
              ),
            ],
          },
          page('lab', pages.lab, 'Lab'),
          page('practice', pages.practice, 'Practice'),
          page('exam', pages.exam, 'Exam prep'),
          page('tutor', pages.tutor, 'AI tutor'),
          page('projects', pages.projects, 'Projects'),
          page('settings', pages.settings, 'Settings'),
          page('*', pages.notFound, 'Page not found'),
        ],
      },
    ],
  },
];

/** Loads the small page chunks when idle so route changes stay under 100 ms. */
export function preloadPages(): void {
  const load = () => Object.values(pages).forEach((loadPage) => void loadPage().catch(() => {}));
  if ('requestIdleCallback' in window) requestIdleCallback(load);
  else setTimeout(load, 200);
}
