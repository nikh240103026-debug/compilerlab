import { lazy, Suspense, useEffect } from 'react';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { useSettings } from '@/hooks/use-settings';
import { usePalette } from './palette-store';

// This file is in the initial bundle. The palette itself loads the first time it opens.
const CommandPalette = lazy(() => import('./command-palette'));

/** Listens for Ctrl+K everywhere, including inside the code editor. */
export function CommandPaletteHost() {
  const open = usePalette((state) => state.open);
  const hide = usePalette((state) => state.hide);
  const toggle = usePalette((state) => state.toggle);
  const { settings } = useSettings();
  const { editorKeymap } = settings;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (event.shiftKey || event.altKey) return;
      // In Vim and Emacs key bindings, Ctrl+K already means something in the editor.
      const target = event.target as HTMLElement | null;
      if (editorKeymap !== 'default' && target?.closest?.('.monaco-editor')) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    // The capture phase, because Monaco uses Ctrl+K to start its own shortcuts and stops the event.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [editorKeymap, toggle]);

  if (!open) return null;
  return (
    <ErrorBoundary fallback={() => null}>
      <Suspense fallback={null}>
        <CommandPalette onClose={hide} />
      </Suspense>
    </ErrorBoundary>
  );
}
