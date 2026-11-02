import type { Theme } from '@compilerlab/shared';
import { ChevronRight, Monitor, Moon, PanelLeft, Sun } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useSettings, useUpdateSettings } from '@/hooks/use-settings';
import { useSystemStatus } from '@/hooks/use-system';
import { cn } from '@/lib/cn';
import { useUi } from '@/stores/ui';
import { useCrumbs } from './use-crumbs';

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

function Breadcrumbs() {
  const crumbs = useCrumbs();
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.to}>
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
              ) : null}
              <li className="min-w-0 truncate">
                {isLast ? (
                  <span aria-current="page" className="font-medium">
                    {crumb.label}
                  </span>
                ) : (
                  <Link to={crumb.to} className="text-ink-muted hover:text-ink">
                    {crumb.label}
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

function StatusLink({
  label,
  state,
  text,
}: {
  label: string;
  state: 'good' | 'warn';
  text: string;
}) {
  return (
    <Link
      to="/settings#system"
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', state === 'good' ? 'bg-success' : 'bg-warning')}
      />
      <span>
        {label}: <span className="font-medium text-ink">{text}</span>
      </span>
    </Link>
  );
}

function SystemIndicators() {
  const { data: status } = useSystemStatus();
  if (!status) return null;
  return (
    <div className="hidden items-center gap-1 md:flex">
      <StatusLink
        label="Lab"
        state={status.labMode === 'real' ? 'good' : 'warn'}
        text={status.labMode === 'real' ? 'Real tools' : 'Simulated'}
      />
      <StatusLink
        label="AI"
        state={status.gemini.configured ? 'good' : 'warn'}
        text={status.gemini.configured ? 'Key set' : 'No key'}
      />
    </div>
  );
}

function ThemeButton() {
  const { settings } = useSettings();
  const { mutate } = useUpdateSettings();
  const Icon = THEME_ICON[settings.theme];
  const next = NEXT_THEME[settings.theme];
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Theme: ${settings.theme}. Switch to ${next}.`}
      title={`Theme: ${settings.theme}`}
      onClick={() => mutate({ theme: next })}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}

export function Topbar({ canCollapse }: { canCollapse: boolean }) {
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      {canCollapse ? (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Toggle sidebar"
          title="Toggle sidebar (Ctrl+B)"
          onClick={toggleSidebar}
        >
          <PanelLeft aria-hidden="true" />
        </Button>
      ) : null}
      <Breadcrumbs />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SystemIndicators />
        <ThemeButton />
      </div>
    </header>
  );
}
