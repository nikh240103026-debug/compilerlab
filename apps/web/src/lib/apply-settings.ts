import type { Settings, Theme } from '@compilerlab/shared';

export const SETTINGS_CACHE_KEY = 'compilerlab.settings';

export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

/** Applies the settings that affect the whole document. */
export function applySettings(
  settings: Pick<Settings, 'theme' | 'fontSize' | 'animationSpeed'>,
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = resolveTheme(settings.theme, prefersDark);
  root.style.fontSize = `${settings.fontSize}px`;
  root.style.setProperty('--motion-speed', String(settings.animationSpeed));
}
