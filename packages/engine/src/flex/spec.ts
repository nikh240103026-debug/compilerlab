import { EngineError } from '../core/result';
import type { RegexNode } from '../regex/parser';
import { parseFlexDefinition, parseFlexPattern, type FlexPattern } from './pattern';

export interface SourceRange {
  start: number;
  end: number;
}

export interface FlexRule {
  /** The line in the .l file, which is also what `flex -d` reports. */
  line: number;
  text: string;
  /** Start conditions it applies to. Empty means the normal ones, and "*" means all. */
  conditions: string[];
  /** Null for a <<EOF>> rule. */
  pattern: FlexPattern | null;
  /** Null when the action is "|", which means "same action as the next rule". */
  action: SourceRange | null;
  /** The action's source, for labeling. */
  actionText: string;
}

export interface FlexFile {
  options: Set<string>;
  conditions: { name: string; exclusive: boolean }[];
  rules: FlexRule[];
  /** Pattern text for each definition, as written. */
  definitions: Map<string, string>;
  /** C code from the first section, in order. */
  declarations: SourceRange[];
  /** C code at the top of the rules section, which belongs to yylex. */
  localCode: SourceRange[];
  /** C code after the second %%. */
  userCode: SourceRange | null;
}

const OPTION_NAME = /^[a-z0-9-]+$/;
const DEFINITION = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]+(\S.*?)[ \t\r]*$/;

function fail(code: string, message: string, position: number, hint: string): never {
  throw new EngineError({ code, message, hint, position, length: 1 });
}

class SpecParser {
  private at = 0;
  private readonly file: FlexFile = {
    options: new Set(),
    conditions: [],
    rules: [],
    definitions: new Map(),
    declarations: [],
    localCode: [],
    userCode: null,
  };
  private readonly parsedDefinitions = new Map<string, RegexNode>();

  constructor(private readonly source: string) {}

  parse(): FlexFile {
    this.parseDefinitionsSection();
    this.parseRulesSection();
    this.linkFallthroughs();
    return this.file;
  }

  private atEnd(): boolean {
    return this.at >= this.source.length;
  }

