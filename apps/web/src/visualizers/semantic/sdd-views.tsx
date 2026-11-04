import type {
  EngineErrorInfo,
  Result,
  SddAttrInstance,
  SddAttributeInfo,
  SddClassification,
  SddDependencyEdge,
  SddParseTree,
  SddTreeNode,
  SddValue,
} from '@compilerlab/engine';
import { TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useAiVisualizerInput } from '@/ai/context-store';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { useDebouncedValue } from '../engine/use-engine';
import { AskAiButton } from '../parsing/grammar-field';
import { JobResult } from '../shared';
import { CodeField, LineField, SourceError, type SourcePreset } from './playground';
import { shorten } from './source-view';
import { chipBox, type SyntaxNode, type SyntaxTreeLayout, type TreeBox } from './syntax-tree';

// What the two SDD visualizers share: the two input boxes, the tree, where each attribute sits on
// it, the dependency arrows, and the S-attributed and L-attributed verdict.

const SPEC_HINT =
  'One production per entry, with its rules in braces. E1 is an occurrence of E. digit and num match numbers, id matches names, and ε means empty.';

/** The definition and input boxes, with the debounce every playground uses. */
export function useSddInputs(
  initial: Readonly<Record<string, string>> | undefined,
  preset: SourcePreset,
) {
  const [spec, setSpec] = useState(initial?.spec ?? preset.text);
  const [text, setText] = useState(initial?.input ?? preset.input ?? '');
  const settledSpec = useDebouncedValue(spec, 400);
  const settledText = useDebouncedValue(text, 400);
  const input = useMemo(
    () => ({ spec: settledSpec, text: settledText }),
    [settledSpec, settledText],
  );
  useAiVisualizerInput(`Definition:\n${settledSpec}\n\nInput: ${settledText}`);
  return { spec, setSpec, text, setText, settledSpec, settledText, input };
}

export function SddInputs({
  spec,
  onSpec,
  text,
  onText,
  presets,
  specLabel = 'Syntax-directed definition',
  hint = SPEC_HINT,
}: {
  spec: string;
  onSpec: (value: string) => void;
  text: string;
  onText: (value: string) => void;
  presets: readonly SourcePreset[];
  specLabel?: string;
  hint?: string;
}) {
  return (
    <div className="@container">
      <div className="grid gap-3 @2xl:grid-cols-2">
        <CodeField
          label={specLabel}
          value={spec}
          onChange={onSpec}
          rows={7}
          hint={hint}
          presets={presets}
          onPreset={(preset) => {
            onSpec(preset.text);
            if (preset.input !== undefined) onText(preset.input);
          }}
        />
        <LineField
          label="Input"
          value={text}
          onChange={onText}
          hint="This is parsed with the definition's own grammar, so any grammar works, even a left-recursive one."
        />
      </div>
    </div>
  );
}

/** A definition's error points into the definition, and an input's error into the input. */
export function SddProblem({
  error,
  spec,
  text,
}: {
  error: EngineErrorInfo;
  spec: string;
  text: string;
}) {
  return <SourceError error={error} text={error.code.startsWith('sdd_input_') ? text : spec} />;
}

export function SddResult<T>({
  result,
  spec,
  text,
  children,
}: {
  result: Result<T> | undefined;
  spec: string;
  text: string;
  children: (value: T) => ReactNode;
}) {
  if (result && !result.ok) return <SddProblem error={result.error} spec={spec} text={text} />;
  return <JobResult result={result}>{children}</JobResult>;
}

export function sddTreeRoot(tree: Pick<SddParseTree, 'nodes' | 'root'>): SyntaxNode {
  const build = (id: number): SyntaxNode => {
    const node = tree.nodes[id] as SddTreeNode;
    const showsToken =
      node.kind === 'terminal' && node.lexeme !== null && node.lexeme !== node.symbol;
    return {
      id,
      label: showsToken ? `${node.symbol} ${node.lexeme as string}` : node.symbol,
      shape: node.kind === 'nonterminal' ? 'ellipse' : node.kind === 'terminal' ? 'box' : 'plain',
      children: node.children.map(build),
    };
  };
  return build(tree.root);
}

