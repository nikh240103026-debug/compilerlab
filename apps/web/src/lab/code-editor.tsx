import type { LabDiagnostic, LabFile } from '@compilerlab/shared';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { applyEditorTheme, languageFor, monaco } from './monaco';
import { useIsDark } from './use-document-theme';

export interface CodeEditorHandle {
  revealLine(file: string, line: number, column: number | null): void;
}

export interface CodeEditorProps {
  files: readonly LabFile[];
  activeFile: string | null;
  onChange: (name: string, content: string) => void;
  onRun: () => void;
  diagnostics: readonly LabDiagnostic[];
  fontSize: number;
  keymap: 'default' | 'vim' | 'emacs';
}

const SHARED_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'compilerlab',
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  tabSize: 2,
  renderLineHighlight: 'line',
  fixedOverflowWidgets: true,
  // Tab has to be able to leave the editor, or keyboard users are trapped in it.
  tabFocusMode: false,
  accessibilitySupport: 'auto',
};

const SEVERITY = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  note: monaco.MarkerSeverity.Info,
} as const;

function uriFor(name: string): monaco.Uri {
  return monaco.Uri.parse(`inmemory://lab/${name}`);
}

function useEditorTheme(): void {
  const isDark = useIsDark();
  useEffect(() => applyEditorTheme(isDark), [isDark]);
}

/** The student's files. Each is a Monaco model, so undo history survives switching between them. */
const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { files, activeFile, onChange, onRun, diagnostics, fontSize, keymap },
  ref,
) {
  useEditorTheme();
  const container = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const shownFile = useRef<string | null>(null);
  const latest = useRef({ onChange, onRun });
  latest.current = { onChange, onRun };

  useEffect(() => {
    if (!container.current) return;
    const instance = monaco.editor.create(container.current, {
      ...SHARED_OPTIONS,
      fontSize,
      model: null,
      ariaLabel: 'Code editor. Press Alt+F1 for editor help.',
    });
    editor.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => latest.current.onRun());
    const listener = instance.onDidChangeModelContent(() => {
      const model = instance.getModel();
      const name = shownFile.current;
      if (model && name) latest.current.onChange(name, model.getValue());
    });
    return () => {
      listener.dispose();
      instance.dispose();
      for (const model of monaco.editor.getModels()) {
        if (model.uri.authority === 'lab') model.dispose();
      }
      editor.current = null;
    };
    // The font size is applied below, without recreating the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editor.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Keeps models in step with the files: new ones, removed ones, and outside changes.
  useEffect(() => {
    const names = new Set(files.map((file) => file.name));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.authority === 'lab' && !names.has(model.uri.path.slice(1))) model.dispose();
    }
    for (const file of files) {
      const uri = uriFor(file.name);
      const existing = monaco.editor.getModel(uri);
      if (!existing) {
        monaco.editor.createModel(file.content, languageFor(file.name), uri);
      } else if (existing.getValue() !== file.content) {
        existing.setValue(file.content);
      }
    }
  }, [files]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    if (shownFile.current) viewStates.current.set(shownFile.current, instance.saveViewState());
    shownFile.current = activeFile;
    const model = activeFile ? monaco.editor.getModel(uriFor(activeFile)) : null;
    instance.setModel(model);
    const saved = activeFile ? viewStates.current.get(activeFile) : null;
    if (saved) instance.restoreViewState(saved);
  }, [activeFile, files]);

  // Compiler errors become squiggles under the code.
  useEffect(() => {
    for (const file of files) {
      const model = monaco.editor.getModel(uriFor(file.name));
      if (!model) continue;
      const markers = diagnostics
        .filter((item) => item.file === file.name && item.line !== null)
        .map((item): monaco.editor.IMarkerData => {
          const line = Math.min(item.line as number, model.getLineCount());
          const column = item.column ?? model.getLineFirstNonWhitespaceColumn(line) ?? 1;
          const word = model.getWordAtPosition({ lineNumber: line, column });
          return {
            severity: SEVERITY[item.severity],
            message: item.explanation ? `${item.message}\n\n${item.explanation}` : item.message,
            source: item.tool,
            startLineNumber: line,
            startColumn: word?.startColumn ?? column,
            endLineNumber: line,
            endColumn: word?.endColumn ?? model.getLineMaxColumn(line),
          };
        });
      monaco.editor.setModelMarkers(model, 'compilerlab', markers);
    }
  }, [diagnostics, files]);

  // The key bindings load only for someone who chose them in Settings.
  useEffect(() => {
    const instance = editor.current;
    if (!instance || keymap === 'default') return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    const attach = async () => {
      if (keymap === 'vim') {
        const { initVimMode } = await import('monaco-vim');
        if (cancelled || !status.current) return;
        const mode = initVimMode(instance, status.current);
        dispose = () => mode.dispose();
      } else {
        const { EmacsExtension } = await import('monaco-emacs');
        if (cancelled) return;
        const extension = new EmacsExtension(instance);
        extension.start();
        dispose = () => extension.dispose();
      }
    };
    void attach();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [keymap]);

  useImperativeHandle(ref, () => ({
    revealLine(file, line, column) {
      const instance = editor.current;
      if (!instance) return;
      // The file may have only just been opened, so wait for its model to be shown.
      requestAnimationFrame(() => {
        if (shownFile.current !== file) return;
        const position = { lineNumber: line, column: column ?? 1 };
        instance.revealPositionInCenter(position);
        instance.setPosition(position);
        instance.focus();
      });
    },
  }));

  return (
    <div className="flex h-full min-h-48 flex-col">
      <div ref={container} data-testid="code-editor" className="min-h-0 flex-1" />
      {keymap === 'vim' ? (
        <div
          ref={status}
          className="shrink-0 border-t border-line px-2 py-0.5 font-mono text-xs text-ink-muted"
        />
      ) : null}
    </div>
  );
});

export default CodeEditor;

/** A generated file, like lex.yy.c, which can be read and searched but not changed. */
export function ReadOnlyCode({
  name,
  content,
  fontSize,
}: {
  name: string;
  content: string;
  fontSize: number;
}) {
  useEditorTheme();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const model = monaco.editor.createModel(content, languageFor(name));
    const instance = monaco.editor.create(container.current, {
      ...SHARED_OPTIONS,
      fontSize,
      model,
      readOnly: true,
      ariaLabel: `${name}, generated, read only`,
    });
    return () => {
      instance.dispose();
      model.dispose();
    };
  }, [name, content, fontSize]);

  return <div ref={container} data-testid="generated-code" className="h-full min-h-48" />;
}
