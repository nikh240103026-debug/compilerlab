import type { TacInstr } from '../ir/types';
import { OPT_EXIT, optBuildCfg, type OptBlock, type OptCfg } from './cfg';
import type { DataflowDefinition } from './dataflow-facts';
import { optSolveLive, optSolveReaching } from './dataflow';
import { optFindLoops, type LoopAnalysis, type LoopNatural } from './loops';
import { OptPassRun, type OptPassResult } from './pass-core';
import { optInsertIntoPreheader, type PreheaderStatement } from './preheader';
import {
  optDefOf,
  optDefaultLiveAtExit,
  optHasNoEffect,
  optOperandsOf,
  optToInstrs,
} from './tac-util';

export interface OptLicmOptions {
  /** Names read after this code ends. Defaults to every non-temporary name, as the book assumes. */
  liveAtExit?: readonly string[];
}

interface Statement {
  index: number;
  block: OptBlock;
  offset: number;
  instr: TacInstr;
}

/**
 * Array reads stay put: a store in the loop could change the value, and in a loop that runs zero
 * times the hoisted read could fail with a bounds error that the original never had. Division by
 * an unknown divisor stays for the same reason, which optHasNoEffect already covers.
 */
function canMove(instr: TacInstr): boolean {
  if (instr.op !== 'assign' && instr.op !== 'binary' && instr.op !== 'unary') return false;
  return optHasNoEffect(instr);
}

function loopStatements(cfg: OptCfg, loop: LoopNatural): Statement[] {
  const inLoop = new Set(loop.blocks);
  const statements: Statement[] = [];
  for (const block of cfg.blocks) {
    if (!inLoop.has(block.id)) continue;
    block.instrs.forEach((instr, offset) => {
      statements.push({ index: block.start + offset, block, offset, instr });
    });
  }
  return statements;
}

/** The definitions of `name` that may reach a statement, by walking its block from IN. */
function reachingDefsOf(
  statement: Statement,
  name: string,
  definitions: readonly DataflowDefinition[],
  blockIn: ReadonlySet<string>,
): DataflowDefinition[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  let reaching = [...blockIn]
    .map((id) => byId.get(id) as DataflowDefinition)
    .filter((definition) => definition.name === name);
  for (let offset = 0; offset < statement.offset; offset++) {
    const index = statement.block.start + offset;
    const earlier = statement.block.instrs[offset] as TacInstr;
    if (optDefOf(earlier) === name) {
      reaching = definitions.filter((definition) => definition.index === index);
    }
  }
  return reaching;
}

