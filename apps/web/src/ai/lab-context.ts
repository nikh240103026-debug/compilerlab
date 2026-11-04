import type { LabExerciseView, LabFile, LabPipeline } from '@compilerlab/shared';
import type { LabRunState } from '@/lab/lab-run';
import { useAiContextSection } from './context-store';

export function labBuildLog(run: LabRunState): string {
  return run.steps
    .filter((step) => step.id !== 'run')
    .map((step) =>
      [
        `$ ${step.command}`,
        step.output.trimEnd(),
        step.outcome ? `(${step.label}: ${step.outcome})` : '',
        step.message ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}

export function labProgramOutput(run: LabRunState): string {
  const printed = run.programOutput.map((part) => part.text).join('');
  const runStep = run.steps.find((step) => step.id === 'run');
  const ending = runStep?.outcome && runStep.outcome !== 'ok' ? runStep.message : null;
  return [printed, ending ? `(The program ended: ${ending})` : ''].filter(Boolean).join('\n');
}

export function labDiagnostics(run: LabRunState): string[] {
  return run.diagnostics
    .filter((item) => item.severity !== 'note')
    .map((item) => {
      const where = item.file && item.line !== null ? `${item.file}:${item.line}` : item.tool;
      return `${where}: ${item.severity}: ${item.message}${item.explanation ? ` (${item.explanation})` : ''}`;
    });
}

/** Adds the student's files and last run to every AI call made while the lab is open. */
export function useLabAiContext(lab: {
  exercise: LabExerciseView | null;
  files: readonly LabFile[];
  stdin: string;
  pipeline: LabPipeline;
  activeFile: string | null;
  run: LabRunState;
}): void {
  useAiContextSection('lab', () => {
    const { exercise, files, stdin, pipeline, activeFile, run } = lab;
    return {
      ...(exercise
        ? {
            exerciseId: exercise.id,
            exerciseTitle: exercise.title,
            exerciseBrief: exercise.brief,
          }
        : {}),
      pipeline,
      ...(run.engine ? { engine: run.engine } : {}),
      ...(activeFile ? { activeFile } : {}),
      files: files.map(({ name, content }) => ({ name, content })),
      stdin,
      ...(run.status === 'idle'
        ? {}
        : {
            buildLog: labBuildLog(run),
            output: labProgramOutput(run),
            diagnostics: labDiagnostics(run),
          }),
      ...(run.check
        ? {
            tests: run.check.results.map((result) => ({
              name: result.name,
              passed: result.passed,
              hidden: result.hidden,
              ...(result.passed
                ? {}
                : { input: result.input, expected: result.expected, actual: result.actual }),
            })),
          }
        : {}),
    };
  });
}
