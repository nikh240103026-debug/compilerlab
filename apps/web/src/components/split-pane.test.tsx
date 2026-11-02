import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPane } from './split-pane';

function setup(props: { defaultRatio?: number } = {}) {
  render(<SplitPane start="left" end="right" storageKey="test" label="Resize" {...props} />);
  return screen.getByRole('separator', { name: 'Resize' });
}

describe('SplitPane', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  it('starts at the default ratio', () => {
    expect(setup({ defaultRatio: 0.6 }).getAttribute('aria-valuenow')).toBe('60');
  });

  it('resizes with the arrow keys', () => {
    const separator = setup();
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('52');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator.getAttribute('aria-valuenow')).toBe('48');
  });

  it('jumps to the limits with Home and End, and never goes past them', () => {
    const separator = setup();
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator.getAttribute('aria-valuenow')).toBe('75');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('75');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe('25');
  });

  it('remembers the position', () => {
    const separator = setup();
    fireEvent.keyDown(separator, { key: 'End' });
    expect(localStorage.getItem('compilerlab.split.test')).toBe('0.75');
  });

  it('ignores a bad saved value', () => {
    localStorage.setItem('compilerlab.split.test', '{oops');
    expect(setup().getAttribute('aria-valuenow')).toBe('50');
  });

  it('clamps an out-of-range saved value', () => {
    localStorage.setItem('compilerlab.split.test', '5');
    expect(setup().getAttribute('aria-valuenow')).toBe('75');
  });

  it('stacks without a separator on narrow screens', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<SplitPane start="left" end="right" storageKey="test" label="Resize" />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByText('left')).toBeTruthy();
    expect(screen.getByText('right')).toBeTruthy();
  });
});
