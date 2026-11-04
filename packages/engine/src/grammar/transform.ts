import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { formatGrammarProduction, grammarFromRules } from './cfg';
import { grammarCycles, grammarLeftRecursion } from './diagnostics';
import type { Grammar } from './types';

const MAX_TRANSFORMED_PRODUCTIONS = 1_000;
const MAX_FACTORING_ROUNDS = 400;

export interface GrammarRuleRow {
  readonly head: string;
  readonly bodies: readonly (readonly string[])[];
}

export interface GrammarTransformStep {
  /** The whole grammar as it stands at this step. */
  readonly rules: readonly GrammarRuleRow[];
  readonly activeHead: string | null;
  /** Productions this step added and removed, formatted, for a green and red diff. */
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface GrammarTransformResult {
  readonly grammar: Grammar;
  readonly changed: boolean;
  /** Limits of the algorithm that apply to this particular grammar. */
  readonly notes: readonly string[];
  readonly trace: Trace<GrammarTransformStep>;
}

const sameBody = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((symbol, index) => symbol === b[index]);

function uniqueBodies(bodies: readonly string[][]): string[][] {
  const kept: string[][] = [];
  for (const body of bodies) if (!kept.some((other) => sameBody(other, body))) kept.push(body);
  return kept;
}

/** The grammar while it is being rewritten, one list of bodies per head. */
class RuleBook {
  readonly order: string[];
  private readonly bodies = new Map<string, string[][]>();
  private readonly taken: Set<string>;

  constructor(private readonly grammar: Grammar) {
    this.order = [...grammar.nonterminals];
    this.taken = new Set([...grammar.nonterminals, ...grammar.terminals]);
    for (const head of this.order) this.bodies.set(head, []);
    for (const { head, body } of grammar.productions) this.bodies.get(head)?.push([...body]);
  }

  get(head: string): string[][] {
    return this.bodies.get(head) as string[][];
  }

  set(head: string, bodies: string[][]): void {
    this.bodies.set(head, bodies);
    let total = 0;
    for (const list of this.bodies.values()) total += list.length;
    if (total > MAX_TRANSFORMED_PRODUCTIONS) {
      throw new EngineError({
        code: 'grammar_too_large',
        message: `This transformation would produce over ${MAX_TRANSFORMED_PRODUCTIONS} productions.`,
        hint: 'Substituting one nonterminal into another can grow a grammar very fast. Try a smaller grammar.',
      });
    }
  }

  /** A new name for a helper nonterminal, placed right after the one it helps. */
  addHelper(head: string, bodies: string[][]): string {
    let name = `${head}'`;
    while (this.taken.has(name)) name += "'";
    this.taken.add(name);
    this.order.splice(this.order.indexOf(head) + 1, 0, name);
    this.set(name, bodies);
    return name;
  }

  snapshot(): GrammarRuleRow[] {
    return this.order.map((head) => ({ head, bodies: this.get(head).map((body) => [...body]) }));
  }

