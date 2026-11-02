// Zod-free so the web app's initial bundle can use it.
import type { Settings, SettingsPatch } from './settings';

export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const { toolPaths, ...rest } = patch;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const definedTools = Object.fromEntries(
    Object.entries(toolPaths ?? {}).filter(([, v]) => v !== undefined),
  );
  return {
    ...current,
    ...defined,
    toolPaths: { ...current.toolPaths, ...definedTools },
  };
}
