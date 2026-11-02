import type { CourseModule } from '@compilerlab/shared';
import { Fragment, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { moduleColor } from './module-chip';

// What flows out of each stage, drawn on the transition like a label on an automaton edge.
const OUTPUT_OF_STAGE: Record<number, string> = {
  1: 'tokens',
  2: 'parse tree',
  3: 'typed tree',
  4: 'IR',
  5: 'better IR',
  6: 'code',
};

const SHORT_TITLE: Record<number, string> = {
  1: 'Lexical',
  2: 'Syntax',
  3: 'Semantic',
  4: 'IR',
  5: 'Optimize',
  6: 'Codegen',
};

function Transition({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1 pb-6">
      <span className="truncate font-mono text-[0.625rem] text-ink-muted">{label}</span>
      <svg viewBox="0 0 60 8" preserveAspectRatio="none" aria-hidden="true" className="h-2 w-full">
        <path d="M0 4h57" stroke="var(--line-strong)" strokeWidth="1.5" fill="none" />
        <path d="M53 0.5 59 4l-6 3.5z" fill="var(--line-strong)" />
      </svg>
    </div>
  );
}

function stateStyle(number: number, step: number): CSSProperties {
  return { ...moduleColor(number), '--step': step } as CSSProperties;
}

/**
 * The compiler pipeline drawn as the automaton students will meet in Module 1: a start state,
 * one state per phase, and an accepting state. Each phase links to its module.
 */
export function PhasePipeline({ modules }: { modules: readonly CourseModule[] }) {
  const stages = modules.filter((module) => module.pipelineStage);
  return (
    <div className="overflow-x-auto pb-1" role="group" aria-label="The compiler pipeline">
      <div className="flex min-w-[52rem] items-center">
        <div className="flex flex-col items-center gap-2">
          <div className="pipeline-state" style={stateStyle(0, 0)}>
            <span className="text-[0.6875rem]">src</span>
          </div>
          <span className="text-xs text-ink-muted">Source</span>
        </div>
        <Transition label="characters" />
        {stages.map((stage, index) => (
          <Fragment key={stage.id}>
            <Link
              to={`/learn/${stage.id}`}
              className="pipeline-link flex flex-col items-center gap-2 rounded-md"
            >
              <div
                aria-hidden="true"
                className="pipeline-state"
                style={stateStyle(stage.number, index + 1)}
              >
                {stage.number}
              </div>
              <span className="text-xs font-medium">
                {SHORT_TITLE[stage.number] ?? stage.title}
              </span>
              <span className="sr-only">
                , Module {stage.number}: {stage.title}
              </span>
            </Link>
            <Transition label={OUTPUT_OF_STAGE[stage.number] ?? ''} />
          </Fragment>
        ))}
        <div className="flex flex-col items-center gap-2">
          <div
            className="pipeline-state"
            data-accepting="true"
            style={stateStyle(0, stages.length + 1)}
          >
            <span className="sr-only">Accepting state</span>
          </div>
          <span className="text-xs text-ink-muted">Target</span>
        </div>
      </div>
    </div>
  );
}
