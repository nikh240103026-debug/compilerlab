// The semantic analysis visualizers' jobs. These run in the Web Worker, as part of engine/jobs.ts.
import {
  sddAnalyze,
  sddEvaluate,
  sdtAnalyze,
  sdtRun,
  symtabCompare,
  symtabOperationsFromBlocks,
  symtabParseScript,
  symtabRun,
  tcCheck,
  typeInfer,
  type SddAnalysis,
  type SddEvalResult,
  type SdtAnalysis,
  type SdtMode,
  type SdtResult,
  type SymtabComparison,
  type SymtabOperation,
  type SymtabResult,
  type TcResult,
  type TypeInferenceResult,
} from '@compilerlab/engine';

export type SymtabFormat = 'blocks' | 'script';

export interface SymtabOutput {
  operations: SymtabOperation[];
  /** All three together, so switching organization is instant and stays on the same step. */
  runs: { stack: SymtabResult; hash: SymtabResult; tree: SymtabResult };
  comparison: SymtabComparison;
}

export interface SemanticJobTypes {
  sddAnalyze: { input: { spec: string }; output: SddAnalysis };
  sddEvaluate: { input: { spec: string; text: string }; output: SddEvalResult };
  sdtAnalyze: { input: { spec: string }; output: SdtAnalysis };
  sdtRun: { input: { spec: string; text: string; mode: SdtMode }; output: SdtResult };
  symtabRun: {
    input: { source: string; format: SymtabFormat; buckets: number };
    output: SymtabOutput;
  };
  tcCheck: { input: { source: string }; output: TcResult };
  typeInfer: { input: { source: string }; output: TypeInferenceResult };
}

export const semanticHandlers: {
  [K in keyof SemanticJobTypes]: (
    input: SemanticJobTypes[K]['input'],
  ) => SemanticJobTypes[K]['output'];
} = {
  sddAnalyze: ({ spec }) => sddAnalyze(spec),
  sddEvaluate: ({ spec, text }) => sddEvaluate(spec, text),
  sdtAnalyze: ({ spec }) => sdtAnalyze(spec),
  sdtRun: ({ spec, text, mode }) => sdtRun(spec, text, mode),
  symtabRun: ({ source, format, buckets }) => {
    const operations =
      format === 'script' ? symtabParseScript(source) : symtabOperationsFromBlocks(source);
    return {
      operations,
      runs: {
        stack: symtabRun('stack', operations),
        hash: symtabRun('hash', operations, { buckets }),
        tree: symtabRun('tree', operations),
      },
      comparison: symtabCompare(operations, { buckets }),
    };
  },
  tcCheck: ({ source }) => tcCheck(source),
  typeInfer: ({ source }) => typeInfer(source),
};
