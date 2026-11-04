/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions --
   Clicking the backdrop only repeats what Escape already does, and the options are driven from the
   input with the arrow keys, as ARIA's combobox pattern asks. */
import type { Theme } from '@compilerlab/shared';
import {
  BookOpen,
  CornerDownLeft,
  FlaskConical,
  Layers,
  PanelLeft,
  Search,
  Sparkles,
  SunMoon,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useLabExercises } from '@/hooks/use-lab';
import { useLessons } from '@/hooks/use-lessons';
import { useSettings, useUpdateSettings } from '@/hooks/use-settings';
import { useModules } from '@/hooks/use-system';
import { cn } from '@/lib/cn';
import { useUi } from '@/stores/ui';
import { VISUALIZERS } from '@/visualizers/registry';
import { currentAiContext } from './context-store';

interface Command {
  id: string;
  label: string;
  /** What kind of thing this is, shown at the end of the row. */
  kind: string;
  icon: LucideIcon;
  /** Other words it can be found by. */
  keywords?: string;
  run: () => void;
}

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

const PAGES: readonly { label: string; to: string; keywords?: string }[] = [
  { label: 'Go to the dashboard', to: '/', keywords: 'home progress' },
  { label: 'Go to Learn', to: '/learn', keywords: 'lessons course modules topics' },
  { label: 'Go to Visualize', to: '/visualize', keywords: 'animations automata' },
  { label: 'Go to the lab', to: '/lab', keywords: 'exercises code flex gcc' },
  { label: 'Open free practice in the lab', to: '/lab/practice', keywords: 'scratch code editor' },
  { label: 'Go to Practice', to: '/practice', keywords: 'quiz questions' },
  { label: 'Go to Exam prep', to: '/exam', keywords: 'gate paper' },
  { label: 'Open the AI tutor', to: '/tutor', keywords: 'chat ask gemini' },
  { label: 'Go to Projects', to: '/projects', keywords: 'capstone tinyc' },
  { label: 'Open Settings', to: '/settings', keywords: 'theme font model preferences' },
];

const MAX_ROWS = 40;

/** A question reads differently from a topic name, so it goes to the tutor before anything else. */
function looksLikeQuestion(query: string): boolean {
  return (
    query.endsWith('?') ||
    query.trim().split(/\s+/).length >= 5 ||
    /^(what|why|how|when|where|which|who|can|does|is|are|explain)\b/i.test(query)
  );
}

function matches(command: Command, words: readonly string[]): boolean {
  const haystack = `${command.label} ${command.kind} ${command.keywords ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Part 8's palette: ask anything, jump to any topic, or run an action. */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const navigate = useNavigate();
  const { data: lessons = [] } = useLessons();
  const { data: modules = [] } = useModules();
  const { data: exercises = [] } = useLabExercises();
  const { settings } = useSettings();
  const { mutate: updateSettings } = useUpdateSettings();
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const { theme } = settings;

  // Closing on the way out hands focus back to whatever had it before the palette opened.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  const finish = (run: () => void) => {
    dialog.current?.close();
    run();
  };

  const commands = useMemo<Command[]>(
    () => [
      ...PAGES.map((page): Command => ({
        id: `page:${page.to}`,
        label: page.label,
        kind: 'Page',
        icon: Layers,
        ...(page.keywords ? { keywords: page.keywords } : {}),
        run: () => void navigate(page.to),
      })),
      {
        id: 'action:theme',
        label: `Switch the theme to ${NEXT_THEME[theme]}`,
        kind: 'Action',
        icon: SunMoon,
        keywords: 'dark light appearance',
        run: () => updateSettings({ theme: NEXT_THEME[theme] }),
      },
      {
        id: 'action:sidebar',
        label: 'Show or hide the sidebar',
        kind: 'Action',
        icon: PanelLeft,
        keywords: 'navigation collapse',
        run: toggleSidebar,
      },
      ...modules.map((module): Command => ({
        id: `module:${module.id}`,
        label: `Module ${module.number}: ${module.title}`,
        kind: 'Module',
        icon: BookOpen,
        keywords: module.summary,
        run: () => void navigate(`/learn/${module.id}`),
      })),
      ...lessons.map((lesson): Command => ({
        id: `topic:${lesson.id}`,
        label: lesson.title,
        kind: 'Topic',
        icon: BookOpen,
        keywords: lesson.outcomes.join(' '),
        run: () => void navigate(`/learn/${lesson.module}/${lesson.id}`),
      })),
      ...VISUALIZERS.map((entry): Command => ({
        id: `visualizer:${entry.id}`,
        label: entry.title,
        kind: 'Visualizer',
        icon: Workflow,
        keywords: entry.description,
        run: () => void navigate(`/visualize/${entry.id}`),
      })),
      ...exercises.map((exercise): Command => ({
        id: `exercise:${exercise.id}`,
        label: exercise.title,
        kind: 'Lab exercise',
        icon: FlaskConical,
        keywords: exercise.tags.join(' '),
        run: () => void navigate(`/lab/${exercise.id}`),
      })),
    ],
    [exercises, lessons, modules, navigate, theme, toggleSidebar, updateSettings],
  );

  const rows = useMemo<Command[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) return commands.slice(0, MAX_ROWS);
    const words = trimmed.toLowerCase().split(/\s+/);
    const found = commands.filter((command) => matches(command, words)).slice(0, MAX_ROWS);
    const askAi: Command = {
      id: 'ask',
      label: `Ask AI: ${trimmed}`,
      kind: 'AI tutor',
      icon: Sparkles,
      // The tutor is about to replace this page, so what is on it has to travel with the question.
      run: () => void navigate('/tutor', { state: { ask: trimmed, context: currentAiContext() } }),
    };
    return looksLikeQuestion(trimmed) || found.length === 0 ? [askAi, ...found] : [...found, askAi];
  }, [commands, navigate, query]);

  const highlighted = Math.min(active, Math.max(0, rows.length - 1));

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((highlighted + 1) % Math.max(1, rows.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((highlighted - 1 + rows.length) % Math.max(1, rows.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = rows[highlighted];
      if (command) finish(command.run);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-label="Command palette"
      onClose={() => {
        // A development double-run closes and reopens it, and that close means nothing.
        if (!dialog.current?.open) onClose();
      }}
      onClick={(event) => {
        // A click on the dialog itself, rather than its contents, is a click on the backdrop.
        if (event.target === dialog.current) dialog.current.close();
      }}
      className="fixed top-[12vh] left-1/2 m-0 w-[38rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-line-strong bg-surface p-0 text-ink shadow-xl backdrop:bg-canvas/70"
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows[highlighted] ? `${listId}-${highlighted}` : undefined}
          aria-label="Ask anything, jump to a topic, or run an action"
          placeholder="Ask anything, jump to a topic, or run an action"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-muted"
        />
        <kbd className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs text-ink-muted">
          Esc
        </kbd>
      </div>
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Results"
        className="max-h-[50vh] overflow-y-auto p-1"
      >
        {rows.map((command, index) => {
          const Icon = command.icon;
          const isActive = index === highlighted;
          return (
            <li
              key={command.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={isActive}
              onMouseMove={() => setActive(index)}
              onClick={() => finish(command.run)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                isActive ? 'bg-accent-soft' : '',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              <span className="shrink-0 text-xs text-ink-muted">{command.kind}</span>
              {isActive ? (
                <CornerDownLeft aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
              ) : null}
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