/** Hoists what it can from one loop. Returns true if the program changed. */
function hoistFromLoop(
  run: OptPassRun,
  cfg: OptCfg,
  analysis: LoopAnalysis,
  loop: LoopNatural,
  liveAtExit: readonly string[],
): boolean {
  const { definitions, solution } = optSolveReaching(cfg);
  const live = optSolveLive(cfg, liveAtExit);
  const statements = loopStatements(cfg, loop);
  const loopIndexes = new Set(statements.map((statement) => statement.index));

  // Step 1: mark invariant statements, repeating because one can enable the next.
  const invariant = new Set<number>();
  const order: Statement[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const statement of statements) {
      if (invariant.has(statement.index) || !canMove(statement.instr)) continue;
      const operandsInvariant = optOperandsOf(statement.instr).every((operand) => {
        if (operand.kind === 'const') return true;
        const reaching = reachingDefsOf(
          statement,
          operand.name,
          definitions,
          solution.in.get(statement.block.id) as Set<string>,
        );
        const fromInside = reaching.filter((definition) => loopIndexes.has(definition.index));
        if (fromInside.length === 0) return true;
        return reaching.length === 1 && invariant.has((fromInside[0] as DataflowDefinition).index);
      });
      if (operandsInvariant) {
        invariant.add(statement.index);
        order.push(statement);
        grew = true;
      }
    }
  }

  // Step 2: an invariant statement also has to be safe to move.
  const moved = new Set<number>();
  const hoisted: PreheaderStatement[] = [];
  const headerLiveIn = live.in.get(loop.header) as Set<string>;
  for (const statement of order) {
    const dest = optDefOf(statement.instr) as string;
    const definedOnce = statements.filter((other) => optDefOf(other.instr) === dest).length === 1;
    if (!definedOnce || headerLiveIn.has(dest)) continue;

    // An operand defined inside the loop must have moved first, or this would read it too early.
    const operandsReady = optOperandsOf(statement.instr).every((operand) => {
      if (operand.kind === 'const') return true;
      return reachingDefsOf(
        statement,
        operand.name,
        definitions,
        solution.in.get(statement.block.id) as Set<string>,
      ).every((definition) => !loopIndexes.has(definition.index) || moved.has(definition.index));
    });
    if (!operandsReady) continue;

    const doms = analysis.dominators;
    const dominatesExits = loop.exits.every(({ from }) =>
      (doms[from] as string[]).includes(statement.block.id),
    );
    const deadAtExits = loop.exits.every(({ to }) => {
      const liveThere = to === OPT_EXIT ? new Set(liveAtExit) : (live.in.get(to) as Set<string>);
      return !liveThere.has(dest);
    });
    if (!dominatesExits && !deadAtExits) continue;

    moved.add(statement.index);
    hoisted.push({
      instr: statement.instr,
      reason: `Its operands get the same values on every trip around the loop, and ${dest} has no other definition in the loop and is not read before this line, so it only needs to run once, before the loop. ${dominatesExits ? 'Its block runs on every path out of the loop.' : `It is safe even if the loop runs zero times, because ${dest} is not needed after the loop.`}`,
    });
  }

  if (hoisted.length === 0) return false;

  // Remove first and insert after, using a flow graph that matches the shortened code.
  for (const index of [...moved].toSorted((a, b) => b - a)) {
    run.remove(index, 'This loop-invariant line moves to the preheader, in front of the loop.');
  }
  const shortened = optBuildCfg(run.instrs);
  const again = optFindLoops(shortened);
  const same = again.loops.find((candidate) => {
    const firstOld = (cfg.blocks.find((block) => block.id === loop.header) as OptBlock).instrs[0];
    const firstNew = (shortened.blocks.find((block) => block.id === candidate.header) as OptBlock)
      .instrs[0];
    return firstOld?.op === 'label' && firstNew?.op === 'label' && firstOld.name === firstNew.name;
  }) as LoopNatural;
  optInsertIntoPreheader(run, shortened, same, hoisted);
  return true;
}

function headerLabelOf(cfg: OptCfg, loop: LoopNatural): string {
  const first = (cfg.blocks.find((block) => block.id === loop.header) as OptBlock).instrs[0];
  return first?.op === 'label' ? first.name : loop.header;
}

/** Moves computations that give the same result on every trip out in front of the loop. */
export function optLoopInvariantMotion(
  input: string | readonly TacInstr[],
  options: OptLicmOptions = {},
): OptPassResult {
  const instrs = optToInstrs(input);
  const liveAtExit = options.liveAtExit ?? optDefaultLiveAtExit(instrs);
  const run = new OptPassRun(
    'licm',
    instrs,
    'A statement is loop-invariant if its operands are constants, are defined only outside the loop, or come from one invariant statement. Moving it in front of the loop means it runs once rather than on every trip.',
  );

  // Inner loops first, so a value hoisted out of an inner loop can then leave the outer one.
  const done = new Set<string>();
  // Loop headers are never removed, so the number of loops bounds this. The limit is a backstop.
  for (let round = 0; round < 200; round++) {
    const cfg = optBuildCfg(run.instrs);
    const analysis = optFindLoops(cfg);
    const next = analysis.loops
      .filter((loop) => !done.has(headerLabelOf(cfg, loop)))
      .toSorted((a, b) => a.blocks.length - b.blocks.length)[0];
    if (!next) break;
    done.add(headerLabelOf(cfg, next));
    hoistFromLoop(run, cfg, analysis, next, liveAtExit);
  }
  return run.finish('No loop has a statement that is invariant and safe to move.');
}
