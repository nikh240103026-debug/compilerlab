import { formatTac } from '../ir/types';
import type { OptPassName } from '../optimize/pass-core';
import { optRunPipeline, type OptPipelineResult } from '../optimize/pipeline';
import { MAX_TAC_LINES } from '../optimize/tac-text';
import type { TinyIr, TinyIrFunction } from './ir';

export interface TinyOptimizeOptions {
  /** Passes to switch on or off. Anything not listed stays on. */
  toggles?: Partial<Record<OptPassName, boolean>>;
}

export interface TinyOptimizedFunction extends TinyIrFunction {
  /** Full detail of each pass. Null when this function was too long to optimize. */
  pipeline: OptPipelineResult | null;
}

export interface TinyOptimized {
  functions: TinyOptimizedFunction[];
}

/**
 * Stage 5: runs the optimizer over each function on its own. Nothing outlives a TinyC function's
 * frame, so no variable is live at its end. Only return values, prints and array writes matter.
 */
export function tinycOptimize(ir: TinyIr, options: TinyOptimizeOptions = {}): TinyOptimized {
  return {
    functions: ir.functions.map((fn) => {
      // Huge generated functions still compile and run. They just skip this stage.
      if (fn.instrs.length > MAX_TAC_LINES) return { ...fn, pipeline: null };
      const pipeline = optRunPipeline(fn.instrs, {
        ...(options.toggles ? { toggles: options.toggles } : {}),
        liveAtExit: [],
      });
      return {
        ...fn,
        instrs: pipeline.instrs,
        spans: [],
        text: pipeline.instrs.map(formatTac),
        pipeline,
      };
    }),
  };
}