  toGrammar(): Grammar {
    const rules = this.order.flatMap((head) => this.get(head).map((body) => ({ head, body })));
    return grammarFromRules(this.grammar.start, rules);
  }
}

const show = (head: string, body: readonly string[]) => formatGrammarProduction({ head, body });

/**
 * Dragon Book Algorithm 4.19. Nonterminals are taken in grammar order. Each one first has earlier
 * nonterminals substituted out of its leading position, then its immediate left recursion removed.
 *
 *   A → A α | β   becomes   A → β A',  A' → α A' | ε
 *
 * The algorithm is only guaranteed for grammars with no cycles and no ε-productions. It runs on
 * others too, because it often still works, but the result is checked and `notes` says if it did not.
 */
export function grammarEliminateLeftRecursion(grammar: Grammar): GrammarTransformResult {
  const book = new RuleBook(grammar);
  const recorder = new TraceRecorder<GrammarTransformStep>();
  const notes: string[] = [];
  let changed = false;
  const record = (
    title: string,
    explanation: string,
    activeHead: string | null,
    added: readonly string[] = [],
    removed: readonly string[] = [],
  ) => recorder.add(title, explanation, { rules: book.snapshot(), activeHead, added, removed });

  const hasEpsilon = grammar.productions.some(({ body }) => body.length === 0);
  const cycles = grammarCycles(grammar);
  if (hasEpsilon || cycles.length > 0) {
    notes.push(
      `The algorithm is only guaranteed for grammars with no ${cycles.length > 0 ? 'cycles' : 'ε-productions'}, and this one has ${cycles.length > 0 ? `a cycle through ${cycles[0]}` : 'at least one'}. The result below is checked afterwards.`,
    );
  }
  const order = [...grammar.nonterminals];
  record(
    'Put the nonterminals in order',
    `Take the nonterminals in the order ${order.join(', ')}. The goal is that every production Ai → Aj γ has j > i, because then no chain of leftmost symbols can come back around.`,
    null,
  );

  for (const [i, head] of order.entries()) {
    for (const earlier of order.slice(0, i)) {
      const current = book.get(head);
      if (!current.some((body) => body[0] === earlier)) continue;
      const added: string[] = [];
      const removed: string[] = [];
      const next: string[][] = [];
      for (const body of current) {
        if (body[0] !== earlier) {
          next.push(body);
          continue;
        }
        removed.push(show(head, body));
        for (const delta of book.get(earlier)) {
          const replaced = [...delta, ...body.slice(1)];
          next.push(replaced);
          added.push(show(head, replaced));
        }
      }
      book.set(head, uniqueBodies(next));
      changed = true;
      record(
        `Substitute ${earlier} into ${head}`,
        `${earlier} comes before ${head} in the order, so a production of ${head} that starts with ${earlier} could lead back around. Replace ${earlier} with each of its current bodies.`,
        head,
        added,
        removed,
      );
    }

    const bodies = book.get(head);
    const selfLoops = bodies.filter((body) => body[0] === head && body.length === 1);
    const alphas = bodies
      .filter((body) => body[0] === head && body.length > 1)
      .map((body) => body.slice(1));
    const betas = bodies.filter((body) => body[0] !== head);
    if (alphas.length === 0 && selfLoops.length === 0) {
      record(
        `${head} is fine`,
        `No production of ${head} starts with ${head}, so it has no immediate left recursion.`,
        head,
      );
      continue;
    }
    if (betas.length === 0) {
      notes.push(
        `Every production of ${head} starts with ${head}, so ${head} derives no finite string. It was left as it is.`,
      );
      record(
        `${head} cannot be fixed`,
        `Every production of ${head} starts with ${head}. There is no β to begin with, so ${head} can never finish, and there is nothing to rewrite it into.`,
        head,
      );
      continue;
    }
    if (selfLoops.length > 0) {
      book.set(
        head,
        bodies.filter((body) => !(body[0] === head && body.length === 1)),
      );
      changed = true;
      record(
        `Drop ${show(head, [head])}`,
        `${show(head, [head])} rewrites ${head} to itself and adds nothing to the language, so it goes.`,
        head,
        [],
        [show(head, [head])],
      );
      if (alphas.length === 0) continue;
    }

    const removed = [
      ...alphas.map((alpha) => show(head, [head, ...alpha])),
      ...betas.map((beta) => show(head, beta)),
    ];
    const helper = book.addHelper(head, []);
    book.set(helper, [...uniqueBodies(alphas).map((alpha) => [...alpha, helper]), []]);
    book.set(
      head,
      betas.map((beta) => [...beta, helper]),
    );
    changed = true;
    record(
      `Remove the left recursion from ${head}`,
      `${head} → ${head} α can repeat α any number of times, but must begin with a body that does not start with ${head}. So ${head} now produces that beginning, and the new nonterminal ${helper} produces the repeats on the right.`,
      head,
      [
        ...book.get(head).map((body) => show(head, body)),
        ...book.get(helper).map((body) => show(helper, body)),
      ],
      removed,
    );
  }

  const result = book.toGrammar();
  const left = grammarLeftRecursion(result).map(({ symbol }) => symbol);
  if (left.length > 0) {
    notes.push(
      `${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} still left recursive in the result, because of a nullable symbol or a cycle the algorithm does not handle.`,
    );
  }
  record(
    'Finished',
    left.length > 0
      ? `Done, but ${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} still left recursive.`
      : changed
        ? 'No nonterminal is left recursive now, and the language is unchanged. The parse trees are different, though: the recursion now leans right.'
        : 'This grammar had no left recursion to remove.',
    null,
  );
  return { grammar: result, changed, notes, trace: recorder.finish() };
}

function commonPrefix(a: readonly string[], b: readonly string[]): readonly string[] {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return a.slice(0, length);
}

/**
 * Dragon Book Algorithm 4.21. For each nonterminal, find the longest prefix α shared by two or
 * more alternatives and pull it out, repeating until no two alternatives share a first symbol.
 *
 *   A → α β1 | α β2 | γ   becomes   A → α A' | γ,  A' → β1 | β2
 */
export function grammarLeftFactor(grammar: Grammar): GrammarTransformResult {
  const book = new RuleBook(grammar);
  const recorder = new TraceRecorder<GrammarTransformStep>();
  let changed = false;
  const record = (
    title: string,
    explanation: string,
    activeHead: string | null,
    added: readonly string[] = [],
    removed: readonly string[] = [],
  ) => recorder.add(title, explanation, { rules: book.snapshot(), activeHead, added, removed });

  record(
    'Look for shared prefixes',
    'When two alternatives start the same way, a parser cannot choose between them by looking at the next token. Left factoring delays that choice until after the shared part has been read.',
    null,
  );

  for (let round = 0; ; round++) {
    if (round > MAX_FACTORING_ROUNDS) {
      throw new EngineError({
        code: 'grammar_too_large',
        message: 'Left factoring this grammar takes too many rounds.',
        hint: 'Try a smaller grammar.',
      });
    }
    let factored = false;
    for (const head of book.order) {
      const bodies = book.get(head);
      let prefix: readonly string[] = [];
      for (const [i, a] of bodies.entries()) {
        for (const b of bodies.slice(i + 1)) {
          const shared = commonPrefix(a, b);
          if (shared.length > prefix.length) prefix = shared;
        }
      }
      if (prefix.length === 0) continue;
      const matches = (body: readonly string[]) =>
        body.length >= prefix.length && prefix.every((symbol, index) => body[index] === symbol);
      const group = bodies.filter(matches);
      // ε goes last, the way the book lists alternatives.
      const rests = group
        .map((body) => body.slice(prefix.length))
        .sort((a, b) => Number(a.length === 0) - Number(b.length === 0));
      const helper = book.addHelper(head, rests);
      const firstIndex = bodies.findIndex(matches);
      const next = bodies.filter((body, index) => index === firstIndex || !matches(body));
      next[next.indexOf(bodies[firstIndex] as string[])] = [...prefix, helper];
      book.set(head, next);
      changed = true;
      factored = true;
      record(
        `Factor ${prefix.join(' ')} out of ${head}`,
        `${group.length} alternatives of ${head} start with ${prefix.join(' ')}, the longest prefix any two share. ${head} now reads that prefix and then ${helper} decides what comes next.`,
        head,
        [show(head, [...prefix, helper]), ...rests.map((rest) => show(helper, rest))],
        group.map((body) => show(head, body)),
      );
      break;
    }
    if (!factored) break;
  }

  record(
    'Finished',
    changed
      ? 'No two alternatives of any nonterminal share a first symbol now. Note that left factoring only sees symbols as written. A conflict hidden behind a nonterminal, such as A → B c | a with B → a, can remain.'
      : 'No two alternatives of any nonterminal share a first symbol, so there is nothing to factor.',
    null,
  );
  return { grammar: book.toGrammar(), changed, notes: [], trace: recorder.finish() };
}
