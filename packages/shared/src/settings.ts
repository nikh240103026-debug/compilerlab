import { z } from 'zod';
import {
  ANIMATION_SPEED_RANGE,
  DEFAULT_SETTINGS,
  EDITOR_KEYMAPS,
  FONT_SIZE_RANGE,
  THEMES,
} from './constants';

const toolPath = z.string().trim().max(1024);

export const ToolPathsSchema = z.strictObject({
  flex: toolPath,
  bison: toolPath,
  gcc: toolPath,
  gpp: toolPath,
  make: toolPath,
});

export const SettingsSchema = z.strictObject({
  theme: z.enum(THEMES),
  fontSize: z.number().int().min(FONT_SIZE_RANGE.min).max(FONT_SIZE_RANGE.max),
  animationSpeed: z.number().min(ANIMATION_SPEED_RANGE.min).max(ANIMATION_SPEED_RANGE.max),
  editorKeymap: z.enum(EDITOR_KEYMAPS),
  /** Empty means "use GEMINI_MODEL from .env". */
  geminiModel: z
    .string()
    .trim()
    .max(100)
    .regex(/^[\w.-]*$/, 'Use only the model id, for example gemini-3.5-flash-lite.'),
  /** Empty means "find the tool on PATH". */
  toolPaths: ToolPathsSchema,
});

export const SettingsPatchSchema = SettingsSchema.partial().extend({
  toolPaths: ToolPathsSchema.partial().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type Theme = Settings['theme'];
export type ToolId = keyof Settings['toolPaths'];

/** Reads stored settings field by field so one bad value cannot lose the others. */
export function parseStoredSettings(stored: Record<string, unknown>): {
  settings: Settings;
  invalidKeys: string[];
} {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const invalidKeys: string[] = [];
  for (const [key, value] of Object.entries(stored)) {
    const field = SettingsSchema.shape[key as keyof Settings];
    const parsed = field?.safeParse(value);
    if (parsed?.success) settings[key] = parsed.data;
    else invalidKeys.push(key);
  }
  return { settings: settings as Settings, invalidKeys };
}
