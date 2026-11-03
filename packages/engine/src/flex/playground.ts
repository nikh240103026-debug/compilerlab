import { attempt } from '../core/result';
import { buildLexer } from '../lexer/mini-lex';
import type { FlexFile, FlexRule } from './spec';

export interface PlaygroundSpec {
  /** Rules in the token-stream visualizer's format, or null if none of them can be replayed. */
  rules: string | null;
  /** Why rules were left out, one sentence for each. */
  omitted: string[];
}

/** Features the visualizer's pattern language does not have. */
const NOT_ANIMATED: readonly [RegExp, string][] = [
  [/(^|[^\\])\{\d/, 'uses a repeat count'],
  [/\[\[?:/, 'uses a named character class'],
  [/\\x|\\[0-7]/, 'uses a numeric character code'],
  [/\P{ASCII}/u, 'uses non-ASCII text'],
];

function expandNames(pattern: string, definitions: ReadonlyMap<string, string>): string {
  let text = pattern;
  // Definitions can use earlier definitions, but the first section cannot form a cycle.
  for (let pass = 0; pass <= definitions.size; pass++) {
    const next = text.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (whole, name: string) => {
      const definition = definitions.get(name);
      return definition === undefined ? whole : `(${definition})`;
    });
    if (next === text) return text;
    text = next;
  }
  return text;
}

function ruleName(rule: FlexRule, taken: Set<string>): string {
  const returned = /\breturn\s*\(?\s*([A-Za-z_]\w*)/.exec(rule.actionText)?.[1];
  const base = returned ?? `RULE_${rule.line}`;
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`;
  taken.add(name);
  return name;
}

function isEmptyAction(text: string): boolean {
  return /^(;|\{\s*;?\s*\}|)$/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').trim());
}

function whyNotAnimated(rule: FlexRule): string | null {
  if (!rule.pattern) return 'is an end-of-file rule';
  if (rule.conditions.some((name) => name !== 'INITIAL')) return 'uses a start condition';
  if (rule.pattern.atLineStart) return 'only matches at the start of a line';
  if (rule.pattern.trailing) return 'uses trailing context';
  return null;
}

/**
 * Rewrites a flex file's rules for the token-stream visualizer, so students can watch the
 * theory run on the same rules. It animates one DFA, so some flex features have to be left out.
 */
export function flexToPlayground(file: FlexFile): PlaygroundSpec {
  const lines: string[] = [];
  const omitted: string[] = [];
  const taken = new Set<string>();
  for (const rule of file.rules) {
    const leaveOut = (reason: string) => {
      omitted.push(`The rule on line ${rule.line} ${reason}, so it is not shown.`);
    };
    const reason = whyNotAnimated(rule);
    if (reason) {
      leaveOut(reason);
      continue;
    }
    const pattern = expandNames(rule.text.replace(/^<[^>]*>/, ''), file.definitions);
    const unsupported = NOT_ANIMATED.find(([test]) => test.test(pattern));
    if (unsupported) {
      leaveOut(unsupported[1]);
      continue;
    }
    const name = ruleName(rule, taken);
    const built = attempt(() => buildLexer([{ name, pattern }]));
    if (!built.ok) {
      leaveOut('is too complex for the visualizer');
      continue;
    }
    lines.push(`${name}  ${pattern}${isEmptyAction(rule.actionText) ? '  %skip' : ''}`);
  }
  return { rules: lines.length > 0 ? lines.join('\n') : null, omitted };
}
