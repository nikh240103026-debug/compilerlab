import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import { sddClassify, type SddClassification } from './sdd-classify';
import {
  sddEffectText,
  sddEvalExpr,
  sddFormatExpr,
  sddShowValue,
  type SddAttrRef,
  type SddRule,
  type SddValue,
} from './sdd-expr';
import {
  sddBodyChildren,
  sddLexicalValue,
  sddParseInput,
  type SddParseTree,
  type SddTreeNode,
} from './sdd-parse';
import {
  sddAttributeTable,
  sddCheckDefinition,
  sddParseSpec,
  type SddAttributeInfo,
  type SddProduction,
  type SddSpec,
} from './sdd-spec';

// The whole SDD pipeline of chapter 5: parse the input, lay out one attribute instance per use in
// the tree, connect them into the dependency graph, sort it, then evaluate in that order.

export const MAX_SDD_ATTRIBUTES = 1000;

/** One attribute of one node in the parse tree. Dependency graph nodes are these. */
export interface SddAttrInstance {
  id: number;
  node: number;
  attr: string;
  /** Like T'.inh, or the rule's text for a side effect. */
  label: string;
  /**
   * A side effect becomes a dummy attribute, which is how the book fits it in the graph. An
   * attribute no rule defines shows as 'undefined', and anything reading it has no value.
   */
  kind: 'synthesized' | 'inherited' | 'lexical' | 'effect' | 'undefined';
  ruleText: string | null;
  /** The production whose rule defines this instance. */
  production: number | null;
  /** The tree node where that production was applied. */
  ruleNode: number | null;
}

export interface SddDependencyEdge {
  from: number;
  to: number;
}

export type SddEvalPhase = 'parse' | 'graph' | 'order' | 'evaluate' | 'finished';

export interface SddEvalState {
  phase: SddEvalPhase;
  /** attrs[0..attrCount) exist at this step, so the graph can grow on screen. */
  attrCount: number;
  /** edges[0..edgeCount) exist at this step. */
  edgeCount: number;
  currentAttr: number | null;
  currentNode: number | null;
  /** The evaluation order found so far. */
  order: number[];
  /** Attributes with nothing left to wait for, during the sort. */
  ready: number[];
  /** Unfinished incoming edges per attribute, during the sort. */
  inDegree: number[];
  /** The value of each attribute at this step, by attribute id. */
  values: (SddValue | null)[];
  cycle: number[] | null;
  effects: string[];
}

export interface SddAnalysis {
  spec: SddSpec;
  attributes: SddAttributeInfo[];
  classification: SddClassification;
}

export interface SddEvalResult extends SddAnalysis, SddParseTree {
  attrs: SddAttrInstance[];
  edges: SddDependencyEdge[];
  /** A topological order of attribute ids. Shorter than attrs when there is a cycle. */
  order: number[];
  /** Attribute ids around one cycle, or null when the graph has no cycle. */
  cycle: number[] | null;
  values: (SddValue | null)[];
  /** What side-effect rules did, in order. */
  effects: string[];
  /** Attributes that could not get a value, and why. */
  problems: string[];
  trace: Trace<SddEvalState>;
}

/** Parses and classifies a definition, without any input. */
export function sddAnalyze(specText: string): SddAnalysis {
  const spec = sddParseSpec(specText);
  sddCheckDefinition(spec);
  return { spec, attributes: sddAttributeTable(spec), classification: sddClassify(spec) };
}

interface Definition {
  rule: SddRule;
  host: SddTreeNode;
}

/** Finds a cycle among the attributes the sort could not remove. Each of them has a leftover input. */
function findCycle(leftover: Set<number>, edges: readonly SddDependencyEdge[]): number[] {
  const inputs = new Map<number, number>();
  for (const { from, to } of edges) {
    if (leftover.has(from) && leftover.has(to) && !inputs.has(to)) inputs.set(to, from);
  }
  const seenAt = new Map<number, number>();
  const walk: number[] = [];
  let current = [...leftover][0] as number;
  while (!seenAt.has(current)) {
    seenAt.set(current, walk.length);
    walk.push(current);
    current = inputs.get(current) as number;
  }
  // Walking backward along edges, so reverse to read in the direction values flow.
  return walk.slice(seenAt.get(current)).toReversed();
}

