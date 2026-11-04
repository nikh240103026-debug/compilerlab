import type { PracticeProblem, QuestionAnswer } from '@compilerlab/shared';
import { isAnswerEmpty } from '@compilerlab/shared/assessment';
import { traceMoveLabel } from './trace-moves';

/** The choices of a question that has them, for the AI and for reports. */
export function optionsOf(question: PracticeProblem): string[] | undefined {
  return question.type === 'mcq' || question.type === 'multi' ? question.options : undefined;
}

/** A student's answer as plain text. The AI cannot see a canvas or a table, so it reads this. */
export function describeAnswer(question: PracticeProblem, answer: QuestionAnswer | null): string {
  if (!answer || isAnswerEmpty(answer)) return '(left blank)';
  switch (answer.type) {
    case 'mcq':
      return question.type === 'mcq' && answer.choice !== null
        ? (question.options[answer.choice] ?? '(left blank)')
        : '(left blank)';
    case 'multi':
      return question.type === 'multi'
        ? answer.choices.map((choice) => question.options[choice]).join('; ')
        : '(left blank)';
    case 'short':
    case 'regex':
    case 'grammar':
    case 'output':
      return answer.text;
    case 'fill':
      return answer.blanks.map((blank, index) => `Blank ${index + 1}: ${blank}`).join('\n');
    case 'match':
      return question.type === 'match'
        ? question.left
            .map((item, index) => {
              const choice = answer.choices[index];
              return `${item} → ${choice === null || choice === undefined ? '(none)' : question.right[choice]}`;
            })
            .join('\n')
        : '(left blank)';
    case 'order':
      return question.type === 'order'
        ? answer.order.map((item, index) => `${index + 1}. ${question.items[item]}`).join('\n')
        : '(left blank)';
    case 'table':
      return Object.entries(answer.cells)
        .filter(([, value]) => value.trim() !== '')
        .map(
          ([key, value]) =>
            `${key.replace('first:', 'FIRST ').replace('follow:', 'FOLLOW ')} = ${value}`,
        )
        .join('\n');
    case 'automaton': {
      const { startId, states, transitions } = answer.drawing;
      const nameOf = (id: string | null) =>
        states.find((state) => state.id === id)?.label ?? 'none';
      const accepting = states.filter((state) => state.accepting).map((state) => state.label);
      return [
        `Start state: ${nameOf(startId)}`,
        `Accepting states: ${accepting.join(', ') || 'none'}`,
        ...transitions.map(({ from, to, label }) => `${nameOf(from)} --${label}--> ${nameOf(to)}`),
      ].join('\n');
    }
    case 'trace':
      return answer.moves.map((move, index) => `${index + 1}. ${traceMoveLabel(move)}`).join('\n');
  }
}