export interface AttrSlots {
  /** A node's attributes, in stacking order: inherited first, as the book draws them on the left. */
  byNode: ReadonlyMap<number, readonly SddAttrInstance[]>;
  /** Each attribute's place in its node's stack, by attribute id. */
  index: ReadonlyMap<number, number>;
}

const KIND_ORDER: Record<SddAttrInstance['kind'], number> = {
  inherited: 0,
  lexical: 1,
  synthesized: 2,
  undefined: 3,
  effect: 4,
};

export function attrSlots(attrs: readonly SddAttrInstance[]): AttrSlots {
  const byNode = new Map<number, SddAttrInstance[]>();
  for (const attr of attrs) byNode.set(attr.node, [...(byNode.get(attr.node) ?? []), attr]);
  const index = new Map<number, number>();
  for (const list of byNode.values()) {
    list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id);
    list.forEach((attr, place) => index.set(attr.id, place));
  }
  return { byNode, index };
}

/** A side effect's "attribute" is a made-up name, so show its rule instead. */
export function attrName(attr: SddAttrInstance): string {
  return attr.kind === 'effect' ? shorten(attr.ruleText ?? attr.label, 24) : attr.attr;
}

export function showValue(value: SddValue | null | undefined): string {
  return value === null || value === undefined ? '?' : String(value);
}

export function valueChipText(attr: SddAttrInstance, value: SddValue | null | undefined): string {
  return attr.kind === 'effect'
    ? attrName(attr)
    : `${attr.attr} = ${shorten(showValue(value), 18)}`;
}

export type ArrowTone = 'active' | 'muted' | 'removed' | 'danger' | null;

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * An arrow between two chips. Chips hang under their nodes, so an arrow leaves from a chip's side,
 * which keeps it off the node above. Chips in one column get a curve out to the right and back.
 */
export function routeChipEdge(from: TreeBox, to: TreeBox): { path: string; arrow: string } {
  const fromMiddle = from.y + from.height / 2;
  const toMiddle = to.y + to.height / 2;
  const fromCenter = from.x + from.width / 2;
  const toCenter = to.x + to.width / 2;
  let startX: number;
  let endX: number;
  let controlA: number;
  let controlB: number;
  let pointsLeft: boolean;
  if (Math.abs(fromCenter - toCenter) < (from.width + to.width) / 2) {
    const bulge = 20 + Math.abs(fromMiddle - toMiddle) * 0.12;
    startX = from.x + from.width;
    endX = to.x + to.width;
    controlA = startX + bulge;
    controlB = endX + bulge;
    pointsLeft = true;
  } else {
    const rightward = toCenter > fromCenter;
    startX = rightward ? from.x + from.width : from.x;
    endX = rightward ? to.x : to.x + to.width;
    const span = (endX - startX) / 2;
    controlA = startX + span;
    controlB = endX - span;
    pointsLeft = !rightward;
  }
  const direction = pointsLeft ? 1 : -1;
  const baseX = endX + direction * 7;
  return {
    path: `M${round(startX)},${round(fromMiddle)} C${round(controlA)},${round(fromMiddle)} ${round(controlB)},${round(toMiddle)} ${round(baseX)},${round(toMiddle)}`,
    arrow: `${round(endX)},${round(toMiddle)} ${round(baseX)},${round(toMiddle - 3.5)} ${round(baseX)},${round(toMiddle + 3.5)}`,
  };
}

const ARROW_STYLE: Record<
  Exclude<ArrowTone, null>,
  { color: string; width: number; dash?: string }
> = {
  active: { color: 'var(--accent)', width: 2.25 },
  muted: { color: 'var(--ink-muted)', width: 1.25 },
  removed: { color: 'var(--line-strong)', width: 1, dash: '3 3' },
  danger: { color: 'var(--danger)', width: 2.25 },
};

