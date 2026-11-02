import { z } from 'zod';

export const ModuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  number: z.number().int().min(0),
  title: z.string().min(1),
  summary: z.string().min(1),
  /** True for the phases drawn on the source-to-target pipeline. */
  pipelineStage: z.boolean(),
  optional: z.boolean(),
  /** The Part 14 milestone that delivers this module's lessons. */
  lessonsMilestone: z.number().int().min(2).max(12),
  topics: z.array(z.string().min(1)).min(1),
  visualizers: z.array(z.string().min(1)),
});

export const ModuleListSchema = z.array(ModuleSchema);

export type CourseModule = z.infer<typeof ModuleSchema>;
