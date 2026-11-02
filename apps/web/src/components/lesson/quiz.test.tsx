import type { QuizQuestion } from '@compilerlab/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Quiz, quizScore } from './quiz';

const fields = {
  hint: 'A hint here.',
  solution: 'The solution.',
  explanation: 'The explanation.',
  difficulty: 'easy' as const,
  tags: ['t'],
  exams: ['GATE' as const],
};

const QUESTIONS: QuizQuestion[] = [
  { ...fields, id: 'q1', type: 'mcq', prompt: 'First?', options: ['Right', 'Wrong'], answer: 0 },
  { ...fields, id: 'q2', type: 'short', prompt: 'Second?' },
];

function setup() {
  const onComplete = vi.fn();
  render(
    <MemoryRouter>
      <Quiz questions={QUESTIONS} onComplete={onComplete} />
    </MemoryRouter>,
  );
  return { onComplete, user: userEvent.setup() };
}

describe('quizScore', () => {
  it('waits until every question is answered', () => {
    expect(quizScore(['correct', null], 2)).toBeNull();
    expect(quizScore([], 0)).toBeNull();
  });

  it('gives a whole-number percentage', () => {
    expect(quizScore(['correct', 'incorrect', 'correct'], 3)).toBe(67);
    expect(quizScore(['correct'], 1)).toBe(100);
    expect(quizScore(['incorrect'], 1)).toBe(0);
  });
});

describe('Quiz', () => {
  it('shows feedback and the explanation after checking an answer', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Wrong'));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(screen.getByText('Not quite.')).toBeTruthy();
    expect(screen.getByText('The explanation.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask AI' })).toBeTruthy();
  });

  it('will not check an answer until one is chosen', () => {
    setup();
    expect(
      (screen.getByRole('button', { name: 'Check answer' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reveals a hint on request', async () => {
    const { user } = setup();
    await user.click(screen.getAllByRole('button', { name: 'Show a hint' })[0] as HTMLElement);
    expect(screen.getByText('A hint here.')).toBeTruthy();
  });

  it('reports a score once every question is answered, counting self-marked answers', async () => {
    const { user, onComplete } = setup();
    await user.click(screen.getByLabelText('Right'));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(onComplete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Show the solution' }));
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(onComplete).toHaveBeenCalledWith(50);
    expect(screen.getByText(/You scored 50%/)).toBeTruthy();
  });

  it('can be retaken from the start', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Right'));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    await user.click(screen.getByRole('button', { name: 'Show the solution' }));
    await user.click(screen.getByRole('button', { name: 'I got it' }));
    expect(screen.getByText(/You scored 100%/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('0 of 2 answered.')).toBeTruthy();
    expect((screen.getByLabelText('Right') as HTMLInputElement).checked).toBe(false);
  });
});
