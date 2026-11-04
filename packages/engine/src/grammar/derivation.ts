import { TraceRecorder, type Trace } from '../core/trace';
import { formatGrammarProduction } from './cfg';
import type { Grammar, GrammarParseNode, GrammarParseTree, GrammarProduction } from './types';

export type GrammarDerivationOrder = 'leftmost' | 'rightmost';

export interface GrammarDerivationStep {
  /** The sentential form after this step. */
  readonly form: readonly string[];
  /** The tree node behind each symbol of the form. */
  readonly formNodes: readonly number[];
  /** The node this step expanded, and where it sat in the previous form. */
  readonly expandedNode: number | null;
  readonly expandedAt: number | null;
  readonly production: number | null;
  /** The new symbols sit at form[changedFrom] up to but not including form[changedTo]. */
  readonly changedFrom: number;
  readonly changedTo: number;
  /** Every tree node that exists after this step. */
  readonly revealed: readonly number[];
}

export interface GrammarDerivation {
  readonly order: GrammarDerivationOrder;
  readonly steps: readonly GrammarDerivationStep[];
  /** One step per form. Its state is the index into `steps`. */
  readonly trace: Trace<{ readonly index: number }>;
}

/** Reads a derivation out of a parse tree. The same tree gives one of each order. */
export function grammarDerivationSteps(
  tree: GrammarParseTree,
  order: GrammarDerivationOrder,
): GrammarDerivationStep[] {
  const nodeAt = (id: number) => tree.nodes[id] as GrammarParseNode;
  const rootSymbol = nodeAt(tree.root).symbol;
  let formNodes = [tree.root];
  let revealed = [tree.root];
  const steps: GrammarDerivationStep[] = [
    {
      form: [rootSymbol],
      formNodes,
      expandedNode: null,
      expandedAt: null,
      production: null,
      changedFrom: 0,
      changedTo: 1,
      revealed,
    },
  ];

  const expandable = (id: number) => {
    const node = nodeAt(id);
    return node.kind === 'nonterminal' && node.children.length > 0;
  };
  for (;;) {
    const at =
      order === 'leftmost' ? formNodes.findIndex(expandable) : formNodes.findLastIndex(expandable);
    if (at === -1) return steps;
    const id = formNodes[at] as number;
    const node = nodeAt(id);
    // ε shows in the tree but takes up no room in the form.
    const inserted = node.children.filter((child) => nodeAt(child).kind !== 'epsilon');
    formNodes = [...formNodes.slice(0, at), ...inserted, ...formNodes.slice(at + 1)];
    revealed = [...revealed, ...node.children];
    steps.push({
      form: formNodes.map((nodeId) => nodeAt(nodeId).symbol),
      formNodes,
      expandedNode: id,
      expandedAt: at,
      production: node.production,
      changedFrom: at,
      changedTo: at + inserted.length,
      revealed,
    });
  }
}

/** A derivation with an explanation for each step. */
export function grammarDerivation(
  grammar: Grammar,
  tree: GrammarParseTree,
  order: GrammarDerivationOrder,
): GrammarDerivation {
  const steps = grammarDerivationSteps(tree, order);
  const recorder = new TraceRecorder<{ index: number }>();
  const last = steps.length - 1;
  steps.forEach((step, index) => {
    if (step.production === null) {
      recorder.add(
        `Start from ${step.form.join(' ')}`,
        `A ${order} derivation always rewrites the ${order === 'leftmost' ? 'first' : 'last'} nonterminal in the sentential form.`,
        { index },
      );
      return;
    }
    const production = grammar.productions[step.production] as GrammarProduction;
    const previous = steps[index - 1] as GrammarDerivationStep;
    const before = previous.form.join(' ');
    const ending =
      index !== last
        ? ''
        : order === 'rightmost'
          ? ' No nonterminals are left, so this is the sentence. Read backwards, these steps are exactly the reductions a shift-reduce parser makes.'
          : ' No nonterminals are left, so this is the sentence. These are the steps a top-down parser makes, in the same order.';
    recorder.add(
      `Expand ${production.head}`,
      `In ${before}, the ${order} nonterminal is ${production.head}. The tree says to use ${formatGrammarProduction(production)}.${ending}`,
      { index },
    );
  });
  return { order, steps, trace: recorder.finish() };
}
