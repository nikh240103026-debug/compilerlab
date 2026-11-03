import { subsetConstruct } from '../automata/subset';
import { thompson } from '../automata/thompson';
import { NO_TRANSITION, type Dfa } from '../automata/types';
import { EngineError } from '../core/result';
import {
  ExitSignal,
  Interpreter,
  Ptr,
  Scope,
  type Cell,
  type OutputStream,
  type Step,
  type Value,
} from '../minic/interpreter';
import { parseCProgram, parseCStatements, type Program, type Stmt } from '../minic/parser';
import { tokenizeC, type MacroTable } from '../minic/tokens';
import { atomIndexOf } from '../regex/charset';
import type { RegexNode } from '../regex/parser';
import { Utf8Decoder, utf8Bytes } from './bytes';
import { parseFlexFile, type FlexFile, type FlexRule, type SourceRange } from './spec';

/** Bigger than the visualizers allow: nothing here is drawn, and each rule has its own DFA. */
const MAX_RULE_STATES = 2000;

/** Flex's macros, spelled so the C parser sees ordinary expressions. */
const FLEX_MACROS: Readonly<Record<string, string>> = {
  ECHO: '__echo()',
  REJECT: '__reject()',
  BEGIN: 'yy_start_condition =',
  YY_START: 'yy_start_condition',
  YYSTATE: 'yy_start_condition',
};

class Matcher {
  private readonly atoms = new Int16Array(256);
  private readonly accepting: Uint8Array;

  constructor(private readonly dfa: Dfa) {
    for (let byte = 0; byte < 256; byte++) {
      this.atoms[byte] = atomIndexOf(dfa.alphabet, byte);
    }
    this.accepting = new Uint8Array(dfa.stateCount);
    for (const state of dfa.accepts) this.accepting[state] = 1;
  }

  /** Every offset where a match from `start` can end, shortest first. */
  ends(input: readonly number[], start: number): number[] {
    const found: number[] = [];
    let state = this.dfa.start;
    if (this.accepting[state]) found.push(start);
    for (let at = start; at < input.length; at++) {
      const atom = this.atoms[input[at] as number] as number;
      if (atom === -1) break;
      state = (this.dfa.delta[state] as number[])[atom] as number;
      if (state === NO_TRANSITION) break;
      if (this.accepting[state]) found.push(at + 1);
    }
    return found;
  }

  longest(input: readonly number[], start: number): number {
    let best = -1;
    let state = this.dfa.start;
    if (this.accepting[state]) best = start;
    for (let at = start; at < input.length; at++) {
      const atom = this.atoms[input[at] as number] as number;
      if (atom === -1) break;
      state = (this.dfa.delta[state] as number[])[atom] as number;
      if (state === NO_TRANSITION) break;
      if (this.accepting[state]) best = at + 1;
    }
    return best;
  }
}

interface CompiledRule {
  rule: FlexRule;
  index: number;
  matcher: Matcher | null;
  trailing: Matcher | null;
  body: Stmt[];
}

export interface CompiledScanner {
  file: FlexFile;
  program: Program;
  local: Stmt[];
  rules: CompiledRule[];
  /** Start condition names, where the position is the number BEGIN uses. INITIAL is first. */
  conditions: string[];
  /** The rules each start condition can use. */
  active: Map<number, CompiledRule[]>;
}

function matcherFor(node: RegexNode, rule: FlexRule): Matcher {
  try {
    return new Matcher(subsetConstruct(thompson(node).nfa, MAX_RULE_STATES).dfa);
  } catch (error) {
    if (error instanceof EngineError) {
      throw new EngineError({
        ...error.info,
        message: `The rule on line ${rule.line}: ${error.info.message}`,
      });
    }
    throw error;
  }
}

function ruleApplies(rule: FlexRule, condition: string, exclusive: boolean): boolean {
  if (rule.conditions.includes('*') || rule.conditions.includes(condition)) return true;
  return rule.conditions.length === 0 && !exclusive;
}

function macroTable(): MacroTable {
  const macros: MacroTable = new Map();
  for (const [name, body] of Object.entries(FLEX_MACROS)) {
    const tokens = tokenizeC(body, 0, body.length, macros);
    tokens.pop();
    macros.set(name, tokens);
  }
  return macros;
}

function parseRanges(source: string, ranges: readonly SourceRange[], macros: MacroTable): Stmt[] {
  return ranges.flatMap(({ start, end }) =>
    parseCStatements(tokenizeC(source, start, end, macros)),
  );
}

