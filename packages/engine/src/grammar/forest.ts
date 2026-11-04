import { EngineError } from '../core/result';
import type { GrammarParseNode, GrammarParseNodeKind, GrammarParseTree } from './types';

export const MAX_TREE_NODES = 20_000;

type DraftNode = {
  -readonly [K in keyof GrammarParseNode]: GrammarParseNode[K];
};

/** Collects parse tree nodes while a parser runs. Nothing here reaches a trace until it finishes. */
export class ForestBuilder {
  private readonly nodes: DraftNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  add(
    symbol: string,
    kind: GrammarParseNodeKind,
    fields: { parent?: number | null; token?: number | null } = {},
  ): number {
    if (this.nodes.length >= MAX_TREE_NODES) {
      throw new EngineError({
        code: 'tree_too_large',
        message: `This parse tree would have over ${MAX_TREE_NODES} nodes.`,
        hint: 'Try a shorter sentence.',
      });
    }
    const id = this.nodes.length;
    this.nodes.push({
      id,
      symbol,
      kind,
      production: null,
      children: [],
      parent: fields.parent ?? null,
      token: fields.token ?? null,
    });
    return id;
  }

  /** Makes `children` the children of `parent`, keeping their order. */
  adopt(parent: number, production: number | null, children: readonly number[]): void {
    const node = this.nodes[parent] as DraftNode;
    node.production = production;
    node.children = [...children];
    for (const child of children) (this.nodes[child] as DraftNode).parent = parent;
  }

  setKind(id: number, kind: GrammarParseNodeKind): void {
    (this.nodes[id] as DraftNode).kind = kind;
  }

  setToken(id: number, token: number): void {
    (this.nodes[id] as DraftNode).token = token;
  }

  finish(): readonly GrammarParseNode[] {
    return this.nodes;
  }
}

/**
 * The nodes that have no parent yet at this point of a run. A finished parse has one, and a
 * bottom-up parser partway through has one per stack entry.
 */
export function grammarForestRoots(
  nodes: readonly GrammarParseNode[],
  nodeCount: number = nodes.length,
): number[] {
  const roots: number[] = [];
  for (let id = 0; id < nodeCount && id < nodes.length; id++) {
    const { parent } = nodes[id] as GrammarParseNode;
    if (parent === null || parent >= nodeCount) roots.push(id);
  }
  return roots;
}

/** The terminals of a tree, left to right. */
export function grammarTreeYield(tree: GrammarParseTree): string[] {
  const out: string[] = [];
  const visit = (id: number) => {
    const node = tree.nodes[id] as GrammarParseNode;
    if (node.kind === 'terminal') out.push(node.symbol);
    for (const child of node.children) visit(child);
  };
  visit(tree.root);
  return out;
}
