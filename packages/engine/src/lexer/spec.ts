import { EngineError } from '../core/result';
import { TOKEN_CATEGORIES, type LexRule, type TokenCategory } from './mini-lex';

const RULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses the playground's rule format, one rule per line:
 *
 *   # comments and blank lines are ignored
 *   IF     if            %keyword
 *   NUM    [0-9]+        %literal
 *   WS     [ \t\n]+      %skip
 */
export function parseLexSpec(text: string): LexRule[] {
  const rules: LexRule[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const lineNumber = index + 1;

    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) {
      throw new EngineError({
        code: 'bad_rule_line',
        message: `Line ${lineNumber}: a rule needs a name and a pattern.`,
        hint: 'Write it like this: NUMBER [0-9]+',
      });
    }
    const name = match[1] as string;
    if (!RULE_NAME.test(name)) {
      throw new EngineError({
        code: 'bad_rule_name',
        message: `Line ${lineNumber}: "${name}" is not a valid rule name.`,
        hint: 'Use letters, digits and underscores, starting with a letter.',
      });
    }

    let pattern = match[2] as string;
    let skip = false;
    let category: TokenCategory | undefined;
    for (let tag = /\s+%(\w+)$/.exec(pattern); tag; tag = /\s+%(\w+)$/.exec(pattern)) {
      const word = tag[1] as string;
      if (word === 'skip') skip = true;
      else if ((TOKEN_CATEGORIES as readonly string[]).includes(word)) {
        category = word as TokenCategory;
      } else {
        throw new EngineError({
          code: 'bad_rule_tag',
          message: `Line ${lineNumber}: %${word} is not a tag this tool knows.`,
          hint: `Use %skip, or a category: ${TOKEN_CATEGORIES.map((c) => `%${c}`).join(', ')}.`,
        });
      }
      pattern = pattern.slice(0, tag.index);
    }

    rules.push({ name, pattern, ...(skip ? { skip } : {}), ...(category ? { category } : {}) });
  });
  return rules;
}