function tooDeep(): EngineError {
  return new EngineError({
    code: 'c_too_deep',
    message: 'This code is nested too deeply for Simulated mode to read.',
    hint: 'Remove some of the nested parentheses or blocks.',
  });
}

/** Parses a .l file and builds its automata. Throws an EngineError that points at the problem. */
export function compileScanner(source: string): CompiledScanner {
  try {
    const file = parseFlexFile(source);
    const macros = macroTable();
    const program: Program = { globals: [], functions: new Map() };
    for (const { start, end } of file.declarations) {
      parseCProgram(tokenizeC(source, start, end, macros), program);
    }
    const local = parseRanges(source, file.localCode, macros);

    // Rules that share an action through "|" share its parsed form too.
    const bodies = new Map<SourceRange, Stmt[]>();
    const rules = file.rules.map((rule, index): CompiledRule => {
      const action = rule.action as SourceRange;
      let body = bodies.get(action);
      if (!body) {
        body = parseRanges(source, [action], macros);
        bodies.set(action, body);
      }
      return {
        rule,
        index,
        matcher: rule.pattern ? matcherFor(rule.pattern.node, rule) : null,
        trailing: rule.pattern?.trailing ? matcherFor(rule.pattern.trailing, rule) : null,
        body,
      };
    });
    if (file.userCode) {
      const { start, end } = file.userCode;
      parseCProgram(tokenizeC(source, start, end, macros), program);
    }

    const conditions = ['INITIAL', ...file.conditions.map((condition) => condition.name)];
    const active = new Map<number, CompiledRule[]>();
    conditions.forEach((name, id) => {
      const exclusive = file.conditions.some((c) => c.name === name && c.exclusive);
      active.set(
        id,
        rules.filter(({ rule }) => ruleApplies(rule, name, exclusive)),
      );
    });
    return { file, program, local, rules, conditions, active };
  } catch (error) {
    if (error instanceof RangeError) throw tooDeep();
    throw error;
  }
}

class RejectSignal {}
class TerminateSignal {}

export interface ScannerCallbacks {
  write(stream: OutputStream, bytes: readonly number[]): void;
  /** Each time a rule fires. A null line is the default rule. */
  onMatch?(match: { ruleLine: number | null; text: string }): void;
}

interface Candidate {
  rule: CompiledRule;
  /** Where the text handed to the action ends. */
  textEnd: number;
  /** Where the whole match ends, with trailing context. This decides who wins. */
  total: number;
}

class ScannerRuntime {
  private readonly input: number[];
  private position = 0;
  private readonly interpreter: Interpreter;
  private readonly textCells: Cell[] = [0];
  private readonly lengthCell: Cell[];
  private readonly lineCell: Cell[];
  private readonly conditionCell: Cell[];
  private readonly countLines: boolean;
  /** Text kept by yymore(), which the next match is added to. */
  private moreText: number[] | null = null;
  private keepMore = false;
  private atLineStart = true;
  private actionDepth = 0;

  constructor(
    private readonly scanner: CompiledScanner,
    stdin: string,
    private readonly callbacks: ScannerCallbacks,
  ) {
    this.input = utf8Bytes(stdin);
    this.countLines = scanner.file.options.has('yylineno');
    this.interpreter = new Interpreter(
      scanner.program,
      {
        write: (stream, bytes) => callbacks.write(stream, bytes),
        readByte: () => {
          const byte = this.input[this.position];
          if (byte === undefined) return -1;
          this.position++;
          return byte;
        },
      },
      {
        yylex: () => this.yylex(),
        yywrap: () => 1,
        __echo: () => {
          const length = this.lengthCell[0] as number;
          const bytes = (this.textCells.slice(0, length) as number[]).map((byte) => byte & 0xff);
          callbacks.write('stdout', bytes);
          return 0;
        },
        __reject: (_args, at) => {
          this.requireAction('REJECT', at);
          throw new RejectSignal();
        },
        yyterminate: (_args, at) => {
          this.requireAction('yyterminate()', at);
          throw new TerminateSignal();
        },
        yymore: () => {
          const length = this.lengthCell[0] as number;
          this.moreText = (this.textCells.slice(0, length) as number[]).map((byte) => byte & 0xff);
          this.keepMore = true;
          return 0;
        },
        yyless: (args, at) => this.yyless(this.interpreter.toInt(args[0] as Value, at), at),
        input: () => {
          const byte = this.input[this.position];
          // Flex 2.6 returns 0 at the end of the input.
          if (byte === undefined) return 0;
          this.position++;
          if (byte === 0x0a && this.countLines) this.addLines(1);
          return byte;
        },
        unput: (args, at) => {
          const byte = this.interpreter.toInt(args[0] as Value, at) & 0xff;
          if (this.position > 0) this.input[--this.position] = byte;
          else this.input.unshift(byte);
          if (byte === 0x0a && this.countLines) this.addLines(-1);
          return 0;
        },
      },
    );

    const define = this.interpreter;
    define.defineGlobal('yytext', 'ptr', new Ptr(this.textCells, 0, 'char'), 'char');
    this.lengthCell = define.defineGlobal('yyleng', 'int', 0).mem;
    this.lineCell = define.defineGlobal('yylineno', 'int', 1).mem;
    this.conditionCell = define.defineGlobal('yy_start_condition', 'int', 0).mem;
    define.defineGlobal('yyin', 'ptr', 0);
    define.defineGlobal('yyout', 'ptr', 1);
    scanner.conditions.forEach((name, id) => define.defineConstant(name, id));
  }

