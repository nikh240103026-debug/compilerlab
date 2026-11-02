import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ErrorPanel } from './error-panel';

function Tutor() {
  const { state } = useLocation();
  return <p>asked: {(state as { ask: string }).ask}</p>;
}

function setup(onRetry?: () => void) {
  const router = createMemoryRouter([
    {
      path: '/',
      element: <ErrorPanel title="Build failed" message="flex was not found." onRetry={onRetry} />,
    },
    { path: '/tutor', element: <Tutor /> },
  ]);
  render(<RouterProvider router={router} />);
}

describe('ErrorPanel', () => {
  it('announces a readable message', () => {
    setup();
    expect(screen.getByRole('alert').textContent).toContain('flex was not found.');
  });

  it('retries', async () => {
    const onRetry = vi.fn();
    setup(onRetry);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('takes the error to the tutor when asked', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(await screen.findByText(/asked:.*flex was not found/)).toBeTruthy();
  });
});