/** The dependency graph's edges, drawn over the tree. */
export function DependencyArrows({
  layout,
  attrs,
  slots,
  edges,
  toneOf,
}: {
  layout: SyntaxTreeLayout;
  attrs: readonly SddAttrInstance[];
  slots: AttrSlots;
  edges: readonly SddDependencyEdge[];
  /** Null leaves an edge out. */
  toneOf: (edge: SddDependencyEdge) => ArrowTone;
}) {
  const boxOf = (id: number) =>
    chipBox(layout, (attrs[id] as SddAttrInstance).node, slots.index.get(id) ?? 0);
  return (
    <g>
      {edges.map((edge) => {
        const tone = toneOf(edge);
        if (!tone) return null;
        const route = routeChipEdge(boxOf(edge.from), boxOf(edge.to));
        const style = ARROW_STYLE[tone];
        return (
          <g key={`${edge.from}>${edge.to}`}>
            <path
              d={route.path}
              fill="none"
              stroke={style.color}
              strokeWidth={style.width}
              strokeDasharray={style.dash}
            />
            <polygon points={route.arrow} fill={style.color} />
          </g>
        );
      })}
    </g>
  );
}

const KIND_LABELS: readonly { kind: SddAttributeInfo['kind']; label: string }[] = [
  { kind: 'synthesized', label: 'Synthesized' },
  { kind: 'inherited', label: 'Inherited' },
  { kind: 'lexical', label: 'From the lexer' },
  { kind: 'undefined', label: 'No rule defines' },
];

/** Which attributes the definition has, and what kind each one is. */
export function AttributeKinds({ attributes }: { attributes: readonly SddAttributeInfo[] }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {KIND_LABELS.map(({ kind, label }) => {
        const names = attributes
          .filter((info) => info.kind === kind)
          .map((info) => `${info.symbol}.${info.attr}`);
        return names.length > 0 ? (
          <div key={kind} className="flex flex-wrap gap-1">
            <dt className={cn('text-ink-muted', kind === 'undefined' && 'text-danger')}>
              {label}:
            </dt>
            <dd className="font-mono">{names.join(', ')}</dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}

function YesNo({ label, yes }: { label: string; yes: boolean }) {
  return (
    <Badge tone={yes ? 'success' : 'danger'}>
      {label}: {yes ? 'yes' : 'no'}
    </Badge>
  );
}

/** The verdict, with its reason, and a line for each rule saying what it allows. */
export function ClassificationPanel({
  classification,
  detailed = false,
}: {
  classification: SddClassification;
  /** Also lists every rule, for the visualizer whose subject this is. */
  detailed?: boolean;
}) {
  const { isSAttributed, isLAttributed, reason, checks, kind } = classification;
  return (
    <section aria-label="S-attributed and L-attributed" className="rounded-md bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <YesNo label="S-attributed" yes={isSAttributed} />
        <YesNo label="L-attributed" yes={isLAttributed} />
      </div>
      <p className="mt-1.5 text-sm">{reason}</p>
      {kind === 'neither' ? (
        <AskAiButton question={`Why is this definition not L-attributed? ${reason}`} />
      ) : null}
      {detailed && checks.length > 0 ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer font-medium">The reason for each rule</summary>
          <ul className="mt-1 space-y-1.5">
            {checks.map((check) => (
              <li key={`${check.production}:${check.rule}`} className="min-w-0">
                <code className="font-mono text-[0.8125rem] break-words">{check.ruleText}</code>
                <span className="text-xs text-ink-muted"> in {check.productionText}</span>
                <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                  <Badge>{check.role}</Badge>
                  <YesNo label="S" yes={check.allowedInS} />
                  <YesNo label="L" yes={check.allowedInL} />
                </span>
                <p className="text-xs text-ink-muted">{check.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function SddWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-md border border-warning p-2 text-sm">
      {warnings.map((warning) => (
        <li key={warning} className="flex gap-2">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          {warning}
        </li>
      ))}
    </ul>
  );
}

/** One cycle, as text, so the panel and an exported frame say the same thing. */
export function cycleText(cycle: readonly number[], attrs: readonly SddAttrInstance[]): string {
  const names = cycle.map((id) => (attrs[id] as SddAttrInstance).label);
  return [...names, names[0]].join(' → ');
}
