import type { LabDiagnostic } from '@compilerlab/shared';

type Explainer = readonly [RegExp, (match: RegExpExecArray) => string];

// Compilers quote names with 'x', `x' or ‘x’, depending on locale and version.
const Q = '[`\'‘"]';
const E = '[\'’"]';
const NAME = `${Q}([^'’"]+)${E}`;

const C_EXPLANATIONS: readonly Explainer[] = [
  [
    /cannot find -l(\S+?):?(\s|$)/,
    (m) =>
      `The linker could not find the library ${m[1]}. It may not be installed, or its name may be misspelled.`,
  ],
  [
    new RegExp(`${NAME} undeclared`),
    (m) =>
      `The compiler has not seen a declaration of ${m[1]} at this point. Declare it first, or check the spelling. In a flex file, shared variables go in the %{ %} block at the top.`,
  ],
  [
    new RegExp(`${NAME} was not declared in this scope`),
    (m) =>
      `The compiler has not seen a declaration of ${m[1]} at this point. Declare it first, check the spelling, or add the #include that provides it.`,
  ],
  [
    new RegExp(`implicit declaration of function ${NAME}`),
    (m) =>
      `You called ${m[1]} before any declaration of it. Add the #include for its header, or declare the function above this line.`,
  ],
  [
    new RegExp(`undefined reference to ${NAME}`),
    (m) =>
      m[1] === 'yywrap'
        ? 'flex needs a function named yywrap, and it was not found. Add %option noyywrap to the first section of your .l file.'
        : m[1] === 'main' || m[1] === 'WinMain'
          ? 'The program has no main function, so it has nowhere to start. Add one, or check its spelling.'
          : `Your code calls ${m[1]}, and the compiler accepted that, but the linker could not find the function's body. Check the spelling, write the function, or link the library that has it (for math functions, turn on -lm).`,
  ],
  [
    /expected ['‘`"]?;['’"]? before/,
    () =>
      'A semicolon is missing. The compiler notices at the next token, so the mistake is often at the end of the line above the one marked.',
  ],
  [
    /expected ['‘`"]?;['’"]? (at end|after)/,
    () => 'A semicolon is missing at the end of this declaration or statement.',
  ],
  [
    /expected ['‘`"]?\)['’"]? before/,
    () => 'A closing parenthesis is missing. Count the ( and ) in this expression.',
  ],
  [
    /expected declaration or statement at end of input/,
    () => 'The file ended while a block was still open, so a closing } is missing somewhere.',
  ],
  [
    /expected ['‘`"]?\}['’"]? (at end|before)/,
    () => 'A closing } is missing. The compiler reached this point with a block still open.',
  ],
  [
    /expected expression/,
    () =>
      'A value should come here, but the compiler found something else, such as a stray operator.',
  ],
  [
    /missing terminating (['"]) character/,
    (m) =>
      `A ${m[1]} is opened but never closed on this line. A C string or character constant has to close on the line where it starts.`,
  ],
  [
    /stray ['‘`]?\\?.*['’]? in program/,
    () =>
      'This line has a character C does not allow outside a string. Curly quotes pasted from a document are the usual cause.',
  ],
  [
    /No such file or directory/,
    () =>
      'The compiler could not find this file. Check the spelling of the #include. Your own headers use quotes, and system headers use angle brackets.',
  ],
  [
    new RegExp(`conflicting types for ${NAME}`),
    (m) =>
      `${m[1]} is declared in two different ways. If you call a function before it is declared, C assumes it returns int, which can clash with the real definition below.`,
  ],
  [
    new RegExp(`redefinition of ${NAME}`),
    (m) => `${m[1]} is defined twice. Remove or rename one of them.`,
  ],
  [
    new RegExp(`multiple definition of ${NAME}`),
    (m) =>
      `${m[1]} is defined in more than one file. Keep one definition, and use extern elsewhere.`,
  ],
  [
    /too few arguments to function/,
    () => 'This call passes fewer arguments than the function takes.',
  ],
  [
    /too many arguments to function/,
    () => 'This call passes more arguments than the function takes.',
  ],
  [
    /incompatible (pointer )?type/,
    () => 'The value here has a different type from what this place expects.',
  ],
  [
    /makes (pointer from integer|integer from pointer) without a cast/,
    () =>
      'This mixes a pointer with a whole number. A forgotten * or &, or a string where a char belongs, is the usual cause.',
  ],
  [
    /format ['‘`"]%(\w+)['’"]? expects/,
    (m) => `%${m[1]} in this printf does not match the type of the value given for it.`,
  ],
  [
    /control reaches end of non-void function/,
    () =>
      'This function promises to return a value, but one path through it reaches the end without a return.',
  ],
  [
    new RegExp(`unused variable ${NAME}`),
    (m) => `${m[1]} is declared but never used. This is harmless, but it can be a sign of a typo.`,
  ],
  [
    /lvalue required/,
    () => 'The left side of this assignment is not something that can be stored into.',
  ],
  [/division by zero/, () => 'This divides by a value the compiler can see is zero.'],
  [
    /no match for ['‘`"]?operator/,
    () =>
      'C++ does not know how to apply this operator to these types. Check the types on both sides.',
  ],
  [
    /invalid conversion from/,
    () =>
      'C++ will not convert between these types on its own. Change the type, or cast it deliberately.',
  ],
];

const FLEX_EXPLANATIONS: readonly Explainer[] = [
  [
    /unrecognized rule/,
    () =>
      'flex could not read this pattern. A space ends a pattern unless it is quoted, so check for one in the middle. Other causes are a { that does not name a definition, or an unbalanced bracket or quote.',
  ],
  [
    /rule cannot be matched/,
    () =>
      'An earlier rule already matches everything this rule could, so it can never win. Move the more specific rule higher up.',
  ],
  [
    /default rule can be matched/,
    () => 'Some input matches no rule, so flex would echo it. Add a catch-all rule such as: . { }',
  ],
  [
    /EOF encountered inside an action/,
    () =>
      "A { in a rule's action is never closed, so flex reached the end of the file looking for it.",
  ],
  [
    /missing \}|bad character class|unmatched|premature EOF/i,
    () => 'A bracket, brace or quote in this pattern is not balanced.',
  ],
  [
    /undefined definition/,
    () =>
      'This pattern uses a {NAME} that is not defined in the first section. Check the spelling.',
  ],
  [
    /undeclared start condition/,
    () =>
      'This rule uses a start condition that was never declared. Add %x NAME or %s NAME to the first section.',
  ],
  [
    /unrecognized %option/,
    () =>
      'flex does not know this option. Check the spelling. Common ones are noyywrap and yylineno.',
  ],
  [
    /iteration value must be positive/,
    () => 'A repeat count like {2,3} must use positive numbers, with the smaller first.',
  ],
  [
    /negative range in character class/,
    () =>
      'A range in this character class runs backwards. Put the lower character first, as in a-z.',
  ],
];

export function explainMessage(tool: string, message: string): string | null {
  const table = tool === 'flex' ? FLEX_EXPLANATIONS : C_EXPLANATIONS;
  for (const [pattern, explain] of table) {
    const match = pattern.exec(message);
    if (match) return explain(match);
  }
  return null;
}

/** C:\runs\x\main.c or ./main.c both become main.c, the name the student knows. */
function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

const COMPILER_LINE =
  /^((?:[A-Za-z]:)?[^:\n]+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*)$/;
const LINKER_LOCATED =
  /^(?:.*:)?([^:\\/\n]+\.\w+):(?:\(\.\w+[^)]*\)|(\d+)):\s*(undefined reference to .*|multiple definition of .*)$/;
const LINKER_PLAIN = /^(?:.*[\\/])?(?:ld|ld\.exe|collect2|collect2\.exe):\s*(?:error:\s*)?(.*)$/;
const FLEX_LINE = /^"?([^":\n]+)"?(?:, line |:)(\d+):\s*(warning, )?(.*)$/;
const LINKER_NOISE = /in function|ld returned|^\s*$/;

function compilerDiagnostics(tool: string, text: string): LabDiagnostic[] {
  const items: LabDiagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const compiler = COMPILER_LINE.exec(line);
    if (compiler) {
      const severity =
        compiler[4] === 'warning' ? 'warning' : compiler[4] === 'note' ? 'note' : 'error';
      const message = compiler[5] as string;
      items.push({
        file: baseName(compiler[1] as string),
        line: Number(compiler[2]),
        column: compiler[3] ? Number(compiler[3]) : null,
        severity,
        tool,
        message,
        explanation: severity === 'note' ? null : explainMessage(tool, message),
      });
      continue;
    }
    const located = LINKER_LOCATED.exec(line);
    if (located) {
      const message = located[3] as string;
      items.push({
        file: baseName(located[1] as string),
        line: located[2] ? Number(located[2]) : null,
        column: null,
        severity: 'error',
        tool: 'linker',
        message,
        explanation: explainMessage(tool, message),
      });
      continue;
    }
    if (LINKER_NOISE.test(line)) continue;
    const plain = LINKER_PLAIN.exec(line);
    if (plain) {
      const message = plain[1] as string;
      items.push({
        file: null,
        line: null,
        column: null,
        severity: 'error',
        tool: 'linker',
        message,
        explanation: explainMessage(tool, message),
      });
    }
  }
  return items;
}

function flexDiagnostics(text: string): LabDiagnostic[] {
  const items: LabDiagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const match = FLEX_LINE.exec(line);
    if (match) {
      const message = match[4] as string;
      items.push({
        file: baseName(match[1] as string),
        line: Number(match[2]),
        column: null,
        severity: match[3] ? 'warning' : 'error',
        tool: 'flex',
        message,
        explanation: explainMessage('flex', message),
      });
    } else if (line.startsWith('flex:')) {
      const message = line.slice('flex:'.length).trim();
      items.push({
        file: null,
        line: null,
        column: null,
        severity: 'error',
        tool: 'flex',
        message,
        explanation: explainMessage('flex', message),
      });
    }
  }
  return items;
}

/**
 * Turns tool output into structured errors.
 *
 * flex writes #line directives, so errors in a student's actions already point at their .l file.
 * Warnings about lex.yy.c itself are about code no student wrote, so they are dropped, along
 * with any notes that belong to them.
 */
export function parseDiagnostics(tool: string, text: string): LabDiagnostic[] {
  const items = tool === 'flex' ? flexDiagnostics(text) : compilerDiagnostics(tool, text);
  const kept: LabDiagnostic[] = [];
  let lastKept = false;
  for (const item of items) {
    if (item.severity === 'note') {
      if (lastKept) kept.push(item);
      continue;
    }
    lastKept = !(item.file === 'lex.yy.c' && item.severity === 'warning');
    if (lastKept) kept.push(item);
  }
  return kept;
}
