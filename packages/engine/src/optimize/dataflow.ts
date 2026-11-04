import { EngineError } from '../core/result';
import { TraceRecorder, type Trace } from '../core/trace';
import type { TacInstr } from '../ir/types';
import { optBuildCfg, type OptCfg } from './cfg';
import {
  availableFacts,
  collectDefinitions,
  collectExpressions,
  liveFacts,
  reachingFacts,
  type BlockFacts,
  type DataflowDefinition,
} from './dataflow-facts';
import {
  solveDataflow,
  sortFacts,
  type DataflowDirection,
  type DataflowMeet,
  type DataflowStepState,
  type SolverProblem,
  type SolverSolution,
} from './dataflow-solver';
import { optToInstrs } from './tac-util';

export type { DataflowDefinition } from './dataflow-facts';
export type {
  DataflowDirection,
  DataflowMeet,
  DataflowSets,
  DataflowStepState,
} from './dataflow-solver';

export type DataflowAnalysis = 'reaching-definitions' | 'live-variables' | 'available-expressions';

/** A trace copies every set at every step, so these keep a snapshot from growing out of hand. */
export const MAX_DATAFLOW_BLOCKS = 150;
export const MAX_DATAFLOW_FACTS = 400;

export interface DataflowBlockResult {
  id: string;
  text: string[];
  preds: string[];
  succs: string[];
  /** gen[B] (use[B] for live variables). */
  gen: string[];
  /** kill[B] (def[B] for live variables). */
  kill: string[];
  in: string[];
  out: string[];
}

export interface DataflowResult {
  analysis: DataflowAnalysis;
  direction: DataflowDirection;
  meet: DataflowMeet;
  /** The textbook equations for this analysis, ready to display. */
  equations: string[];
  /** What the generic gen and kill columns are called for this analysis. */
  genName: string;
  killName: string;
  blocks: DataflowBlockResult[];
  edges: { from: string; to: string }[];
  /** Every fact that could appear in a set. */
  universe: string[];
  /** Numbered definitions. Only reaching definitions fills this. */
  definitions: DataflowDefinition[];
  iterations: number;
  trace: Trace<DataflowStepState>;
}

function checkSize(cfg: OptCfg, universeSize: number): void {
  if (cfg.blocks.length > MAX_DATAFLOW_BLOCKS) {
    throw new EngineError({
      code: 'dataflow_too_big',
      message: `This code has ${cfg.blocks.length} blocks, more than the ${MAX_DATAFLOW_BLOCKS} this solver can animate.`,
      hint: 'Try a shorter program.',
    });
  }
  if (universeSize > MAX_DATAFLOW_FACTS) {
    throw new EngineError({
      code: 'dataflow_too_big',
      message: `This analysis would track ${universeSize} facts, more than the ${MAX_DATAFLOW_FACTS} this solver can animate.`,
      hint: 'Try a shorter program.',
    });
  }
}

function buildResult(
  analysis: DataflowAnalysis,
  equations: string[],
  cfg: OptCfg,
  problem: SolverProblem,
  universe: readonly string[],
  definitions: DataflowDefinition[],
): DataflowResult {
  checkSize(cfg, universe.length);
  const recorder = new TraceRecorder<DataflowStepState>();
  const solution = solveDataflow(cfg, problem, recorder);
  return {
    analysis,
    direction: problem.direction,
    meet: problem.meet,
    equations,
    genName: problem.genName,
    killName: problem.killName,
    blocks: cfg.blocks.map((block) => {
      const facts = problem.facts.get(block.id) as BlockFacts;
      return {
        id: block.id,
        text: block.text,
        preds: block.preds,
        succs: block.succs,
        gen: sortFacts(facts.gen),
        kill: sortFacts(facts.kill),
        in: sortFacts(solution.in.get(block.id) as Set<string>),
        out: sortFacts(solution.out.get(block.id) as Set<string>),
      };
    }),
    edges: cfg.edges,
    universe: sortFacts(universe),
    definitions,
    iterations: solution.iterations,
    trace: recorder.finish(),
  };
}

