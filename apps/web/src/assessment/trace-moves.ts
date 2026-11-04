// A parser's moves as a student gives them. No engine here: a student's own moves are played out on
// the page as they go, so they can see what each one does without being told if it is right.
import type { TraceModel } from './question-model';

export interface TraceMoveOption {
  /** `shift`, `match`, `accept`, `error`, `reduce:E → T` or `expand:E → T`. */
  value: string;
  label: string;
}

export function traceMoveLabel(value: string): string {
  if (value === 'shift') return 'Shift';
  if (value === 'match') return 'Match';
  if (value === 'accept') return 'Accept';
  if (value === 'error') return 'Syntax error';
  if (value.startsWith('reduce:')) return `Reduce by ${value.slice('reduce:'.length)}`;
  if (value.startsWith('expand:')) return `Expand by ${value.slice('expand:'.length)}`;
  return value;
}

export interface TraceRow {
  /** Bottom of the stack first. */
  stack: readonly string[];
  /** What is left to read, ending in $. */
  input: readonly string[];
  /** The move from this configuration. Null on the last row, where the next move goes. */
  move: string | null;
  /** Why this move makes no sense from here. A problem does not stop the student carrying on. */
  problem: string | null;
}

/** "E → T E'" as a head and a body. An ε body is empty, as the engine stores it. */
function splitProduction(label: string): { head: string; body: string[] } {
  const [head = '', rest = ''] = label.split(' → ');
  const body = rest === 'ε' || rest.trim() === '' ? [] : rest.trim().split(' ');
  return { head, body };
}

function sameTop(stack: readonly string[], body: readonly string[]): boolean {
  if (stack.length < body.length) return false;
  const top = stack.slice(stack.length - body.length);
  return body.every((symbol, index) => top[index] === symbol);
}

/**
 * Plays the student's moves on a stack of symbols. LR states are left out, because which state comes
 * next is what the table works out, and a student tracing by hand can follow the symbols alone.
 */
export function simulateTraceMoves(model: TraceModel, moves: readonly string[]): TraceRow[] {
  const topDown = model.parser === 'll1';
  const stack: string[] = topDown ? ['$', model.start] : ['$'];
  const input = [...model.tokens, '$'];
  const rows: TraceRow[] = [];
  let finished = false;

  for (const move of moves) {
    const before = { stack: stack.slice(), input: input.slice() };
    let problem: string | null = null;
    if (finished) {
      problem = 'The parser has already stopped, so no move can come after this.';
    } else if (move === 'accept') {
      const done = topDown
        ? stack.length === 1 && input.length === 1
        : stack.length === 2 && stack[1] === model.start && input.length === 1;
      if (!done) problem = 'The parser can only accept when all the input has been used.';
      finished = true;
    } else if (move === 'error') {
      finished = true;
    } else if (move === 'shift') {
      const next = input[0] as string;
      if (next === '$') problem = 'There is no token left to shift.';
      else {
        stack.push(next);
        input.shift();
      }
    } else if (move === 'match') {
      const top = stack.at(-1);
      if (top === input[0] && top !== '$') {
        stack.pop();
        input.shift();
      } else {
        problem = `The top of the stack is ${top ?? 'empty'} and the next token is ${input[0]}, so they do not match.`;
      }
    } else if (move.startsWith('reduce:')) {
      const { head, body } = splitProduction(move.slice('reduce:'.length));
      if (sameTop(stack, body)) {
        stack.splice(stack.length - body.length, body.length, head);
      } else {
        problem = `The top of the stack is not ${body.join(' ')}, so this reduction cannot happen here.`;
      }
    } else if (move.startsWith('expand:')) {
      const { head, body } = splitProduction(move.slice('expand:'.length));
      if (stack.at(-1) === head) {
        stack.pop();
        stack.push(...body.toReversed());
      } else {
        problem = `The top of the stack is ${stack.at(-1) ?? 'empty'}, not ${head}.`;
      }
    }
    rows.push({ ...before, move, problem });
  }
  rows.push({ stack, input, move: null, problem: null });
  return rows;
}
