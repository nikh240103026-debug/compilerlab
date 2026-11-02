import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';

/** Shown in the buffer where the sentinel character sits. */
export const SENTINEL = '␃';

export interface BufferPointer {
  buffer: 0 | 1;
  index: number;
}

export type BufferAction = 'load' | 'advance' | 'sentinel' | 'reload' | 'lexeme' | 'done';

export interface InputBufferState {
  action: BufferAction;
  /** Each buffer is bufferSize characters plus the sentinel slot. */
  buffers: [string[], string[]];
  lexemeBegin: BufferPointer;
  forward: BufferPointer;
  /** The characters between the pointers. */
  lexeme: string;
  lexemes: string[];
  /** Characters read so far, and tests made for the end of a buffer. */
  charactersRead: number;
  sentinelChecks: number;
}

export interface InputBufferResult {
  lexemes: string[];
  trace: Trace<InputBufferState>;
}

export const MIN_BUFFER_SIZE = 4;
export const MAX_BUFFER_SIZE = 32;
export const MAX_BUFFERED_INPUT = 400;

const isSpace = (char: string) => /\s/.test(char);

/**
 * The textbook's buffer pair with sentinels. Whitespace separates lexemes here, which keeps the
 * focus on the pointers. Reloads the other buffer each time `forward` reaches a sentinel.
 */
export function traceInputBuffer(inputText: string, bufferSize = 8): InputBufferResult {
  if (bufferSize < MIN_BUFFER_SIZE || bufferSize > MAX_BUFFER_SIZE) {
    throw new EngineError({
      code: 'bad_buffer_size',
      message: `The buffer size must be between ${MIN_BUFFER_SIZE} and ${MAX_BUFFER_SIZE}.`,
    });
  }
  const input = [...inputText];
  if (input.length > MAX_BUFFERED_INPUT) {
    throw new EngineError({
      code: 'input_too_long',
      message: `This input is longer than the ${MAX_BUFFERED_INPUT} characters this demo accepts.`,
      hint: 'Try a shorter piece of code.',
    });
  }

  const recorder = new TraceRecorder<InputBufferState>();
  const buffers: [string[], string[]] = [[], []];
  const lexemes: string[] = [];
  let nextToLoad = 0;
  let charactersRead = 0;
  let sentinelChecks = 0;
  let lexeme = '';
  let forward: BufferPointer = { buffer: 0, index: 0 };
  let lexemeBegin: BufferPointer = { ...forward };

  const load = (buffer: 0 | 1) => {
    const chunk = input.slice(nextToLoad, nextToLoad + bufferSize);
    nextToLoad += chunk.length;
    buffers[buffer] = [...chunk, SENTINEL];
    return chunk.length;
  };

  const record = (action: BufferAction, title: string, explanation: string) => {
    recorder.add(title, explanation, {
      action,
      buffers: [buffers[0].slice(), buffers[1].slice()],
      lexemeBegin: { ...lexemeBegin },
      forward: { ...forward },
      lexeme,
      lexemes: lexemes.slice(),
      charactersRead,
      sentinelChecks,
    });
  };

  const firstLoad = load(0);
  record(
    'load',
    'Load the first buffer',
    `Read ${firstLoad} characters from the file in one go, and put a sentinel, eof, after them. lexemeBegin and forward both point at the first character.`,
  );

  const finishLexeme = () => {
    if (lexeme.length === 0) return;
    lexemes.push(lexeme);
    const found = lexeme;
    lexeme = '';
    record(
      'lexeme',
      `Found "${found}"`,
      `The lexeme "${found}" is the text between lexemeBegin and forward. Hand it on, then move lexemeBegin up to forward to begin the next one.`,
    );
  };

  for (;;) {
    const char = (buffers[forward.buffer] as string[])[forward.index];
    sentinelChecks++;
    if (char === SENTINEL) {
      // The book's rule: eof at the end of a buffer means reload, and anywhere else means done.
      if (forward.index !== bufferSize) {
        finishLexeme();
        lexemeBegin = { ...forward };
        record(
          'done',
          'End of input',
          `This eof is not at the end of a buffer, which can only mean the input has ended. Scanning stops after ${charactersRead} characters and ${sentinelChecks} sentinel tests.`,
        );
        break;
      }
      record(
        'sentinel',
        'Sentinel reached',
        `forward hit the eof at the end of buffer ${forward.buffer + 1}. It is the only character that needs a closer look, so normal characters cost just this one test.`,
      );
      const other = forward.buffer === 0 ? 1 : 0;
      const overwritesLexeme = lexeme.length > 0 && lexemeBegin.buffer === other;
      const count = load(other);
      forward = { buffer: other, index: 0 };
      // With no lexeme in progress, the next one begins at the start of the new buffer.
      if (lexeme.length === 0) lexemeBegin = { ...forward };
      const loaded =
        count > 0
          ? `Load the next ${count} characters into buffer ${other + 1} and move forward to its start.`
          : `The file has no more characters, so buffer ${other + 1} now holds only an eof, and forward moves to it.`;
      const crossing =
        lexeme.length === 0
          ? ''
          : overwritesLexeme
            ? ` This overwrites the start of "${lexeme}", because the lexeme is too long for the buffers. A real lexer would have lost it, which is why a lexeme plus its lookahead must fit in one buffer. This demo keeps its own copy so it can carry on.`
            : ' The lexeme can cross this boundary, because lexemeBegin stays where it was in the other buffer.';
      record('reload', `Reload buffer ${other + 1}`, `${loaded}${crossing}`);
      continue;
    }

    if (isSpace(char as string)) {
      finishLexeme();
      forward = { ...forward, index: forward.index + 1 };
      charactersRead++;
      lexemeBegin = { ...forward };
      record(
        'advance',
        'Skip whitespace',
        'Whitespace is not part of a lexeme, so lexemeBegin and forward both move past it.',
      );
    } else {
      lexeme += char as string;
      forward = { ...forward, index: forward.index + 1 };
      charactersRead++;
      record(
        'advance',
        `Read "${char}"`,
        `forward moves past "${char}". The lexeme so far is "${lexeme}".`,
      );
    }
  }

  return { lexemes, trace: recorder.finish() };
}
