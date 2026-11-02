import { useQueryClient } from '@tanstack/react-query';
import { RotateCw, Unplug } from 'lucide-react';
import { useEffect } from 'react';
import { Outlet, useNavigation } from 'react-router';
import { Toaster } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useApplySettings } from '@/hooks/use-settings';
import { useServerHealth } from '@/hooks/use-system';
import { useUi } from '@/stores/ui';
import { RouteEffects } from './route-effects';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

function RouteProgress() {
  const { state } = useNavigation();
  if (state !== 'loading') return null;
  return (
    <div aria-hidden="true" className="relative h-0.5 shrink-0 overflow-hidden">
      <div className="absolute inset-y-0 w-1/4 animate-progress bg-accent" />
    </div>
  );
}

function ServerBanner() {
  const { isError } = useServerHealth();
  const client = useQueryClient();
  if (!isError) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning bg-surface px-4 py-2 text-sm"
    >
      <Unplug aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <span>
        The local server is not responding. Your work is safe. Check that the terminal running{' '}
        <code className="font-mono text-[0.8125rem]">npm start</code> is still open.
      </span>
      <Button size="sm" className="ml-auto" onClick={() => void client.invalidateQueries()}>
        <RotateCw aria-hidden="true" />
        Reconnect
      </Button>
    </div>
  );
}

export function AppShell() {
  useApplySettings();
  const sidebarCollapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const isWide = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Sidebar collapsed={sidebarCollapsed || !isWide} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar canCollapse={isWide} />
        <RouteProgress />
        <ServerBanner />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <Toaster />
      <RouteEffects />
    </div>
  );
}

/** Shown for the moment before the first page's code has loaded. */
export function ShellFallback() {
  return <div className="h-dvh bg-canvas" />;
}