  private addLines(count: number): void {
    this.lineCell[0] = (this.lineCell[0] as number) + count;
  }

  private requireAction(what: string, at: number): void {
    if (this.actionDepth === 0) {
      this.interpreter.fail(`${what} only works inside a rule's action.`, at);
    }
  }

  private setText(bytes: readonly number[]): void {
    this.textCells.length = bytes.length + 1;
    bytes.forEach((byte, index) => {
      this.textCells[index] = (byte << 24) >> 24;
    });
    this.textCells[bytes.length] = 0;
    this.lengthCell[0] = bytes.length;
  }

  private yyless(keep: number, at: number): Value {
    this.requireAction('yyless()', at);
    const length = this.lengthCell[0] as number;
    if (keep < 0 || keep > length) {
      this.interpreter.fail(`yyless(${keep}) is outside this match of ${length} characters.`, at);
    }
    if (this.countLines) {
      for (let i = keep; i < length; i++) {
        if (this.textCells[i] === 0x0a) this.addLines(-1);
      }
    }
    const rewound = this.textCells.slice(0, keep) as number[];
    this.position -= length - keep;
    this.setText(rewound);
    return 0;
  }

  /** Every rule that matches here, best first: longest match, then the earliest rule. */
  private candidates(): Candidate[] {
    const condition = this.conditionCell[0] as number;
    const rules = this.scanner.active.get(condition);
    if (!rules) {
      throw new EngineError({
        code: 'c_runtime',
        message: `BEGIN set start condition ${condition}, which does not exist.`,
        hint: 'Use a name declared with %s or %x, or INITIAL.',
      });
    }
    const found: Candidate[] = [];
    const lineStart = this.atLineStart;
    for (const rule of rules) {
      if (!rule.matcher) continue;
      if (rule.rule.pattern?.atLineStart && !lineStart) continue;
      if (rule.trailing) {
        const best = this.withTrailing(rule);
        if (best) found.push(best);
        continue;
      }
      const end = rule.matcher.longest(this.input, this.position);
      if (end > this.position) found.push({ rule, textEnd: end, total: end });
    }
    return found.sort((a, b) => b.total - a.total || a.rule.index - b.rule.index);
  }

  private withTrailing(rule: CompiledRule): Candidate | null {
    let best: Candidate | null = null;
    for (const textEnd of (rule.matcher as Matcher).ends(this.input, this.position)) {
      // Matching no text would leave the scanner in the same place forever.
      if (textEnd === this.position) continue;
      const total = (rule.trailing as Matcher).longest(this.input, textEnd);
      if (total === -1) continue;
      if (!best || total > best.total || (total === best.total && textEnd > best.textEnd)) {
        best = { rule, textEnd, total };
      }
    }
    return best;
  }

  private eofRule(): CompiledRule | undefined {
    const condition = this.scanner.conditions[this.conditionCell[0] as number];
    const eofRules = this.scanner.rules.filter((rule) => rule.matcher === null);
    return (
      eofRules.find(
        ({ rule }) =>
          rule.conditions.includes(condition as string) || rule.conditions.includes('*'),
      ) ?? eofRules.find(({ rule }) => rule.conditions.length === 0)
    );
  }

  private decode(bytes: readonly number[]): string {
    const decoder = new Utf8Decoder();
    return decoder.write(bytes) + decoder.flush();
  }