  private lineNumberAt(offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) if (this.source[i] === '\n') line++;
    return line;
  }

  /** The rest of the current line, without its line ending. */
  private peekLine(): string {
    const end = this.source.indexOf('\n', this.at);
    const line = this.source.slice(this.at, end === -1 ? this.source.length : end);
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }

  private skipLine(): void {
    const end = this.source.indexOf('\n', this.at);
    this.at = end === -1 ? this.source.length : end + 1;
  }

  /** Reads a %{ ... %} block, whose first line is at the cursor. */
  private readCodeBlock(): SourceRange {
    const opening = this.at;
    this.skipLine();
    const start = this.at;
    while (!this.atEnd()) {
      if (/^%\}[ \t\r]*$/.test(this.peekLine())) {
        const end = this.at;
        this.skipLine();
        return { start, end };
      }
      this.skipLine();
    }
    return fail(
      'flex_unclosed_code',
      'This %{ block is never closed.',
      opening,
      'Add a line with just %} where the C code ends.',
    );
  }

  /** Reads a /* comment, wherever it starts on the line. */
  private skipComment(): void {
    const opening = this.at;
    const end = this.source.indexOf('*/', this.at + 2);
    if (end === -1) {
      fail(
        'flex_unclosed_comment',
        'This comment is never closed.',
        opening,
        'Add */ where the comment ends.',
      );
    }
    this.at = end + 2;
    this.skipLine();
  }

  private parseDefinitionsSection(): void {
    while (!this.atEnd()) {
      const line = this.peekLine();
      if (/^%%[ \t]*$/.test(line)) {
        this.skipLine();
        return;
      }
      if (line.trim() === '') {
        this.skipLine();
      } else if (line.startsWith('%{')) {
        this.file.declarations.push(this.readCodeBlock());
      } else if (line.startsWith('/*')) {
        this.skipComment();
      } else if (/^[ \t]/.test(line)) {
        // Indented lines are C code that flex copies into the output.
        const start = this.at;
        this.skipLine();
        this.file.declarations.push({ start, end: this.at });
      } else if (line.startsWith('%')) {
        this.parseDirective(line);
        this.skipLine();
      } else {
        this.parseDefinitionLine(line);
        this.skipLine();
      }
    }
    fail(
      'flex_missing_rules',
      'This file has no rules section.',
      Math.max(0, this.source.length - 1),
      'A flex file needs a line with just %% before its rules.',
    );
  }

  private parseDirective(line: string): void {
    const [directive = '', ...words] = line.trim().split(/\s+/);
    if (directive === '%option') {
      for (const word of words) {
        if (OPTION_NAME.test(word)) this.file.options.add(word);
      }
    } else if (/^%(s|x|state|xstate|start)$/.test(directive)) {
      const exclusive = directive === '%x' || directive === '%xstate';
      for (const name of words) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          fail(
            'flex_bad_condition',
            `"${name}" is not a valid start condition name.`,
            this.at,
            'Use letters, digits and underscores.',
          );
        }
        this.file.conditions.push({ name, exclusive });
      }
    } else if (!/^%(array|pointer)$/.test(directive)) {
      fail(
        'flex_unknown_directive',
        `Simulated mode does not understand ${directive}.`,
        this.at,
        'The first section can hold %option, %s, %x, %{ %} blocks and definitions.',
      );
    }
  }

  private parseDefinitionLine(line: string): void {
    const match = DEFINITION.exec(line);
    if (!match) {
      fail(
        'flex_bad_definition',
        'This line in the first section is not a definition.',
        this.at,
        'Write a definition like this: DIGIT [0-9]. Rules go after the %% line.',
      );
    }
    const name = match[1] as string;
    const text = match[2] as string;
    const offset = this.at + line.indexOf(text, name.length);
    this.file.definitions.set(name, text);
    this.parsedDefinitions.set(
      name,
      parseFlexDefinition(text, offset, this.parsedDefinitions, this.caseless()),
    );
  }

  private caseless(): boolean {
    return this.file.options.has('case-insensitive') || this.file.options.has('caseless');
  }

  private parseRulesSection(): void {
    const scopes: string[][] = [];
    while (!this.atEnd()) {
      const line = this.peekLine();
      if (/^%%[ \t]*$/.test(line)) {
        this.skipLine();
        this.file.userCode = { start: this.at, end: this.source.length };
        break;
      }
      if (line.trim() === '') {
        this.skipLine();
      } else if (line.startsWith('%{')) {
        this.file.localCode.push(this.readCodeBlock());
      } else if (/^[ \t]*\/\*/.test(line)) {
        this.at += line.indexOf('/*');
        this.skipComment();
      } else if (/^[ \t]*\/\//.test(line) && /^[ \t]/.test(line)) {
        this.skipLine();
      } else if (scopes.length > 0 && /^[ \t]*\}[ \t]*$/.test(line)) {
        scopes.pop();
        this.skipLine();
      } else if (/^[ \t]/.test(line) && scopes.length === 0) {
        // An indented line is C code, not a rule. This is a classic source of odd flex errors.
        const start = this.at;
        this.skipLine();
        this.file.localCode.push({ start, end: this.at });
      } else {
        this.parseRule(scopes);
      }
    }
    if (scopes.length > 0) {
      fail(
        'flex_unclosed_scope',
        'A <condition>{ block in the rules section is never closed.',
        Math.max(0, this.source.length - 1),
        'Add a line with just } after its last rule.',
      );
    }
    if (this.file.rules.length === 0) {
      fail(
        'flex_no_rules',
        'This scanner has no rules.',
        Math.max(0, this.source.length - 1),
        'Add a rule after the %% line, such as: [0-9]+ printf("number\\n");',
      );
    }
  }

  private skipBlanks(): void {
    while (this.source[this.at] === ' ' || this.source[this.at] === '\t') this.at++;
  }

  private parseConditionList(): string[] {
    const opening = this.at;
    const close = this.source.indexOf('>', this.at);
    const lineEnd = this.source.indexOf('\n', this.at);
    if (close === -1 || (lineEnd !== -1 && close > lineEnd)) {
      fail(
        'flex_bad_condition_list',
        'This start condition list is never closed.',
        opening,
        'Write it like this: <COMMENT>pattern',
      );
    }
    const names = this.source.slice(this.at + 1, close).split(',');
    for (const name of names) {
      if (name === '*') continue;
      if (!this.file.conditions.some((condition) => condition.name === name)) {
        if (name === 'INITIAL') continue;
        fail(
          'flex_undeclared_condition',
          `The start condition "${name}" is not declared.`,
          opening,
          `Add this line before the first %%: %x ${name}`,
        );
      }
    }
    this.at = close + 1;
    return names;
  }

  private parseRule(scopes: string[][]): void {
    this.skipBlanks();
    const ruleStart = this.at;
    const line = this.lineNumberAt(ruleStart);
    const scoped = scopes.at(-1) ?? [];
    let conditions = scoped;
    if (this.source[this.at] === '<' && !this.source.startsWith('<<EOF>>', this.at)) {
      conditions = this.parseConditionList();
      // <COND>{ opens a block of rules that all share these conditions.
      if (/^\{[ \t\r]*(\n|$)/.test(this.source.slice(this.at, this.at + 80))) {
        this.skipLine();
        scopes.push(conditions);
        return;
      }
    }

    const patternStart = this.at;
    this.scanPattern();
    const patternText = this.source.slice(patternStart, this.at);
    const pattern =
      patternText === '<<EOF>>'
        ? null
        : parseFlexPattern(patternText, patternStart, this.parsedDefinitions, this.caseless());

    this.skipBlanks();
    const actionStart = this.at;
    const fallsThrough = /^\|[ \t\r]*(\n|$)/.test(this.source.slice(actionStart, actionStart + 80));
    if (fallsThrough) this.skipLine();
    const action = fallsThrough ? null : this.scanAction(actionStart);
    this.file.rules.push({
      line,
      text: this.source.slice(ruleStart, patternStart + patternText.length),
      conditions,
      pattern,
      action,
      actionText: action ? this.source.slice(action.start, action.end).trim() : '|',
    });
  }

  /** A pattern ends at the first space or tab outside quotes and brackets. */
  private scanPattern(): void {
    let quoted = false;
    let inClass = false;
    while (!this.atEnd()) {
      const char = this.source[this.at] as string;
      if (char === '\n' || char === '\r') break;
      if (char === '\\') {
        this.at += 2;
        continue;
      }
      if (quoted) {
        if (char === '"') quoted = false;
      } else if (inClass) {
        if (this.source.startsWith('[:', this.at)) {
          const end = this.source.indexOf(':]', this.at);
          if (end !== -1) this.at = end + 1;
        } else if (char === ']') {
          inClass = false;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === '[') {
        inClass = true;
        if (this.source[this.at + 1] === '^') this.at++;
        // A "]" straight after the opening bracket is an ordinary member.
        if (this.source[this.at + 1] === ']') this.at++;
      } else if (char === ' ' || char === '\t') {
        return;
      }
      this.at++;
    }
  }

  /** An action runs to the end of the line, or to the brace that closes it. */
  private scanAction(start: number): SourceRange {
    let depth = 0;
    this.at = start;
    while (!this.atEnd()) {
      const char = this.source[this.at] as string;
      if (char === '"' || char === "'") {
        this.skipCLiteral(char);
        continue;
      }
      if (this.source.startsWith('/*', this.at)) {
        const end = this.source.indexOf('*/', this.at + 2);
        if (end === -1) {
          fail(
            'flex_unclosed_comment',
            'This comment is never closed.',
            this.at,
            'Add */ where the comment ends.',
          );
        }
        this.at = end + 2;
        continue;
      }
      if (this.source.startsWith('//', this.at)) {
        const end = this.source.indexOf('\n', this.at);
        this.at = end === -1 ? this.source.length : end;
        continue;
      }
      if (char === '{') depth++;
      if (char === '}') depth--;
      if (char === '\n' && depth <= 0) {
        const end = this.at;
        this.at++;
        return { start, end };
      }
      this.at++;
    }
    if (depth > 0) {
      fail(
        'flex_unclosed_action',
        'This action has a "{" that is never closed.',
        start,
        'Add the missing "}". Flex calls this "EOF encountered inside an action".',
      );
    }
    return { start, end: this.source.length };
  }

  private skipCLiteral(quote: string): void {
    const opening = this.at;
    this.at++;
    while (!this.atEnd() && this.source[this.at] !== '\n') {
      const char = this.source[this.at];
      if (char === '\\') {
        this.at += 2;
        continue;
      }
      this.at++;
      if (char === quote) return;
    }
    fail(
      'flex_unclosed_literal',
      quote === '"' ? 'This string is never closed.' : 'This character constant is never closed.',
      opening,
      `Add the closing ${quote} on the same line.`,
    );
  }

  /** A "|" action means the next rule's action, so every rule ends up with a real one. */
  private linkFallthroughs(): void {
    const rules = this.file.rules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i] as FlexRule;
      if (rule.action) continue;
      const next = rules[i + 1];
      if (!next) {
        fail(
          'flex_bad_fallthrough',
          `The rule on line ${rule.line} uses "|", but no rule follows it.`,
          0,
          'The "|" action means "same as the next rule", so give this rule its own action.',
        );
      }
      rule.action = next.action;
      rule.actionText = next.actionText;
    }
  }
}

/** Reads a flex file into its parts. Throws an EngineError that points at the problem. */
export function parseFlexFile(source: string): FlexFile {
  return new SpecParser(source).parse();
}

/** Line and column, both counted from 1, for an offset in a source file. */
export function locateOffset(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}