/** Parses the input and evaluates the definition on it, with every step in the trace. */
export function sddEvaluate(specText: string, input: string): SddEvalResult {
  const analysis = sddAnalyze(specText);
  const { spec, attributes } = analysis;
  const tree = sddParseInput(spec, input);
  const { tokens, nodes } = tree;
  const recorder = new TraceRecorder<SddEvalState>();

  const kindTable = new Map(attributes.map((info) => [`${info.symbol}.${info.attr}`, info.kind]));
  const attrs: SddAttrInstance[] = [];
  const edges: SddDependencyEdge[] = [];
  const definitions = new Map<number, Definition>();
  const instanceIds = new Map<string, number>();
  const edgeKeys = new Set<string>();

  const instance = (nodeId: number, attr: string, label?: string): SddAttrInstance => {
    const key = `${nodeId}.${attr}`;
    const known = instanceIds.get(key);
    if (known !== undefined) return attrs[known] as SddAttrInstance;
    if (attrs.length >= MAX_SDD_ATTRIBUTES) {
      throw new EngineError({
        code: 'sdd_input_too_long',
        message: `The dependency graph would have more than ${MAX_SDD_ATTRIBUTES} attributes.`,
        hint: 'Try a shorter input.',
      });
    }
    const node = nodes[nodeId] as SddTreeNode;
    const tableKind = kindTable.get(`${node.symbol}.${attr}`);
    const created: SddAttrInstance = {
      id: attrs.length,
      node: nodeId,
      attr,
      label: label ?? `${node.symbol}.${attr}`,
      kind:
        node.kind === 'terminal'
          ? 'lexical'
          : tableKind === 'synthesized' || tableKind === 'inherited'
            ? tableKind
            : 'undefined',
      ruleText: null,
      production: null,
      ruleNode: null,
    };
    attrs.push(created);
    instanceIds.set(key, created.id);
    return created;
  };

  // ------ Parse ------
  const baseState = (): SddEvalState => ({
    phase: 'parse',
    attrCount: 0,
    edgeCount: 0,
    currentAttr: null,
    currentNode: null,
    order: [],
    ready: [],
    inDegree: [],
    values: [],
    cycle: null,
    effects: [],
  });
  recorder.add(
    'Parse the input',
    `The input has ${tokens.length} token${tokens.length === 1 ? '' : 's'}, and parsing gives a tree with ${nodes.length} nodes. Semantic rules attach to this tree: each interior node gets the rules of the production used there.`,
    baseState(),
  );

  // ------ Dependency graph ------
  // Rule instances are remembered so that the values below read through the same nodes.
  const nodeOfOccurrence = (host: SddTreeNode, occurrence: number): number =>
    occurrence === -1 ? host.id : (sddBodyChildren(nodes, host)[occurrence] as number);

  for (const host of nodes) {
    if (host.production === null) continue;
    const production = spec.productions[host.production] as SddProduction;
    production.rules.forEach((rule, ruleIndex) => {
      const target = rule.target
        ? instance(nodeOfOccurrence(host, rule.target.occurrence), rule.target.attr)
        : instance(host.id, `effect${ruleIndex + 1}`, rule.text);
      target.ruleText = rule.text;
      target.production = production.index;
      target.ruleNode = host.id;
      if (!rule.target) target.kind = 'effect';
      definitions.set(target.id, { rule, host });
      const sources: string[] = [];
      for (const read of rule.reads) {
        const source = instance(nodeOfOccurrence(host, read.occurrence), read.attr);
        sources.push(source.label);
        const key = `${source.id}>${target.id}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({ from: source.id, to: target.id });
        }
      }
      const unique = [...new Set(sources)];
      recorder.add(
        `Graph: ${target.label}`,
        unique.length > 0
          ? `At the node for ${production.text}, the rule ${rule.text} means ${target.label} needs ${unique.join(' and ')}. Each of those gets an edge to ${target.label}.`
          : `At the node for ${production.text}, the rule ${rule.text} reads no other attribute, so ${target.label} has no incoming edge.`,
        {
          ...baseState(),
          phase: 'graph',
          attrCount: attrs.length,
          edgeCount: edges.length,
          currentAttr: target.id,
          currentNode: host.id,
        },
      );
    });
  }

  // ------ Topological order, by Kahn's algorithm. The smallest id goes first, so runs repeat. ------
  const inDegree = attrs.map(() => 0);
  const outgoing: number[][] = attrs.map(() => []);
  for (const { from, to } of edges) {
    inDegree[to] = (inDegree[to] as number) + 1;
    (outgoing[from] as number[]).push(to);
  }
  const remaining = inDegree.slice();
  const ready = attrs.flatMap((attr) => (remaining[attr.id] === 0 ? [attr.id] : []));
  const order: number[] = [];
  const graphState = (fields: Partial<SddEvalState>): SddEvalState => ({
    ...baseState(),
    phase: 'order',
    attrCount: attrs.length,
    edgeCount: edges.length,
    order: order.slice(),
    ready: ready.slice(),
    inDegree: remaining.slice(),
    ...fields,
  });
  recorder.add(
    'Start the topological sort',
    `An attribute can be evaluated once everything it needs is known. ${ready.length} attribute${ready.length === 1 ? ' has' : 's have'} no incoming edges, so they are ready now.`,
    graphState({}),
  );
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const next = ready.shift() as number;
    order.push(next);
    const released: string[] = [];
    for (const target of outgoing[next] as number[]) {
      remaining[target] = (remaining[target] as number) - 1;
      if (remaining[target] === 0) {
        ready.push(target);
        released.push((attrs[target] as SddAttrInstance).label);
      }
    }
    const attr = attrs[next] as SddAttrInstance;
    recorder.add(
      `Order: ${attr.label}`,
      `${attr.label} is number ${order.length} in the order. Its outgoing edges are removed${released.length > 0 ? `, which makes ${released.join(' and ')} ready` : ''}.`,
      graphState({ currentAttr: next, currentNode: attr.node }),
    );
  }

  let cycle: number[] | null = null;
  if (order.length < attrs.length) {
    const done = new Set(order);
    const leftover = new Set(attrs.flatMap((attr) => (done.has(attr.id) ? [] : [attr.id])));
    cycle = findCycle(leftover, edges);
    const names = cycle.map((id) => (attrs[id] as SddAttrInstance).label);
    recorder.add(
      'A cycle: no evaluation order exists',
      `The sort stopped with ${leftover.size} attributes left, and each one waits on another of them. For example: ${[...names, names[0]].join(' → ')}. No order can evaluate these, so this definition has no answer on this tree.`,
      { ...graphState({ cycle }), phase: 'order' },
    );
  }

  // ------ Evaluate ------
  const values: (SddValue | null)[] = attrs.map(() => null);
  const effects: string[] = [];
  const problems: string[] = [];
  const evalState = (fields: Partial<SddEvalState>): SddEvalState => ({
    ...graphState({ cycle }),
    phase: 'evaluate',
    ready: [],
    inDegree: [],
    values: values.slice(),
    effects: effects.slice(),
    ...fields,
  });

  if (!cycle) {
    for (const id of order) {
      const attr = attrs[id] as SddAttrInstance;
      const node = nodes[attr.node] as SddTreeNode;
      const definition = definitions.get(id);
      let title = `Evaluate ${attr.label}`;
      let explanation: string;
      if (attr.kind === 'lexical') {
        const value = sddLexicalValue(node, attr.attr);
        values[id] = value;
        if (value === null) {
          const problem = `${attr.label} has no value, because the lexer gives a ${node.symbol} only lexval and lexeme.`;
          problems.push(problem);
          explanation = problem;
        } else {
          explanation = `${attr.label} = ${value}. This one comes from the lexer, not from a rule.`;
        }
      } else if (!definition) {
        const problem = `No rule defines ${attr.label} at this node, so it has no value here.`;
        problems.push(problem);
        explanation = problem;
      } else {
        const { rule, host } = definition;
        const read = (ref: SddAttrRef): SddValue | null => {
          const source = instanceIds.get(`${nodeOfOccurrence(host, ref.occurrence)}.${ref.attr}`);
          return source === undefined ? null : (values[source] as SddValue | null);
        };
        const substituted = sddFormatExpr(rule.expr, (ref) => sddShowValue(read(ref)));
        if (rule.target) {
          const value = sddEvalExpr(rule.expr, read);
          values[id] = value;
          if (value === null) {
            const problem = `${rule.text} cannot be computed, because an attribute it reads has no value.`;
            problems.push(problem);
            explanation = problem;
          } else {
            if (rule.expr.kind === 'literal') explanation = `${rule.text}.`;
            else if (substituted === String(value)) {
              explanation = `${rule.text}, so ${attr.label} = ${sddShowValue(value)}.`;
            } else {
              explanation = `${rule.text}. That is ${substituted} = ${sddShowValue(value)}.`;
            }
          }
        } else {
          title = `Side effect: ${rule.text}`;
          const text = sddEffectText(rule.expr, read);
          values[id] = text;
          if (text === null) {
            const problem = `${rule.text} cannot run, because an attribute it reads has no value.`;
            problems.push(problem);
            explanation = problem;
          } else {
            effects.push(text);
            explanation = `${rule.text} runs now, as ${text}. A side effect waits for what it reads, just like an attribute.`;
          }
        }
      }
      recorder.add(title, explanation, evalState({ currentAttr: id, currentNode: attr.node }));
    }
  }

  const lastLabel = attrs.length > 0 ? rootSummary(tree, attrs, values) : '';
  recorder.add(
    'Finished',
    cycle
      ? 'Evaluation did not run, because the dependency graph has a cycle.'
      : problems.length > 0
        ? `Evaluation finished, but ${problems.length} attribute${problems.length === 1 ? '' : 's'} got no value. ${lastLabel}`
        : `Every attribute has its value. ${lastLabel}`,
    { ...evalState({}), phase: 'finished' },
  );

  return {
    ...analysis,
    ...tree,
    attrs,
    edges,
    order,
    cycle,
    values,
    effects,
    problems,
    trace: recorder.finish(),
  };
}

function rootSummary(
  tree: SddParseTree,
  attrs: readonly SddAttrInstance[],
  values: readonly (SddValue | null)[],
): string {
  const atRoot = attrs.filter((attr) => attr.node === tree.root && attr.kind !== 'effect');
  if (atRoot.length === 0) return '';
  const shown = atRoot.map((attr) => `${attr.label} = ${sddShowValue(values[attr.id] ?? null)}`);
  return `At the root: ${shown.join(', ')}.`;
}
