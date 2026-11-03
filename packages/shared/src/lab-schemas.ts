import { z } from 'zod';
import {
  C_STANDARDS,
  COMPILER_FLAGS,
  CPP_STANDARDS,
  LAB_ENGINES,
  LAB_LIMITS,
  LAB_PIPELINES,
  labFileNameProblem,
} from './lab';

const slug = z.string().regex(/^[a-z0-9-]+$/);
const text = z.string().trim().min(1);

const fileName = z.string().superRefine((name, context) => {
  const problem = labFileNameProblem(name);
  if (problem) context.addIssue({ code: 'custom', message: `"${name}": ${problem}` });
});

export const LabFileSchema = z.strictObject({
  name: fileName,
  content: z.string().max(LAB_LIMITS.fileBytes),
});

function addDuplicateNameIssues(
  files: readonly { name: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  // Windows and macOS folders usually ignore case, so A.c and a.c are the same file there.
  const names = files.map((file) => file.name.toLowerCase());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    context.addIssue({
      code: 'custom',
      path: [path],
      message: `Two files are named ${duplicate}. Each file needs its own name.`,
    });
  }
}

export const LabJobSchema = z
  .strictObject({
    pipeline: z.enum(LAB_PIPELINES),
    engine: z.enum(LAB_ENGINES).default('auto'),
    files: z.array(LabFileSchema).min(1).max(LAB_LIMITS.files),
    stdin: z.string().max(LAB_LIMITS.stdinBytes).default(''),
    standard: z.string().optional(),
    flags: z.array(z.enum(COMPILER_FLAGS)).default([]),
  })
  .superRefine((job, context) => {
    addDuplicateNameIssues(job.files, context, 'files');
    if (job.standard === undefined) return;
    const allowed: readonly string[] = job.pipeline === 'cpp' ? CPP_STANDARDS : C_STANDARDS;
    if (!allowed.includes(job.standard)) {
      context.addIssue({
        code: 'custom',
        path: ['standard'],
        message: `${job.standard} is not a language standard for this pipeline.`,
      });
    }
  });

export const LabClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('run'), job: LabJobSchema }),
  z.strictObject({ type: z.literal('check'), exerciseId: slug, job: LabJobSchema }),
  z.strictObject({ type: z.literal('stop') }),
]);

export const LabWorkspaceSchema = z
  .strictObject({
    files: z.array(LabFileSchema).max(LAB_LIMITS.files),
    stdin: z.string().max(LAB_LIMITS.stdinBytes),
    pipeline: z.enum(LAB_PIPELINES),
  })
  .superRefine((workspace, context) => addDuplicateNameIssues(workspace.files, context, 'files'));

const LabTestSchema = z.strictObject({
  name: text,
  input: z.string(),
  expected: z.string(),
  hidden: z.boolean().default(false),
});

/** An exercise's exercise.json. Its starter and solution files live in folders beside it. */
export const LabExerciseMetaSchema = z
  .strictObject({
    id: slug,
    module: slug,
    /** Lessons whose Lab section links here. */
    topics: z.array(slug).min(1),
    order: z.number().int().min(1),
    title: text,
    difficulty: z.enum(['easy', 'medium', 'hard']),
    tags: z.array(text).min(1),
    exams: z.array(z.enum(['GATE', 'university'])).min(1),
    brief: text,
    pipeline: z.enum(LAB_PIPELINES),
    /** What the input pane starts with. */
    stdin: z.string(),
    tests: z.array(LabTestSchema).min(2),
    hints: z.array(text).min(2),
    explanation: text,
  })
  .superRefine((exercise, context) => {
    if (!exercise.tests.some((test) => test.hidden)) {
      context.addIssue({ code: 'custom', path: ['tests'], message: 'Add a hidden test.' });
    }
    if (exercise.tests.every((test) => test.hidden)) {
      context.addIssue({ code: 'custom', path: ['tests'], message: 'Add a visible test.' });
    }
  });

export type LabExerciseMeta = z.infer<typeof LabExerciseMetaSchema>;

export interface LabExercise extends LabExerciseMeta {
  files: { name: string; content: string }[];
  solution: { name: string; content: string }[];
}
