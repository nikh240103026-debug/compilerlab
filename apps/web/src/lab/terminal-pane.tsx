import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useIsDark } from './use-document-theme';

export interface TerminalHandle {
  write(text: string): void;
  clear(): void;
}

function themeFromTokens(): ITheme {
  const read = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return {
    background: read('--surface'),
    foreground: read('--ink'),
    cursor: read('--surface'),
    selectionBackground: read('--accent-soft'),
    selectionForeground: read('--ink'),
    red: read('--danger'),
    brightRed: read('--danger'),
    green: read('--success'),
    yellow: read('--warning'),
    brightBlack: read('--ink-muted'),
  };
}

/** The live view of a job. It only shows output, because input comes from the input pane. */
const TerminalPane = forwardRef<TerminalHandle, { fontSize: number }>(function TerminalPane(
  { fontSize },
  ref,
) {
  const isDark = useIsDark();
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const instance = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      scrollback: 10_000,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize,
      theme: themeFromTokens(),
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(container.current);
    terminal.current = instance;

    const refit = () => {
      // A hidden tab has no size, and fitting then would shrink the terminal to nothing.
      if (container.current?.offsetParent) fit.fit();
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      terminal.current = null;
    };
    // The font and colors are updated below, without losing what is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = themeFromTokens();
  }, [isDark]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.fontSize = fontSize;
  }, [fontSize]);

  useImperativeHandle(ref, () => ({
    write: (text) => terminal.current?.write(text),
    clear: () => {
      terminal.current?.reset();
    },
  }));

  return <div ref={container} data-testid="terminal" className="h-full min-h-40 w-full" />;
});

export default TerminalPane;
