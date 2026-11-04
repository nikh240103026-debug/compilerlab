import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import {
  sddEffectText,
  sddEvalExpr,
  sddFormatExpr,
  sddShowValue,
  type SddAttrRef,
  type SddValue,
} from './sdd-expr';
import {
  sddBodyChildren,
  sddLexicalValue,
  sddParseInput,
  type SddParseTree,
  type SddTreeNode,
} from './sdd-parse';
import { sddParseSpec, type SddActionBlock, type SddProduction, type SddSpec } from './sdd-spec';

// A syntax-directed translation scheme: a grammar with actions embedded in production bodies, as
// in section 5.4. An action runs as soon as everything to its left has been recognized.
//
// The tree is parsed first, then both parsers are played over it. That is the book's general
// method from section 5.4.3, and it lets every scheme run, even one whose actions would give a real
// LL or LR parser a conflict. sdtAnalyze says which schemes those are.

export type SdtMode = 'bottom-up' | 'top-down';

export interface SdtActionInfo {
  id: number;
  production: number;
  productionText: string;
  position: number;
  text: string;
  placement: 'postfix' | 'embedded';
  /** The marker nonterminal a bottom-up parser needs, or null at the end of a production. */
  marker: string | null;
  /** When an LR parser would run it. */
  bottomUp: string;
  /** When an LL parser would run it. */
  topDown: string;
  /** Why a real parser may not manage this action, if that applies. */
  warning: string | null;
}

export interface SdtAnalysis {
  spec: SddSpec;
  /** True when every action is at the end of its production. */
  isPostfix: boolean;
  reason: string;
  actions: SdtActionInfo[];
  /** The grammar rewritten with a marker M → ε for each action inside a body. */
  markerGrammar: string[];
}

export type SdtEvent = 'start' | 'shift' | 'reduce' | 'expand' | 'match' | 'action' | 'accept';

export interface SdtAttributeValue {
  node: number;
  label: string;
  value: SddValue;
}

export interface SdtStepState {
  event: SdtEvent;
  /** Bottom of the stack first, so the top is the last entry. */
  stack: string[];
  /** Tokens already read. The rest is still input. */
  consumed: number;
  remaining: string[];
  production: number | null;
  node: number | null;
  /** The action that fired in this step. */
  action: number | null;
  /** Everything the actions have printed or done so far. */
  output: string[];
  attributes: SdtAttributeValue[];
}

export interface SdtResult extends SdtAnalysis, SddParseTree {
  mode: SdtMode;
  /** The action ids in the order they fired. */
  fired: number[];
  output: string[];
  trace: Trace<SdtStepState>;
}

function hasDirectLeftRecursion(spec: SddSpec): string | null {
  const found = spec.productions.find(
    (production) => production.body[0]?.symbol === production.head,
  );
  return found ? found.text : null;
}

/** Lists each action and when it would fire, without any input. */
export function sdtAnalyze(specText: string): SdtAnalysis {
  const spec = sddParseSpec(specText);
  const leftRecursive = hasDirectLeftRecursion(spec);
  const actions: SdtActionInfo[] = [];
  const markerGrammar: string[] = [];
  const markerRules: string[] = [];
  let markerCount = 0;

  for (const production of spec.productions) {
    const bodyItems: string[][] = production.body.map(() => []);
    const tail: string[] = [];
    for (const block of production.actions) {
      const placement = block.position === production.body.length ? 'postfix' : 'embedded';
      const marker = placement === 'embedded' ? `M${++markerCount}` : null;
      const before = production.body
        .slice(0, block.position)
        .map((symbol) => symbol.written)
        .join(' ');
      const after = production.body[block.position]?.written;
      let warning: string | null = null;
      if (
        placement === 'embedded' &&
        block.position === 0 &&
        production.body[0]?.symbol === production.head
      ) {
        warning =
          'This action sits at the left edge of a left-recursive production. An LL parser cannot use the production, and the marker gives an LR parser a conflict, so this scheme needs the parse tree first.';
      }
      if (marker) {
        (bodyItems[block.position] as string[]).push(marker);
        markerRules.push(`${marker} → ε { ${block.text} }`);
      } else {
        tail.push(`{ ${block.text} }`);
      }
      actions.push({
        id: actions.length,
        production: production.index,
        productionText: production.text,
        position: block.position,
        text: block.text,
        placement,
        marker,
        bottomUp: marker
          ? before
            ? `When the marker ${marker} → ε is reduced, right after ${before} is on the stack.`
            : `When the marker ${marker} → ε is reduced, before any of this body has been read.`
          : `When the parser reduces by ${production.text}.`,
        topDown: after
          ? `When the action reaches the top of the stack, right before ${after} is ${production.body[block.position]?.terminal ? 'matched' : 'expanded'}.`
          : `When the action reaches the top of the stack, after the whole body has been handled.`,
        warning,
      });
    }
    const pieces = production.body.flatMap((symbol, index) => [
      ...(bodyItems[index] as string[]),
      symbol.written,
    ]);
    const bodyText = [...pieces, ...tail].join(' ');
    markerGrammar.push(`${production.head} → ${bodyText || 'ε'}`);
  }
  markerGrammar.push(...markerRules);

  const isPostfix = actions.every((action) => action.placement === 'postfix');
  const reason = isPostfix
    ? 'Every action is at the end of its production, so this is a postfix SDT. An LR parser runs each action when it reduces, with no markers.'
    : `${actions.filter((action) => action.placement === 'embedded').length} action(s) sit inside a body, so this is not a postfix SDT. A bottom-up parser needs a marker nonterminal for each one.${leftRecursive ? ` The production ${leftRecursive} is left-recursive, so a predictive parser cannot run it without rewriting the grammar first.` : ''}`;
  return { spec, isPostfix, reason, actions, markerGrammar };
}

