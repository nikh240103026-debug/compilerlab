// Everything the visualizers ask the engine to do. Runs inside the Web Worker, so a slow input
// never blocks the page, and takes only plain data, so it can cross the worker boundary.
import {
  attempt,
  buildLexer,
  dfaEquivalent,
  minimizeDfa,
  parseLexSpec,
  parseRegex,
  regexToDfaDirect,
  simulateDfa,
  simulateNfa,
  subsetConstruct,
  thompson,
  traceInputBuffer,
  traceTokenize,
  type Dfa,
  type DirectResult,
  type EquivalenceResult,
  type InputBufferResult,
  type LexRule,
  type LexWarning,
  type MinimizeState,
  type Nfa,
  type Result,
  type SimulationResult,
  type SubsetResult,
  type ThompsonResult,
  type Trace,
  type TracedScanResult,
} from '@compilerlab/engine';

import { assessmentHandlers, type AssessmentJobTypes } from '../../assessment/jobs';
import { parsingHandlers, type ParsingJobTypes } from '../parsing/jobs';
import { semanticHandlers, type SemanticJobTypes } from '../semantic/jobs';

export type Machine = 'nfa' | 'dfa' | 'minimal';

export interface JobTypes extends ParsingJobTypes, SemanticJobTypes, AssessmentJobTypes {
  thompson: { input: { regex: string }; output: ThompsonResult };
  subset: { input: { regex: string }; output: SubsetResult & { nfa: Nfa } };
  minimize: {
    input: { regex: string };
    output: { source: Dfa; minimal: Dfa; trace: Trace<MinimizeState> };
  };
  direct: { input: { regex: string }; output: DirectResult };
  run: {
    input: { regex: string; text: string; machine: Machine };
    output: { nfa: Nfa | null; dfa: Dfa | null; simulation: SimulationResult };
  };
  figure: {
    input: { regex: string; show: Machine };
    output: { nfa: Nfa | null; dfa: Dfa | null };
  };
  lexer: {
    input: { spec: string; source: string };
    output: TracedScanResult & { rules: LexRule[]; dfa: Dfa; warnings: LexWarning[] };
  };
  inputBuffer: { input: { text: string; size: number }; output: InputBufferResult };
  simulateBuilt: { input: { nfa: Nfa; text: string }; output: SimulationResult };
  compareBuilt: { input: { nfa: Nfa; regex: string }; output: EquivalenceResult };
  checkRegex: { input: { answer: string; reference: string }; output: EquivalenceResult };
}

export type JobKind = keyof JobTypes;
export type JobInput<K extends JobKind> = JobTypes[K]['input'];
export type JobOutput<K extends JobKind> = JobTypes[K]['output'];

const dfaOf = (regex: string): Dfa => subsetConstruct(thompson(parseRegex(regex)).nfa).dfa;

const handlers: { [K in JobKind]: (input: JobInput<K>) => JobOutput<K> } = {
  ...parsingHandlers,
  ...semanticHandlers,
  ...assessmentHandlers,
  thompson: ({ regex }) => thompson(parseRegex(regex), regex),
  subset: ({ regex }) => {
    const { nfa } = thompson(parseRegex(regex), regex);
    return { nfa, ...subsetConstruct(nfa) };
  },
  minimize: ({ regex }) => {
    const source = dfaOf(regex);
    const { dfa: minimal, trace } = minimizeDfa(source);
    return { source, minimal, trace };
  },
  direct: ({ regex }) => regexToDfaDirect(parseRegex(regex)),
  run: ({ regex, text, machine }) => {
    if (machine === 'nfa') {
      const { nfa } = thompson(parseRegex(regex), regex);
      return { nfa, dfa: null, simulation: simulateNfa(nfa, text) };
    }
    const built = dfaOf(regex);
    const dfa = machine === 'dfa' ? built : minimizeDfa(built).dfa;
    return { nfa: null, dfa, simulation: simulateDfa(dfa, text) };
  },
  figure: ({ regex, show }) => {
    if (show === 'nfa') return { nfa: thompson(parseRegex(regex), regex).nfa, dfa: null };
    const built = dfaOf(regex);
    return { nfa: null, dfa: show === 'dfa' ? built : minimizeDfa(built).dfa };
  },
  lexer: ({ spec, source }) => {
    const rules = parseLexSpec(spec);
    const lexer = buildLexer(rules);
    return { ...traceTokenize(lexer, source), rules, dfa: lexer.dfa, warnings: lexer.warnings };
  },
  inputBuffer: ({ text, size }) => traceInputBuffer(text, size),
  simulateBuilt: ({ nfa, text }) => simulateNfa(nfa, text),
  compareBuilt: ({ nfa, regex }) => {
    const built = subsetConstruct(nfa).dfa;
    return dfaEquivalent(built, dfaOf(regex));
  },
  checkRegex: ({ answer, reference }) => dfaEquivalent(dfaOf(answer), dfaOf(reference)),
};

/** Never throws. Bad input and engine bugs alike come back as a readable failure. */
export function runJob<K extends JobKind>(kind: K, input: JobInput<K>): Result<JobOutput<K>> {
  try {
    return attempt(() => (handlers[kind] as (input: JobInput<K>) => JobOutput<K>)(input));
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'The engine hit an unexpected problem with this input.',
        hint: 'Try a simpler input. If it keeps happening, this is a bug in CompilerLab.',
      },
    };
  }
}
