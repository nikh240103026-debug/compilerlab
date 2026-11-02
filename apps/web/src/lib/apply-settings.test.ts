import { describe, expect, it } from 'vitest';
import { applySettings, resolveTheme } from './apply-settings';

describe('resolveTheme', () => {
  it.each([
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['dark', false, 'dark'],
    ['light', true, 'light'],
  ] as const)('%s with prefersDark=%s is %s', (theme, prefersDark, expected) => {
    expect(resolveTheme(theme, prefersDark)).toBe(expected);
  });
});

describe('applySettings', () => {
  it('sets the theme, font size and animation speed', () => {
    const root = document.createElement('html');
    applySettings({ theme: 'dark', fontSize: 18, animationSpeed: 1.5 }, false, root);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.fontSize).toBe('18px');
    expect(root.style.getPropertyValue('--motion-speed')).toBe('1.5');
  });
});
