import type {
  CompilerFlag,
  LabEngineChoice,
  LabEvent,
  LabExerciseView,
  LabFile,
  LabJob,
  LabPipeline,
  LabWorkspace,
} from '@compilerlab/shared';
import {
  C_STANDARDS,
  COMPILER_FLAGS,
  CPP_STANDARDS,
  LAB_PIPELINES,
  LAB_PIPELINE_LABELS,
} from '@compilerlab/shared/lab';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Eye, Play, Square } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLabAiContext } from '@/ai/lab-context';
import type { LabHelpRequest } from '@/ai/lab-help';
import { LabModeBadge } from '@/components/system-status';
import { SplitPane } from '@/components/split-pane';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettings } from '@/hooks/use-settings';
import { useSystemStatus } from '@/hooks/use-system';
import { api } from '@/lib/api';
import type { CodeEditorHandle } from './code-editor';
import { ExercisePanel, FilePanel } from './side-panels';
import { useLabRun } from './lab-run';
import { ResultTabs, type ResultTab } from './result-tabs';
import type { LabTemplate } from './templates';
import type { TerminalHandle } from './terminal-pane';

// Monaco and xterm are big, so they load with the workspace and never with the app.
const CodeEditor = lazy(() => import('./code-editor'));
const LabHelp = lazy(() => import('@/ai/lab-help'));

const SAVE_DELAY_MS = 600;
const TOOLBAR_SELECT = 'h-8 w-auto py-0 pr-7 pl-2 text-xs';

function EditorFallback() {
  return <Skeleton className="h-full min-h-48 w-full" />;
}

/** Keeps the student's work saved on this computer, a moment after each change. */
function useAutosave(id: string, workspace: LabWorkspace, onError: (message: string) => void) {
  const latest = useRef(workspace);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const saveNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    api.saveLabWorkspace(id, latest.current).catch((error: unknown) => {
      onErrorRef.current(error instanceof Error ? error.message : 'Your work could not be saved.');
    });
  }, [id]);

  useEffect(() => {
    latest.current = workspace;
    if (first.current) {
      first.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(saveNow, SAVE_DELAY_MS);
  }, [workspace, saveNow]);

  // Leaving the page must not lose the last few keystrokes.
  useEffect(
    () => () => {
      if (timer.current) saveNow();
    },
    [saveNow],
  );
}

export interface WorkspaceProps {
  /** Where the work is saved: an exercise id, or "scratch" for free practice. */
  id: string;
  title: string;
  exercise: LabExerciseView | null;
  initial: LabWorkspace;
}

