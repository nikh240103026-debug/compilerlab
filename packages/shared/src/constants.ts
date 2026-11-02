// Zod-free so the web app's initial bundle can import defaults without the validator.
import type { Settings } from './settings';

export const DEFAULT_SERVER_PORT = 4317;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

export const FONT_SIZE_RANGE = { min: 12, max: 22, step: 1 } as const;
export const ANIMATION_SPEED_RANGE = { min: 0.25, max: 3, step: 0.25 } as const;

export const THEMES = ['system', 'light', 'dark'] as const;
export const EDITOR_KEYMAPS = ['default', 'vim', 'emacs'] as const;
export const TOOL_IDS = ['flex', 'bison', 'gcc', 'gpp', 'make'] as const;

export const VISUALIZER_IDS = [
  'regex-to-nfa',
  'subset-construction',
  'dfa-minimization',
  'followpos',
  'automaton-run',
  'automata-builder',
  'token-stream',
  'input-buffer',
] as const;

export type VisualizerId = (typeof VISUALIZER_IDS)[number];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 16,
  animationSpeed: 1,
  editorKeymap: 'default',
  geminiModel: '',
  toolPaths: { flex: '', bison: '', gcc: '', gpp: '', make: '' },
};