  private *yylex(): Step {
    const scope = new Scope(this.interpreter.globals);
    const entered = yield* this.interpreter.runIn(this.scanner.local, scope);
    if (entered?.kind === 'return') return entered.value;
    for (;;) {
      yield;
      if (this.position >= this.input.length) {
        const rule = this.eofRule();
        if (rule) {
          this.setText([]);
          const outcome = yield* this.runAction(rule, scope);
          if (outcome.finished) return outcome.value;
          continue;
        }
        if (this.interpreter.hasFunction('yywrap')) {
          const wrapped = yield* this.interpreter.callFunction('yywrap', [], 0);
          if (!this.interpreter.truthy(wrapped)) continue;
        }
        return 0;
      }

      const candidates = this.candidates();
      if (candidates.length === 0) {
        this.defaultRule();
        continue;
      }
      let accepted = false;
      for (const candidate of candidates) {
        const outcome = yield* this.tryCandidate(candidate, scope);
        if (outcome.rejected) continue;
        accepted = true;
        if (outcome.finished) return outcome.value;
        break;
      }
      // Flex treats a match every rule rejected as a job for the default rule.
      if (!accepted) this.defaultRule();
    }
  }

  private defaultRule(): void {
    if (this.scanner.file.options.has('nodefault')) {
      throw new EngineError({
        code: 'c_runtime',
        message: 'No rule matched this input, and %option nodefault turns off the default rule.',
        hint: 'Add a catch-all rule at the end, such as: . { /* handle it */ }',
      });
    }
    const byte = this.input[this.position] as number;
    this.position++;
    this.atLineStart = byte === 0x0a;
    if (byte === 0x0a && this.countLines) this.addLines(1);
    this.callbacks.onMatch?.({ ruleLine: null, text: this.decode([byte]) });
    this.callbacks.write('stdout', [byte]);
  }

  private *tryCandidate(
    candidate: Candidate,
    scope: Scope,
  ): Generator<void, { finished: boolean; rejected: boolean; value: Value }, void> {
    const start = this.position;
    const line = this.lineCell[0] as number;
    const matched = this.input.slice(start, candidate.textEnd);
    const prefix = this.moreText;
    this.keepMore = false;
    this.moreText = null;
    this.setText(prefix ? [...prefix, ...matched] : matched);
    this.position = candidate.textEnd;
    if (this.countLines) {
      this.addLines(matched.filter((byte) => byte === 0x0a).length);
    }
    this.callbacks.onMatch?.({
      ruleLine: candidate.rule.rule.line,
      text: this.decode(matched),
    });
    const outcome = yield* this.runAction(candidate.rule, scope);
    if (outcome.rejected) {
      // Put everything back so the next-best rule sees the same input.
      this.position = start;
      this.lineCell[0] = line;
      this.moreText = prefix;
    } else {
      const last = this.input[this.position - 1];
      this.atLineStart = this.position === 0 || last === 0x0a;
    }
    return outcome;
  }

  private *runAction(
    rule: CompiledRule,
    scope: Scope,
  ): Generator<void, { finished: boolean; rejected: boolean; value: Value }, void> {
    this.actionDepth++;
    try {
      const signal = yield* this.interpreter.runBody(rule.body, scope);
      if (!this.keepMore) this.moreText = null;
      if (signal?.kind === 'return') {
        return { finished: true, rejected: false, value: signal.value };
      }
      return { finished: false, rejected: false, value: 0 };
    } catch (error) {
      if (error instanceof RejectSignal) return { finished: false, rejected: true, value: 0 };
      if (error instanceof TerminateSignal) return { finished: true, rejected: false, value: 0 };
      throw error;
    } finally {
      this.actionDepth--;
    }
  }

  *run(): Generator<void, number, void> {
    try {
      yield* this.interpreter.initializeGlobals();
      if (this.interpreter.hasFunction('main')) {
        const main = this.scanner.program.functions.get('main');
        const args: Value[] =
          main?.params.length === 2
            ? [1, new Ptr([new Ptr([...utf8Bytes('program'), 0], 0, 'char'), 0], 0, 'ptr')]
            : [];
        const result = yield* this.interpreter.callFunction('main', args, main?.at ?? 0);
        return this.interpreter.toInt(result, 0);
      }
      // What libfl's main does, for files that do not write their own.
      while (this.interpreter.truthy(yield* this.yylex()));
      return 0;
    } catch (error) {
      if (error instanceof ExitSignal) return error.code;
      if (error instanceof RangeError) throw tooDeep();
      throw error;
    }
  }
}

/**
 * Runs a compiled scanner on some input, one small step for each `next()`, so the caller can
 * stay responsive and stop it at any time. Returns the exit code. Runtime mistakes throw an
 * EngineError with the code c_runtime.
 */
export function runScanner(
  scanner: CompiledScanner,
  stdin: string,
  callbacks: ScannerCallbacks,
): Generator<void, number, void> {
  return new ScannerRuntime(scanner, stdin, callbacks).run();
}
