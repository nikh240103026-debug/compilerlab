import { formatTac, type TacInstr } from '../ir/types';
import type { OptCfg } from './cfg';
import { optDefOf, optExprKey, optExprOperands, optTouchesMemory, optUsesOf } from './tac-util';

// The per-block summaries each analysis starts from: gen and kill for reaching definitions and
// available expressions, use and def for live variables.

export interface BlockFacts {
  gen: Set<string>;
  kill: Set<string>;
}

export interface DataflowDefinition {
  /** d1, d2, ... numbered in program order, as the book does. */
  id: string;
  name: string;
  block: string;
  /** Index in the program. */
  index: number;
  text: string;
}

export function collectDefinitions(cfg: OptCfg): DataflowDefinition[] {
  const definitions: DataflowDefinition[] = [];
  for (const block of cfg.blocks) {
    block.instrs.forEach((instr, offset) => {
      const name = optDefOf(instr);
      if (name === null) return;
      definitions.push({
        id: `d${definitions.length + 1}`,
        name,
        block: block.id,
        index: block.start + offset,
        text: formatTac(instr),
      });
    });
  }
  return definitions;
}

/** gen is the definitions that survive to the block's end. kill is every rival definition. */
export function reachingFacts(
  cfg: OptCfg,
  definitions: readonly DataflowDefinition[],
): Map<string, BlockFacts> {
  const facts = new Map<string, BlockFacts>();
  for (const block of cfg.blocks) {
    const gen = new Set<string>();
    const kill = new Set<string>();
    for (const definition of definitions) {
      if (definition.block !== block.id) continue;
      for (const other of definitions) {
        if (other.name === definition.name) {
          if (other.id !== definition.id) {
            kill.add(other.id);
            gen.delete(other.id);
          }
        }
      }
      gen.add(definition.id);
    }
    facts.set(block.id, { gen, kill });
  }
  return facts;
}

/** gen holds upward-exposed uses (use[B]), kill holds names defined before any use (def[B]). */
export function liveFacts(cfg: OptCfg): Map<string, BlockFacts> {
  const facts = new Map<string, BlockFacts>();
  for (const block of cfg.blocks) {
    const use = new Set<string>();
    const def = new Set<string>();
    for (const instr of block.instrs) {
      for (const name of optUsesOf(instr)) {
        if (!def.has(name)) use.add(name);
      }
      const name = optDefOf(instr);
      if (name !== null && !use.has(name)) def.add(name);
    }
    facts.set(block.id, { gen: use, kill: def });
  }
  return facts;
}

export interface ExpressionInfo {
  key: string;
  operands: string[];
  isLoad: boolean;
}

export function collectExpressions(cfg: OptCfg): Map<string, ExpressionInfo> {
  const expressions = new Map<string, ExpressionInfo>();
  for (const block of cfg.blocks) {
    for (const instr of block.instrs) {
      const key = optExprKey(instr);
      if (key !== null && !expressions.has(key)) {
        expressions.set(key, {
          key,
          operands: optExprOperands(instr),
          isLoad: instr.op === 'load',
        });
      }
    }
  }
  return expressions;
}

/** What an instruction invalidates, in the book's order: the new value is added, then killed. */
export function expressionsKilledBy(
  instr: TacInstr,
  expressions: ReadonlyMap<string, ExpressionInfo>,
): string[] {
  const def = optDefOf(instr);
  const memory = optTouchesMemory(instr);
  const killed: string[] = [];
  for (const expression of expressions.values()) {
    const staleOperand = def !== null && expression.operands.includes(def);
    if (staleOperand || (memory && expression.isLoad)) killed.push(expression.key);
  }
  return killed;
}

export function availableFacts(
  cfg: OptCfg,
  expressions: ReadonlyMap<string, ExpressionInfo>,
): Map<string, BlockFacts> {
  const facts = new Map<string, BlockFacts>();
  for (const block of cfg.blocks) {
    const gen = new Set<string>();
    const kill = new Set<string>();
    for (const instr of block.instrs) {
      const key = optExprKey(instr);
      if (key !== null) gen.add(key);
      for (const killed of expressionsKilledBy(instr, expressions)) {
        gen.delete(killed);
        kill.add(killed);
      }
    }
    facts.set(block.id, { gen, kill });
  }
  return facts;
}
