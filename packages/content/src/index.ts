import { ModuleListSchema, type CourseModule } from '@compilerlab/shared';
import rawModules from '../data/modules.json';

export * from './lessons';

/** Parsed on load so a content typo fails loudly at startup, not as a blank page. */
export const modules: readonly CourseModule[] = ModuleListSchema.parse(rawModules);
