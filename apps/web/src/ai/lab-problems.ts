import type { LabRunState } from '@/lab/lab-run';

export type LabProblemKind =
  | 'undefined-reference'
  | 'conflict'
  | 'segfault'
  | 'hang'
  | 'compile-error'
  | 'failed-tests'
  | 'job-error';

export interface LabProblem {
  kind: LabProblemKind;
  /** The button's text. */
  label: string;
  /** What the tutor is asked. */
  question: string;
}

const CONFLICT = /shift\/reduce|reduce\/reduce|\bconflicts?\b/i;
const UNDEFINED_REFERENCE = /undefined reference|unresolved external|ld returned/i;
const CRASH = /segmentation fault|core dumped|sigsegv|sigabrt|bus error/i;

/**
 * What went wrong in the last run, in the order that most helps a student. Each kind gets its own
 * question, because a linker error and a segfault need very different explanations.
 */
export function detectLabProblems(run: LabRunState): LabProblem[] {
  const problems: LabProblem[] = [];
  const errors = run.diagnostics.filter((item) => item.severity === 'error');
  const warnings = run.diagnostics.filter((item) => item.severity === 'warning');
  const allOutput = run.steps.map((step) => `${step.output}\n${step.message ?? ''}`).join('\n');
  const undefinedReference = errors.find((item) => UNDEFINED_REFERENCE.test(item.message));
  const conflict = [...errors, ...warnings].find((item) => CONFLICT.test(item.message));
  const otherError = errors.find((item) => item !== undefinedReference && item !== conflict);

  if (undefinedReference || UNDEFINED_REFERENCE.test(allOutput)) {
    problems.push({
      kind: 'undefined-reference',
      label: 'Explain the undefined reference',
      question: `The linker says: "${undefinedReference?.message ?? 'undefined reference'}". What does an undefined reference mean, and where should I look in my files?`,
    });
  }
  if (conflict) {
    problems.push({
      kind: 'conflict',
      label: 'Explain this conflict',
      question: `Bison reports: "${conflict.message}". What does this conflict mean in my grammar, which input causes the choice, and how could I resolve it?`,
    });
  }
  const crashed = run.steps.some((step) => step.outcome === 'crashed') || CRASH.test(allOutput);
  if (crashed) {
    problems.push({
      kind: 'segfault',
      label: 'Why did my program crash?',
      question:
        'My program crashed, which may be a segmentation fault. What are the likely causes in this code, and how can I find the exact line?',
    });
  }
  const hung = run.steps.some(
    (step) => step.outcome === 'timeout' || step.outcome === 'output_limit',
  );
  if (hung) {
    problems.push({
      kind: 'hang',
      label: 'Why does my program never finish?',
      question:
        'My program hit the time or output limit. Where could it be looping forever or waiting, given this code and input?',
    });
  }
  if (otherError) {
    const where =
      otherError.file && otherError.line !== null
        ? ` in ${otherError.file} at line ${otherError.line}`
        : '';
    problems.push({
      kind: 'compile-error',
      label: 'Explain this error',
      question: `I got this ${otherError.tool} error${where}: "${otherError.message}". What does it mean, and what should I check?`,
    });
  }
  if (run.check && !run.check.passed) {
    const failed = run.check.results.filter((result) => !result.passed).length;
    problems.push({
      kind: 'failed-tests',
      label: 'Why are the tests failing?',
      question: `${failed} of the ${run.check.results.length} tests failed. What is the difference between what my program does and what the tests expect?`,
    });
  }
  if (run.error) {
    problems.push({
      kind: 'job-error',
      label: 'Explain this message',
      question: `The lab says: "${run.error.message}" What does this mean, and what should I do?`,
    });
  }
  return problems;
}