/** Parses the input and plays one parser over the tree, firing each action at its moment. */
export function sdtRun(specText: string, input: string, mode: SdtMode = 'bottom-up'): SdtResult {
  const analysis = sdtAnalyze(specText);
  const { spec, actions } = analysis;
  const tree = sddParseInput(spec, input);
  const { nodes, tokens } = tree;
  const recorder = new TraceRecorder<SdtStepState>();

  const attributes = new Map<string, SddValue>();
  let attributeList: SdtAttributeValue[] = [];
  let output: string[] = [];
  const fired: number[] = [];
  const stack: string[] = [];
  let consumed = 0;

  const add = (
    title: string,
    explanation: string,
    event: SdtEvent,
    fields: { production?: number | null; node?: number | null; action?: number | null } = {},
  ): void => {
    recorder.add(title, explanation, {
      event,
      stack: stack.slice(),
      consumed,
      remaining: tokens.slice(consumed).map((token) => token.text),
      production: fields.production ?? null,
      node: fields.node ?? null,
      action: fields.action ?? null,
      output,
      attributes: attributeList,
    });
  };

  const actionIdOf = (production: SddProduction, block: SddActionBlock): number =>
    actions.findIndex(
      (action) =>
        action.production === production.index &&
        action.position === block.position &&
        action.text === block.text,
    );

  /** Runs one action on a node, and says in words what it did. */
  const execute = (host: SddTreeNode, production: SddProduction, block: SddActionBlock): string => {
    const children = sddBodyChildren(nodes, host);
    const nodeOf = (occurrence: number): SddTreeNode =>
      occurrence === -1 ? host : (nodes[children[occurrence] as number] as SddTreeNode);
    const read = (ref: SddAttrRef): SddValue => {
      const node = nodeOf(ref.occurrence);
      const value =
        node.kind === 'terminal'
          ? sddLexicalValue(node, ref.attr)
          : (attributes.get(`${node.id}.${ref.attr}`) ?? null);
      if (value === null) {
        throw new EngineError({
          code: 'sdt_attribute_not_ready',
          message: `The action { ${block.text} } in ${production.text} reads ${ref.written}.${ref.attr}, but it has no value when the action runs.`,
          hint: 'Actions run left to right. Move this action after whatever computes that attribute.',
        });
      }
      return value;
    };
    const did: string[] = [];
    for (const rule of block.rules) {
      if (rule.target) {
        const value = sddEvalExpr(rule.expr, read) as SddValue;
        const node = nodeOf(rule.target.occurrence);
        attributes.set(`${node.id}.${rule.target.attr}`, value);
        const label = `${node.symbol}.${rule.target.attr}`;
        attributeList = [...attributeList, { node: node.id, label, value }];
        const substituted = sddFormatExpr(rule.expr, (ref) => sddShowValue(read(ref)));
        did.push(
          substituted === String(value)
            ? `${rule.text}, so ${label} = ${String(value)}`
            : `${rule.text}, which is ${substituted} = ${String(value)}`,
        );
      } else {
        const text = sddEffectText(rule.expr, read) as string;
        output = [...output, text];
        did.push(
          rule.expr.kind === 'call' && rule.expr.name === 'print'
            ? `It prints ${text}`
            : `It does ${text}`,
        );
      }
    }
    return did.length > 0 ? `${did.join('. ')}.` : 'It has nothing to do.';
  };

  const fire = (
    host: SddTreeNode,
    production: SddProduction,
    block: SddActionBlock,
    how: string,
  ): void => {
    const action = actionIdOf(production, block);
    fired.push(action);
    const did = execute(host, production, block);
    add(`Action: { ${block.text} }`, `${how} ${did}`, 'action', {
      production: production.index,
      node: host.id,
      action,
    });
  };

  if (mode === 'top-down') stack.push(spec.start);
  add(
    'Start',
    mode === 'bottom-up'
      ? `The ${mode} parser starts with an empty stack and reads the input left to right. It builds the tree from its leaves, so each action fires when the symbols to its left are on the stack.`
      : `The ${mode} parser starts with ${spec.start} on the stack. Each production's body is pushed with its actions in place, so an action fires when it reaches the top of the stack.`,
    'start',
  );

  if (mode === 'bottom-up') {
    const walk = (nodeId: number): void => {
      const node = nodes[nodeId] as SddTreeNode;
      const production = spec.productions[node.production as number] as SddProduction;
      const children = sddBodyChildren(nodes, node);
      const base = stack.length;
      for (let index = 0; index <= production.body.length; index++) {
        const atEnd = index === production.body.length;
        if (!atEnd) {
          for (const block of production.actions.filter((item) => item.position === index)) {
            const action = actions[actionIdOf(production, block)] as SdtActionInfo;
            stack.push(action.marker as string);
            fire(
              node,
              production,
              block,
              `The parser reduces the marker ${action.marker} → ε, because everything left of this action in ${production.text} has been recognized. That fires the action.`,
            );
          }
          const child = nodes[children[index] as number] as SddTreeNode;
          if (child.kind === 'terminal') {
            stack.push(child.symbol);
            consumed++;
            add(
              `Shift ${child.lexeme}`,
              `The next token is ${child.lexeme}, so the parser shifts it onto the stack as ${child.symbol}.`,
              'shift',
              { production: production.index, node: child.id },
            );
          } else {
            walk(child.id);
          }
        }
      }
      for (const block of production.actions.filter(
        (item) => item.position === production.body.length,
      )) {
        fire(
          node,
          production,
          block,
          `The body of ${production.text} is complete on top of the stack, so the parser is about to reduce. This action sits at the end of the production, so it fires now.`,
        );
      }
      stack.length = base;
      stack.push(node.symbol);
      add(
        `Reduce by ${production.text}`,
        `The parser pops the body of ${production.text} and pushes ${node.symbol}.`,
        'reduce',
        { production: production.index, node: node.id },
      );
    };
    walk(tree.root);
    add(
      'Accept',
      `The input is used up and ${spec.start} is alone on the stack, so the parser accepts.`,
      'accept',
    );
  } else {
    type Entry =
      | { kind: 'symbol'; node: number }
      | { kind: 'action'; host: number; production: number; block: SddActionBlock; id: number };
    const pending: Entry[] = [{ kind: 'symbol', node: tree.root }];
    const showEntry = (entry: Entry): string => {
      if (entry.kind === 'symbol') return (nodes[entry.node] as SddTreeNode).written;
      return `{a${entry.id + 1}}`;
    };
    const syncStack = (): void => {
      stack.length = 0;
      stack.push(...pending.map(showEntry));
    };
    syncStack();
    while (pending.length > 0) {
      const entry = pending.pop() as Entry;
      syncStack();
      if (entry.kind === 'action') {
        const production = spec.productions[entry.production] as SddProduction;
        fire(
          nodes[entry.host] as SddTreeNode,
          production,
          entry.block,
          `The top of the stack was this action from ${production.text}, so it was popped and runs now.`,
        );
        continue;
      }
      const node = nodes[entry.node] as SddTreeNode;
      if (node.kind === 'terminal') {
        consumed++;
        add(
          `Match ${node.lexeme}`,
          `The top of the stack was the terminal ${node.symbol}, and the next token is ${node.lexeme}. They match, so both are removed.`,
          'match',
          { node: node.id },
        );
        continue;
      }
      const production = spec.productions[node.production as number] as SddProduction;
      const children = sddBodyChildren(nodes, node);
      const items: Entry[] = [];
      for (let index = 0; index <= production.body.length; index++) {
        for (const block of production.actions.filter((item) => item.position === index)) {
          items.push({
            kind: 'action',
            host: node.id,
            production: production.index,
            block,
            id: actionIdOf(production, block),
          });
        }
        const child = children[index];
        if (child !== undefined) items.push({ kind: 'symbol', node: child });
      }
      pending.push(...items.reverse());
      syncStack();
      const nextText = tokens[consumed]?.text ?? 'the end of the input';
      add(
        `Expand by ${production.text}`,
        `The top of the stack was ${node.symbol}, and the next token is ${nextText}. The parser uses ${production.text}, and pushes the body with its actions, rightmost first.`,
        'expand',
        { production: production.index, node: node.id },
      );
    }
    add('Accept', 'The stack is empty and the input is used up, so the parser accepts.', 'accept');
  }

  return { ...analysis, ...tree, mode, fired, output, trace: recorder.finish() };
}