function reachingProblem(cfg: OptCfg, definitions: readonly DataflowDefinition[]): SolverProblem {
  return {
    direction: 'forward',
    meet: 'union',
    facts: reachingFacts(cfg, definitions),
    boundary: new Set(),
    initial: new Set(),
    genName: 'gen',
    killName: 'kill',
  };
}

function liveProblem(cfg: OptCfg, liveAtExit: readonly string[]): SolverProblem {
  return {
    direction: 'backward',
    meet: 'union',
    facts: liveFacts(cfg),
    boundary: new Set(liveAtExit),
    initial: new Set(),
    genName: 'use',
    killName: 'def',
  };
}

function availableProblem(cfg: OptCfg): { problem: SolverProblem; universe: string[] } {
  const expressions = collectExpressions(cfg);
  const universe = [...expressions.keys()];
  return {
    universe,
    problem: {
      direction: 'forward',
      meet: 'intersection',
      facts: availableFacts(cfg, expressions),
      boundary: new Set(),
      initial: new Set(universe),
      genName: 'e_gen',
      killName: 'e_kill',
    },
  };
}

/** Which definitions may reach each block. Forward, union, starts empty. */
export function dataflowReachingDefinitions(input: string | readonly TacInstr[]): DataflowResult {
  const cfg = optBuildCfg(optToInstrs(input));
  const definitions = collectDefinitions(cfg);
  return buildResult(
    'reaching-definitions',
    [
      'OUT[ENTRY] = ∅',
      'IN[B] = ∪ OUT[P], over predecessors P of B',
      'OUT[B] = gen[B] ∪ (IN[B] − kill[B])',
    ],
    cfg,
    reachingProblem(cfg, definitions),
    definitions.map((definition) => definition.id),
    definitions,
  );
}

/**
 * Which names may be read later. Backward, union, starts empty. By the book's equations
 * IN[EXIT] is empty. Pass liveAtExit when variables are read after this code.
 */
export function dataflowLiveVariables(
  input: string | readonly TacInstr[],
  options: { liveAtExit?: readonly string[] } = {},
): DataflowResult {
  const cfg = optBuildCfg(optToInstrs(input));
  const problem = liveProblem(cfg, options.liveAtExit ?? []);
  const universe = new Set<string>(options.liveAtExit ?? []);
  for (const facts of problem.facts.values()) {
    for (const name of facts.gen) universe.add(name);
    for (const name of facts.kill) universe.add(name);
  }
  return buildResult(
    'live-variables',
    [
      'IN[EXIT] = ∅',
      'OUT[B] = ∪ IN[S], over successors S of B',
      'IN[B] = use[B] ∪ (OUT[B] − def[B])',
    ],
    cfg,
    problem,
    [...universe],
    [],
  );
}

/** Which expressions are already computed, and still valid, on every path here. */
export function dataflowAvailableExpressions(input: string | readonly TacInstr[]): DataflowResult {
  const cfg = optBuildCfg(optToInstrs(input));
  const { problem, universe } = availableProblem(cfg);
  return buildResult(
    'available-expressions',
    [
      'OUT[ENTRY] = ∅',
      'IN[B] = ∩ OUT[P], over predecessors P of B',
      'OUT[B] = e_gen[B] ∪ (IN[B] − e_kill[B])',
      'Starting value: OUT[B] = U, every expression',
    ],
    cfg,
    problem,
    universe,
    [],
  );
}

// The passes need these answers but not a trace, so they skip the size limits and the recorder.

export function optSolveLive(cfg: OptCfg, liveAtExit: readonly string[]): SolverSolution {
  return solveDataflow(cfg, liveProblem(cfg, liveAtExit), null);
}

export function optSolveAvailable(cfg: OptCfg): SolverSolution {
  return solveDataflow(cfg, availableProblem(cfg).problem, null);
}

export function optSolveReaching(cfg: OptCfg): {
  definitions: DataflowDefinition[];
  solution: SolverSolution;
} {
  const definitions = collectDefinitions(cfg);
  return { definitions, solution: solveDataflow(cfg, reachingProblem(cfg, definitions), null) };
}
