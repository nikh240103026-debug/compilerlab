// The small program description that the activation record model runs. It is plain data, so a
// lesson can define its own, and procedures nest the way they do in Pascal or ML.

export type RtStatement =
  /** A variable, in the nearest enclosing scope that declares it. Expressions are text. */
  | { kind: 'assign'; name: string; value: string }
  /** Call a procedure, optionally saving what it returns. */
  | { kind: 'call'; proc: string; args?: string[]; assignTo?: string }
  | { kind: 'if'; condition: string; then: RtStatement[]; else?: RtStatement[] }
  | { kind: 'return'; value?: string }
  | { kind: 'print'; value: string };

export interface RtProcedure {
  name: string;
  params?: string[];
  /** Local variables. Each starts as 0 unless a value is given. */
  locals?: (string | { name: string; value: number })[];
  /** Procedures declared inside this one. */
  nested?: RtProcedure[];
  body: RtStatement[];
}

/** The outermost procedure, which starts the program. Its locals act like globals. */
export type RtProgram = RtProcedure;

/** Factorial: recursion, where each call gets its own frame. Book-style, with no nesting. */
export const RT_SAMPLE_FACTORIAL: RtProgram = {
  name: 'main',
  locals: ['result'],
  nested: [
    {
      name: 'fact',
      params: ['n'],
      locals: ['rest'],
      body: [
        {
          kind: 'if',
          condition: 'n <= 1',
          then: [{ kind: 'return', value: '1' }],
          else: [
            { kind: 'call', proc: 'fact', args: ['n - 1'], assignTo: 'rest' },
            { kind: 'return', value: 'n * rest' },
          ],
        },
      ],
    },
  ],
  body: [
    { kind: 'call', proc: 'fact', args: ['3'], assignTo: 'result' },
    { kind: 'print', value: 'result' },
  ],
};

/**
 * The book's sort example: nested procedures, where partition reads a variable of sort, two
 * levels out. Partition is at depth 3 and exchange at depth 2, so the call from partition to
 * exchange follows access links to find the frame exchange needs. The array is left out so the
 * access links stay the focus.
 */
export const RT_SAMPLE_NESTED_SORT: RtProgram = {
  name: 'sort',
  locals: [
    { name: 'pivot', value: 7 },
    { name: 'swaps', value: 0 },
  ],
  nested: [
    {
      name: 'readArray',
      locals: [{ name: 'i', value: 0 }],
      body: [{ kind: 'assign', name: 'i', value: 'pivot' }],
    },
    {
      name: 'exchange',
      params: ['i', 'j'],
      body: [{ kind: 'assign', name: 'swaps', value: 'swaps + 1' }],
    },
    {
      name: 'quicksort',
      params: ['m', 'n'],
      locals: ['k'],
      nested: [
        {
          name: 'partition',
          params: ['y', 'z'],
          locals: ['i', 'j'],
          body: [
            { kind: 'assign', name: 'i', value: 'y + pivot' },
            { kind: 'assign', name: 'j', value: 'z' },
            { kind: 'call', proc: 'exchange', args: ['i', 'j'] },
            { kind: 'return', value: 'y' },
          ],
        },
      ],
      body: [
        {
          kind: 'if',
          condition: 'n > m',
          then: [
            { kind: 'call', proc: 'partition', args: ['m', 'n'], assignTo: 'k' },
            { kind: 'call', proc: 'quicksort', args: ['m', 'k - 1'] },
            { kind: 'call', proc: 'quicksort', args: ['k + 1', 'n'] },
          ],
        },
      ],
    },
  ],
  body: [
    { kind: 'call', proc: 'readArray' },
    { kind: 'call', proc: 'quicksort', args: ['1', '2'] },
    { kind: 'print', value: 'swaps' },
  ],
};