export function Workspace({ id, title, exercise, initial }: WorkspaceProps) {
  const { settings } = useSettings();
  const { data: system } = useSystemStatus();
  const client = useQueryClient();

  const [files, setFiles] = useState<LabFile[]>(initial.files);
  const [stdin, setStdin] = useState(initial.stdin);
  const [pipeline, setPipeline] = useState<LabPipeline>(initial.pipeline);
  const [activeFile, setActiveFile] = useState<string | null>(initial.files[0]?.name ?? null);
  const [standard, setStandard] = useState('');
  const [flags, setFlags] = useState<CompilerFlag[]>([]);
  const [engine, setEngine] = useState<LabEngineChoice>('auto');
  const [tab, setTab] = useState<ResultTab>('terminal');
  const [saveError, setSaveError] = useState<string | null>(null);

  useAutosave(id, { files, stdin, pipeline }, setSaveError);

  const editor = useRef<CodeEditorHandle | null>(null);
  const terminal = useRef<TerminalHandle | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const onEvent = useCallback(
    (event: LabEvent) => {
      const screen = terminal.current;
      switch (event.type) {
        case 'started':
          if (event.engine === 'simulated') {
            screen?.write(`\x1b[33m[Simulated] ${event.note ?? ''}\x1b[0m\n`);
          }
          break;
        case 'step':
          screen?.write(`\x1b[90m$ ${event.command}\x1b[0m\n`);
          break;
        case 'output':
          screen?.write(event.stream === 'stderr' ? `\x1b[31m${event.data}\x1b[0m` : event.data);
          break;
        case 'step-end':
          if (event.outcome === 'failed' || event.outcome === 'crashed') setTab('build');
          if (event.message) screen?.write(`\x1b[33m${event.message}\x1b[0m\n`);
          break;
        case 'check':
          setTab('tests');
          break;
        case 'done':
          screen?.write(`\x1b[90m${event.message}\x1b[0m\n`);
          if (event.outcome === 'ok') void client.invalidateQueries({ queryKey: ['lab-progress'] });
          break;
        case 'error':
          setTab('build');
          screen?.write(`\x1b[31m${event.message}\x1b[0m\n`);
          break;
        default:
      }
    },
    [client],
  );

  const { state: run, start, stop } = useLabRun(onEvent);
  const running = run.status === 'running';

  // Every AI call from this page can see the files and the last run.
  useLabAiContext({ exercise, files, stdin, pipeline, activeFile, run });
  const [helpRequest, setHelpRequest] = useState<LabHelpRequest | null>(null);
  const explainInHelp = useCallback((question: string) => {
    setHelpRequest((current) => ({ id: (current?.id ?? 0) + 1, question }));
    setTab('ai');
  }, []);
  const replaceFile = useCallback((name: string, content: string) => {
    setFiles((current) =>
      current.some((file) => file.name === name)
        ? current.map((file) => (file.name === name ? { ...file, content } : file))
        : [...current, { name, content }],
    );
    setActiveFile(name);
  }, []);

  const buildJob = useCallback(
    (): LabJob => ({
      pipeline,
      engine,
      files: filesRef.current,
      stdin,
      flags,
      ...(standard ? { standard } : {}),
    }),
    [pipeline, engine, stdin, flags, standard],
  );

  const runProgram = useCallback(() => {
    if (running) return;
    terminal.current?.clear();
    setTab('terminal');
    start({ type: 'run', job: buildJob() });
  }, [running, start, buildJob]);

  const checkExercise = () => {
    if (!exercise || running) return;
    terminal.current?.clear();
    setTab('terminal');
    start({ type: 'check', exerciseId: exercise.id, job: buildJob() });
  };

  const changePipeline = (next: LabPipeline) => {
    setPipeline(next);
    setStandard('');
  };

  const onEdit = useCallback((name: string, content: string) => {
    setFiles((current) => {
      const existing = current.find((file) => file.name === name);
      if (!existing || existing.content === content) return current;
      return current.map((file) => (file.name === name ? { ...file, content } : file));
    });
  }, []);

  const replaceFiles = (next: readonly LabFile[]) => {
    setFiles([...next]);
    setActiveFile(next[0]?.name ?? null);
  };

  const useTemplate = (template: LabTemplate) => {
    replaceFiles(template.files);
    setStdin(template.stdin);
    changePipeline(template.pipeline);
  };

  const goToLine = (file: string, line: number, column: number | null) => {
    if (files.some(({ name }) => name === file)) {
      setActiveFile(file);
      editor.current?.revealLine(file, line, column);
    }
  };

  const standards: readonly string[] = pipeline === 'cpp' ? CPP_STANDARDS : C_STANDARDS;
  const pipelineId = useId();
  const standardId = useId();
  const engineId = useId();
  const canVisualize = run.visual !== null;
  const shownMode = run.engine ?? system?.labMode ?? null;

  return (
    <div className="flex h-full min-h-[34rem] flex-col gap-2 p-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {shownMode ? <LabModeBadge mode={shownMode} /> : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <label htmlFor={pipelineId} className="sr-only">
            Pipeline
          </label>
          <NativeSelect
            id={pipelineId}
            value={pipeline}
            title="Pipeline"
            className={TOOLBAR_SELECT}
            onChange={(event) => changePipeline(event.target.value as LabPipeline)}
          >
            {LAB_PIPELINES.map((value) => (
              <option key={value} value={value}>
                {LAB_PIPELINE_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
          <label htmlFor={standardId} className="sr-only">
            Language standard
          </label>
          <NativeSelect
            id={standardId}
            value={standard}
            title="Language standard"
            className={TOOLBAR_SELECT}
            onChange={(event) => setStandard(event.target.value)}
          >
            <option value="">Default standard</option>
            {standards.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </NativeSelect>
          <details className="relative">
            <summary className="flex h-8 cursor-pointer items-center rounded-md border border-line-strong px-2 text-xs font-medium">
              Flags{flags.length > 0 ? ` (${flags.length})` : ''}
            </summary>
            <fieldset className="absolute right-0 z-20 mt-1 w-40 space-y-1 rounded-md border border-line-strong bg-surface p-2 shadow-md">
              <legend className="sr-only">Compiler flags</legend>
              {COMPILER_FLAGS.map((flag) => (
                <label key={flag} className="flex items-center gap-2 font-mono text-xs">
                  <input
                    type="checkbox"
                    checked={flags.includes(flag)}
                    onChange={(event) =>
                      setFlags((current) =>
                        event.target.checked
                          ? [...current, flag]
                          : current.filter((item) => item !== flag),
                      )
                    }
                  />
                  {flag}
                </label>
              ))}
            </fieldset>
          </details>
          <label htmlFor={engineId} className="sr-only">
            Engine
          </label>
          <NativeSelect
            id={engineId}
            value={engine}
            title="Engine"
            className={TOOLBAR_SELECT}
            onChange={(event) => setEngine(event.target.value as LabEngineChoice)}
          >
            <option value="auto">Real tools if found</option>
            <option value="simulated">Simulated</option>
          </NativeSelect>
          {running ? (
            <Button size="sm" variant="ghost" onClick={stop}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={runProgram} title="Ctrl+Enter in the editor">
              <Play aria-hidden="true" />
              Run
            </Button>
          )}
          {exercise ? (
            <Button size="sm" variant="ghost" disabled={running} onClick={checkExercise}>
              <ClipboardCheck aria-hidden="true" />
              Check
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!canVisualize}
            title={canVisualize ? undefined : 'Run a Lex program first'}
            onClick={() => setTab('visual')}
          >
            <Eye aria-hidden="true" />
            Visualize
          </Button>
        </div>
      </header>

      {saveError ? (
        <p role="alert" className="rounded-md border border-danger px-2 py-1 text-xs text-danger">
          Your latest changes could not be saved: {saveError}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        <SplitPane
          storageKey="lab-sidebar"
          label="Resize the side panel"
          defaultRatio={0.24}
          min={0.16}
          max={0.45}
          start={
            <div className="space-y-3 pr-1">
              {exercise ? (
                <ExercisePanel
                  exercise={exercise}
                  onUseFiles={replaceFiles}
                  onUseStdin={setStdin}
                />
              ) : null}
              <FilePanel
                files={files}
                activeFile={activeFile}
                onOpen={setActiveFile}
                onChange={setFiles}
                {...(exercise ? {} : { onUseTemplate: useTemplate })}
              />
            </div>
          }
          end={
            <SplitPane
              storageKey="lab-editor"
              label="Resize the editor and results"
              direction="rows"
              defaultRatio={0.58}
              min={0.2}
              max={0.85}
              start={
                <div className="h-full overflow-hidden rounded-md border border-line">
                  {files.length > 0 ? (
                    <Suspense fallback={<EditorFallback />}>
                      <CodeEditor
                        ref={editor}
                        files={files}
                        activeFile={activeFile}
                        onChange={onEdit}
                        onRun={runProgram}
                        diagnostics={run.diagnostics}
                        fontSize={Math.max(12, settings.fontSize - 2)}
                        keymap={settings.editorKeymap}
                      />
                    </Suspense>
                  ) : (
                    <p className="p-4 text-sm text-ink-muted">
                      Add a file from the side panel to start writing code.
                    </p>
                  )}
                </div>
              }
              end={
                <ResultTabs
                  run={run}
                  tab={tab}
                  onTab={setTab}
                  stdin={stdin}
                  onStdin={setStdin}
                  terminalRef={terminal}
                  fontSize={Math.max(12, settings.fontSize - 2)}
                  onGoToLine={goToLine}
                  onExplain={explainInHelp}
                  aiHelp={
                    <Suspense fallback={<Skeleton className="m-2 h-24" />}>
                      <LabHelp
                        run={run}
                        files={files}
                        exercise={exercise}
                        request={helpRequest}
                        onReplaceFile={replaceFile}
                        onUseStdin={setStdin}
                      />
                    </Suspense>
                  }
                />
              }
            />
          }
        />
      </div>
    </div>
  );
}
