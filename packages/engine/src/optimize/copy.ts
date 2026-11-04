import type { TacInstr, TacOperand } from '../ir/types';
import { optBuildCfg, type OptCfg } from './cfg';
import type { BlockFacts } from './dataflow-facts';
import { solveDataflow } from './dataflow-solver';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optDefOf, optMapOperands, optToInstrs } from './tac-util';

// Available copies: a copy u = v still holds at a point if every path there runs it and then
// changes neither u nor v. That is a forward analysis with intersection as the meet.

interface CopyFact {
  key: string;
  dest: string;
  src: TacOperand & { name: string };
}

function copyOf(instr: TacInstr): CopyFact | null {
  if (instr.op !== 'assign' || instr.src.kind === 'const' || instr.src.name === instr.dest) {
    return null;
  }
  return { key: `${instr.dest}=${instr.src.name}`, dest: instr.dest, src: instr.src };
}

function collectCopies(cfg: OptCfg): Map<string, CopyFact> {
  const copies = new Map<string, CopyFact>();
  for (const block of cfg.blocks) {
    for (const instr of block.instrs) {
      const copy = copyOf(instr);
      if (copy) copies.set(copy.key, copy);
    }
  }
  return copies;
}

function killedBy(def: string, copies: ReadonlyMap<string, CopyFact>): string[] {
  const killed: string[] = [];
  for (const copy of copies.values()) {
    if (copy.dest === def || copy.src.name === def) killed.push(copy.key);
  }
  return killed;
}

/** One round over the program. Returns true if anything changed, so chains can be followed. */
function propagateOnce(run: OptPassRun): boolean {
  const cfg = optBuildCfg(run.instrs);
  const copies = collectCopies(cfg);
  if (copies.size === 0) return false;

  const facts = new Map<string, BlockFacts>();
  for (const block of cfg.blocks) {
    const gen = new Set<string>();
    const kill = new Set<string>();
    for (const instr of block.instrs) {
      const def = optDefOf(instr);
      if (def !== null) {
        for (const key of killedBy(def, copies)) {
          gen.delete(key);
          kill.add(key);
        }
      }
      const copy = copyOf(instr);
      if (copy) gen.add(copy.key);
    }
    facts.set(block.id, { gen, kill });
  }

  const solution = solveDataflow(
    cfg,
    {
      direction: 'forward',
      meet: 'intersection',
      facts,
      boundary: new Set(),
      initial: new Set(copies.keys()),
      genName: 'gen',
      killName: 'kill',
    },
    null,
  );

  let changed = false;
  for (const block of cfg.blocks) {
    const available = new Set(solution.in.get(block.id) as Set<string>);
    block.instrs.forEach((original, offset) => {
      const index = block.start + offset;
      const replaced: string[] = [];
      const rewritten = optMapOperands(original, (operand) => {
        if (operand.kind === 'const') return operand;
        for (const key of available) {
          const copy = copies.get(key) as CopyFact;
          if (copy.dest === operand.name) {
            replaced.push(`${operand.name} is a copy of ${copy.src.name}`);
            return copy.src;
          }
        }
        return operand;
      });
      if (replaced.length > 0) {
        changed = true;
        run.replace(
          index,
          rewritten,
          `${[...new Set(replaced)].join(' and ')} on every path to this line, and neither has changed since, so the original can be used directly. The copy may become dead.`,
        );
      }

      // Update with the original instruction: rewriting operands does not change what it defines.
      const def = optDefOf(original);
      if (def !== null) {
        for (const key of killedBy(def, copies)) available.delete(key);
      }
      const copy = copyOf(original);
      if (copy) available.add(copy.key);
    });
  }
  return changed;
}

/** Replaces uses of u with v wherever the copy u = v is sure to hold. */
export function optCopyPropagation(input: string | readonly TacInstr[]): OptPassResult {
  const run = new OptPassRun(
    'copy-propagation',
    optToInstrs(input),
    'After a copy u = v, later reads of u can read v instead, as long as neither has changed on any path in between. This does not remove the copy. It makes the copy dead, so dead code elimination can.',
  );
  // Each round follows a copy of a copy one link further. Twenty links is far past any real chain.
  for (let round = 0; round < 20; round++) {
    if (!propagateOnce(run)) break;
  }
  return run.finish('No copy reaches a place where its destination is read.');
}
