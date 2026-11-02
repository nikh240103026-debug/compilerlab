import {
  BookOpen,
  ChevronDown,
  FlaskConical,
  GraduationCap,
  Hammer,
  LayoutDashboard,
  ListChecks,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import { Logo } from '@/components/logo';
import { ModuleChip } from '@/components/module-chip';
import { Skeleton } from '@/components/ui/skeleton';
import { useModules } from '@/hooks/use-system';
import { cn } from '@/lib/cn';
import { useUi } from '@/stores/ui';

interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const LEARN: NavEntry = { to: '/learn', label: 'Learn', icon: BookOpen };

const BEFORE_LEARN: readonly NavEntry[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
];

const AFTER_LEARN: readonly NavEntry[] = [
  { to: '/visualize', label: 'Visualize', icon: Workflow },
  { to: '/lab', label: 'Lab', icon: FlaskConical },
  { to: '/practice', label: 'Practice', icon: ListChecks },
  { to: '/exam', label: 'Exam prep', icon: GraduationCap },
  { to: '/tutor', label: 'AI tutor', icon: Sparkles },
  { to: '/projects', label: 'Projects', icon: Hammer },
];

const SETTINGS: NavEntry = { to: '/settings', label: 'Settings', icon: Settings };

function NavItem({ entry, collapsed }: { entry: NavEntry; collapsed: boolean }) {
  const Icon = entry.icon;
  return (
    <NavLink
      to={entry.to}
      end={entry.end ?? false}
      aria-label={collapsed ? entry.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-(--duration-fast)',
          isActive ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            aria-hidden="true"
            className={cn('size-4 shrink-0', isActive ? 'text-accent' : '')}
          />
          {collapsed ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-full z-40 ml-2 hidden rounded-md border border-line bg-surface-3 px-2 py-1 text-xs whitespace-nowrap text-ink shadow-md group-hover:block group-focus-visible:block"
            >
              {entry.label}
            </span>
          ) : (
            <span className="truncate">{entry.label}</span>
          )}
        </>
      )}
    </NavLink>
  );
}

function ModuleLinks() {
  const { data: modules, isPending, error } = useModules();
  if (isPending) {
    return (
      <div className="space-y-2 py-1 pl-3" aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  if (error || !modules) {
    return <p className="px-3 py-1 text-xs text-ink-muted">Modules are unavailable right now.</p>;
  }
  return (
    <ul>
      {modules.map((module) => (
        <li key={module.id}>
          <NavLink
            to={`/learn/${module.id}`}
            className={({ isActive }) =>
              cn(
                'flex min-h-8 items-center gap-2 rounded-md py-1 pr-2 pl-2 text-[0.8125rem] leading-tight transition-colors duration-(--duration-fast)',
                isActive
                  ? 'bg-surface-2 font-medium text-ink'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )
            }
          >
            <ModuleChip number={module.number} />
            <span className="min-w-0">{module.title}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const modulesOpen = useUi((state) => state.modulesOpen);
  const toggleModules = useUi((state) => state.toggleModules);
  const { pathname } = useLocation();
  const showModules = !collapsed && (modulesOpen || pathname.startsWith('/learn/'));

  return (
    <aside
      style={{ width: collapsed ? 'var(--sidebar-rail-width)' : 'var(--sidebar-width)' }}
      className="flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-(--duration-base)"
    >
      <div
        className={cn(
          'flex h-12 items-center gap-2 border-b border-line',
          collapsed ? 'justify-center' : 'px-4',
        )}
      >
        <Logo />
        {collapsed ? (
          <span className="sr-only">CompilerLab</span>
        ) : (
          <span className="text-sm font-semibold tracking-tight">CompilerLab</span>
        )}
      </div>

      <nav
        aria-label="Main"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-0.5 p-2',
          collapsed ? '' : 'overflow-y-auto',
        )}
      >
        {BEFORE_LEARN.map((entry) => (
          <NavItem key={entry.to} entry={entry} collapsed={collapsed} />
        ))}

        <div className="relative">
          <NavItem entry={LEARN} collapsed={collapsed} />
          {collapsed ? null : (
            <button
              type="button"
              aria-expanded={showModules}
              aria-label={showModules ? 'Hide course modules' : 'Show course modules'}
              onClick={toggleModules}
              className="absolute top-1 right-1 flex size-7 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-3 hover:text-ink"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'size-4 transition-transform duration-(--duration-fast)',
                  showModules ? '' : '-rotate-90',
                )}
              />
            </button>
          )}
        </div>
        {showModules ? (
          <div className="mb-1 ml-3 border-l border-line pl-1">
            <ModuleLinks />
          </div>
        ) : null}

        {AFTER_LEARN.map((entry) => (
          <NavItem key={entry.to} entry={entry} collapsed={collapsed} />
        ))}

        <div className="mt-auto pt-2">
          <NavItem entry={SETTINGS} collapsed={collapsed} />
        </div>
      </nav>
    </aside>
  );
}
