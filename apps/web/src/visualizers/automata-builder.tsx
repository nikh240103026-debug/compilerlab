import type { Nfa, SimulationState, TraceStep } from '@compilerlab/engine';
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useInternalNode,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useSettings } from '@/hooks/use-settings';
import { resolveTheme } from '@/lib/apply-settings';
import { cn } from '@/lib/cn';
import { readJson, writeJson } from '@/lib/storage';
import {
  A_OR_B,
  buildAutomaton,
  EMPTY_AUTOMATON,
  ENDS_IN_ABB,
  type BuilderAutomaton,
} from './builder-model';
import { useDebouncedValue, useEngineJob } from './engine/use-engine';
import { AutomatonGraph, mergeEdges, type GraphNode } from './graph/automaton-graph';
import { routeEdge, STATE_RADIUS, type GraphLayout, type Point } from './graph/layout';
import { Player } from './player/player';
import { InputError, JobResult, type VisualizerProps } from './shared';
import { Tape, tapeSize } from './tape';

const DRAFT_KEY = 'compilerlab.builder';
const NODE_SIZE = STATE_RADIUS * 2;

type StateData = { label: string; accepting: boolean; start: boolean; active: boolean };
type TransitionData = { label: string; hasReverse: boolean; obstacles: readonly Point[] };
type StateFlowNode = Node<StateData, 'state'>;
type TransitionFlowEdge = Edge<TransitionData, 'transition'>;

function StateNode({ data }: NodeProps<StateFlowNode>) {
  const ring = data.active ? 'border-accent' : 'border-ink-muted';
  return (
    <div
      className="relative"
      style={{ width: NODE_SIZE, height: NODE_SIZE }}
      aria-label={`State ${data.label}${data.start ? ', start' : ''}${data.accepting ? ', accepting' : ''}`}
    >
      {data.active ? (
        <div className="absolute -inset-1.5 rounded-full bg-accent opacity-25" aria-hidden="true" />
      ) : null}
      {data.start ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -left-5 -translate-y-1/2 text-base leading-none text-ink-muted"
        >
          →
        </span>
      ) : null}
      {/* The ring starts a new edge, and the middle drags the state. */}
      <div className={cn('absolute inset-0 rounded-full border-2 bg-surface', ring)} />
      <Handle
        type="source"
        position={Position.Top}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          transform: 'none',
          borderRadius: '50%',
          background: 'transparent',
          border: 'none',
        }}
      />
      <div
        className={cn(
          'state-drag absolute inset-[6px] flex cursor-grab items-center justify-center rounded-full font-mono text-xs font-semibold text-ink',
          data.accepting && cn('border-2', ring),
        )}
      >
        {data.label}
      </div>
    </div>
  );
}

function centerOf(node: InternalNode) {
  const { x, y } = node.internals.positionAbsolute;
  return {
    x: x + (node.measured.width ?? NODE_SIZE) / 2,
    y: y + (node.measured.height ?? NODE_SIZE) / 2,
  };
}

function TransitionEdge({ id, source, target, data, selected }: EdgeProps<TransitionFlowEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const route = routeEdge(
    centerOf(from),
    centerOf(to),
    data?.obstacles ?? [],
    data?.hasReverse ?? false,
  );
  const color = selected ? 'var(--accent)' : 'var(--line-strong)';
  return (
    <>
      <BaseEdge
        id={id}
        path={route.path}
        interactionWidth={24}
        style={{ stroke: color, strokeWidth: selected ? 2.25 : 1.5 }}
      />
      <polygon points={route.arrow} fill={color} />
      <text
        x={route.label.x}
        y={route.label.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fontFamily="var(--font-mono)"
        fill={selected ? 'var(--accent)' : 'var(--ink-muted)'}
        stroke="var(--surface)"
        strokeWidth={4}
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {data?.label}
      </text>
    </>
  );
}

const NODE_TYPES: NodeTypes = { state: StateNode };
const EDGE_TYPES: EdgeTypes = { transition: TransitionEdge };

function toFlowNodes(automaton: BuilderAutomaton): StateFlowNode[] {
  return automaton.states.map((state) => ({
    id: state.id,
    type: 'state',
    position: { x: state.x, y: state.y },
    dragHandle: '.state-drag',
    data: { label: state.label, accepting: state.accepting, start: false, active: false },
  }));
}

function toFlowEdges(automaton: BuilderAutomaton): TransitionFlowEdge[] {
  return automaton.transitions.map((transition) => ({
    id: transition.id,
    type: 'transition',
    source: transition.from,
    target: transition.to,
    data: { label: transition.label, hasReverse: false, obstacles: [] },
  }));
}

function loadDraft(): BuilderAutomaton | null {
  const draft = readJson<BuilderAutomaton>(DRAFT_KEY);
  return draft && Array.isArray(draft.states) && Array.isArray(draft.transitions) ? draft : null;
}

function initialAutomaton(preset: string | undefined): BuilderAutomaton {
  if (preset === 'ends-in-abb') return ENDS_IN_ABB;
  if (preset === 'a-or-b') return A_OR_B;
  return loadDraft() ?? ENDS_IN_ABB;
}

function layoutFromCanvas(automaton: BuilderAutomaton): GraphLayout {
  const xs = automaton.states.map((state) => state.x);
  const ys = automaton.states.map((state) => state.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const margin = 80;
  return {
    width: Math.max(...xs) - minX + margin * 2 + NODE_SIZE,
    height: Math.max(...ys) - minY + margin * 2 + NODE_SIZE,
    positions: new Map(
      automaton.states.map((state, index) => [
        index,
        { x: state.x - minX + margin + STATE_RADIUS, y: state.y - minY + margin + STATE_RADIUS },
      ]),
    ),
  };
}

function TestRun({
  automaton,
  nfa,
  onActive,
  onUsed,
}: {
  automaton: BuilderAutomaton;
  nfa: Nfa;
  onActive: (ids: readonly string[]) => void;
  onUsed: (() => void) | undefined;
}) {
  const [text, setText] = useState('aabb');
  const settled = useDebouncedValue(text);
  const inputId = useId();
  const { data } = useEngineJob('simulateBuilt', { nfa, text: settled });

  const layout = useMemo(() => layoutFromCanvas(automaton), [automaton]);
  const edges = useMemo(
    () =>
      mergeEdges(
        nfa.transitions.map(({ from, to, on }, index) => ({
          from,
          to,
          label: on ? (automaton.transitions[index]?.label ?? '') : 'ε',
        })),
      ),
    [nfa, automaton],
  );
  const nodesFor = useCallback(
    (state: SimulationState): GraphNode[] => {
      const lit = new Set(state.active);
      return automaton.states.map((builderState, key) => ({
        key,
        label: builderState.label,
        start: key === nfa.start,
        accepting: builderState.accepting,
        tone: lit.has(key) ? 'active' : 'idle',
      }));
    },
    [automaton, nfa],
  );

  const onStep = useCallback(
    ({ state }: TraceStep<SimulationState>) => {
      onActive(state.active.flatMap((index) => automaton.states[index]?.id ?? []));
    },
    [automaton, onActive],
  );

  useEffect(() => () => onActive([]), [onActive]);

  const renderStage = useCallback(
    ({ state }: TraceStep<SimulationState>) => <Tape state={state} />,
    [],
  );

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={inputId} className="mb-1 block text-sm font-medium">
          Test a string
        </label>
        <Input
          id={inputId}
          value={text}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <JobResult result={data}>
        {({ trace }) => (
          <Player
            key={settled}
            trace={trace}
            name="automaton"
            renderStage={renderStage}
            onStep={onStep}
            {...(onUsed ? { onInteract: onUsed } : {})}
            stageExport={{
              width: Math.max(layout.width, tapeSize(settled.length).width),
              height: layout.height + tapeSize(settled.length).height,
              render: ({ state }) => (
                <>
                  <Tape state={state} />
                  <AutomatonGraph
                    nodes={nodesFor(state)}
                    edges={edges}
                    layout={layout}
                    animated={false}
                    y={tapeSize(settled.length).height}
                  />
                </>
              ),
            }}
          />
        )}
      </JobResult>
    </div>
  );
}

function CompareWithRegex({ nfa }: { nfa: Nfa }) {
  const [regex, setRegex] = useState('');
  const settled = useDebouncedValue(regex);
  const id = useId();
  const { data } = useEngineJob('compareBuilt', settled.trim() ? { nfa, regex: settled } : null);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        Check against a regular expression
      </label>
      <Input
        id={id}
        value={regex}
        placeholder="(a|b)*abb"
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
        onChange={(event) => setRegex(event.target.value)}
      />
      {settled.trim() && data ? (
        data.ok ? (
          <p role="status" className="mt-1 text-sm">
            {data.value.equivalent ? (
              <span className="text-success">Your automaton accepts exactly this language.</span>
            ) : (
              <span className="text-warning">
                Not the same language.{' '}
                {data.value.acceptedBy === 'first'
                  ? 'Your automaton accepts'
                  : 'The expression accepts'}{' '}
                {data.value.witness === '' ? (
                  'the empty string'
                ) : (
                  <code className="font-mono">"{data.value.witness}"</code>
                )}
                , but{' '}
                {data.value.acceptedBy === 'first'
                  ? 'the expression does not'
                  : 'your automaton does not'}
                .
              </span>
            )}
          </p>
        ) : (
          <div className="mt-2">
            <InputError error={data.error} source={settled} />
          </div>
        )
      ) : null}
    </div>
  );
}

export default function AutomataBuilder({ initial, onUsed }: VisualizerProps) {
  const [startAutomaton] = useState(() => initialAutomaton(initial?.preset));
  const [nodes, setNodes] = useState<StateFlowNode[]>(() => toFlowNodes(startAutomaton));
  const [edges, setEdges] = useState<TransitionFlowEdge[]>(() => toFlowEdges(startAutomaton));
  const [startId, setStartId] = useState<string | null>(startAutomaton.startId);
  const [selection, setSelection] = useState<{ node?: string; edge?: string }>({});
  const [active, setActive] = useState<readonly string[]>([]);
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [newLabel, setNewLabel] = useState('a');

  const { settings } = useSettings();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const labelFieldId = useId();

  const automaton = useMemo<BuilderAutomaton>(
    () => ({
      startId,
      states: nodes.map((node) => ({
        id: node.id,
        label: node.data.label,
        accepting: node.data.accepting,
        x: node.position.x,
        y: node.position.y,
      })),
      transitions: edges.map((edge) => ({
        id: edge.id,
        from: edge.source,
        to: edge.target,
        label: edge.data?.label ?? '',
      })),
    }),
    [nodes, edges, startId],
  );

  const settledAutomaton = useDebouncedValue(automaton, 200);
  useEffect(() => writeJson(DRAFT_KEY, settledAutomaton), [settledAutomaton]);
  const built = useMemo(() => buildAutomaton(settledAutomaton), [settledAutomaton]);

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: { ...node.data, start: node.id === startId, active: active.includes(node.id) },
      })),
    [nodes, startId, active],
  );
  const displayEdges = useMemo(() => {
    const pairs = new Set(edges.map(({ source, target }) => `${source}>${target}`));
    // So an edge can curve around the states between its two ends.
    const obstacles = nodes.map(({ position }) => ({
      x: position.x + STATE_RADIUS,
      y: position.y + STATE_RADIUS,
    }));
    return edges.map((edge) => ({
      ...edge,
      data: {
        obstacles,
        label: edge.data?.label ?? '',
        hasReverse: edge.source !== edge.target && pairs.has(`${edge.target}>${edge.source}`),
      },
    }));
  }, [edges, nodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StateFlowNode>[]) => setNodes((all) => applyNodeChanges(changes, all)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<TransitionFlowEdge>[]) =>
      setEdges((all) => applyEdgeChanges(changes, all)),
    [],
  );
  const onSelectionChange = useCallback(
    ({ nodes: picked, edges: pickedEdges }: OnSelectionChangeParams) => {
      setSelection({
        ...(picked[0] ? { node: picked[0].id } : {}),
        ...(pickedEdges[0] ? { edge: pickedEdges[0].id } : {}),
      });
    },
    [],
  );

  const addEdge = useCallback((from: string, to: string, label: string) => {
    setEdges((all) => {
      const existing = all.find((edge) => edge.source === from && edge.target === to);
      if (existing) {
        const current = existing.data?.label ?? '';
        const merged = current
          .split(',')
          .map((part) => part.trim())
          .includes(label)
          ? current
          : `${current}, ${label}`;
        return all.map((edge) =>
          edge.id === existing.id
            ? { ...edge, data: { label: merged, hasReverse: false, obstacles: [] }, selected: true }
            : { ...edge, selected: false },
        );
      }
      const id = `e${Date.now()}${Math.round(Math.random() * 1000)}`;
      return [
        ...all.map((edge) => ({ ...edge, selected: false })),
        {
          id,
          type: 'transition' as const,
          source: from,
          target: to,
          selected: true,
          data: { label, hasReverse: false, obstacles: [] },
        },
      ];
    });
  }, []);

  const onConnect = useCallback(
    ({ source, target }: Connection) => addEdge(source, target, 'a'),
    [addEdge],
  );

  const addState = () => {
    const used = new Set(nodes.map((node) => node.data.label));
    let number = 0;
    while (used.has(`q${number}`)) number++;
    const id = `q${number}-${Date.now()}`;
    const position = {
      x: 40 + (nodes.length % 5) * 110,
      y: 60 + Math.floor(nodes.length / 5) * 110,
    };
    setNodes((all) => [
      ...all.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: 'state' as const,
        position,
        dragHandle: '.state-drag',
        selected: true,
        data: { label: `q${number}`, accepting: false, start: false, active: false },
      },
    ]);
    if (startId === null) setStartId(id);
  };

  const removeSelected = () => {
    if (selection.node) {
      setNodes((all) => all.filter((node) => node.id !== selection.node));
      setEdges((all) =>
        all.filter((edge) => edge.source !== selection.node && edge.target !== selection.node),
      );
      if (startId === selection.node) setStartId(null);
    } else if (selection.edge) {
      setEdges((all) => all.filter((edge) => edge.id !== selection.edge));
    }
    setSelection({});
  };

  const load = (next: BuilderAutomaton) => {
    setNodes(toFlowNodes(next));
    setEdges(toFlowEdges(next));
    setStartId(next.startId);
    setSelection({});
  };

  const selectedNode = nodes.find((node) => node.id === selection.node);
  const selectedEdge = edges.find((edge) => edge.id === selection.edge);
  const fromValue = nodes.some((node) => node.id === newFrom) ? newFrom : (nodes[0]?.id ?? '');
  const toValue = nodes.some((node) => node.id === newTo) ? newTo : (nodes[0]?.id ?? '');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={addState}>
          <Plus aria-hidden="true" />
          Add state
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!selectedNode && !selectedEdge}
          onClick={removeSelected}
        >
          <Trash2 aria-hidden="true" />
          Delete selected
        </Button>
        <span className="ml-auto flex items-center gap-1 text-xs text-ink-muted">
          Load:
          <Button size="sm" variant="ghost" onClick={() => load(ENDS_IN_ABB)}>
            Ends in abb
          </Button>
          <Button size="sm" variant="ghost" onClick={() => load(A_OR_B)}>
            ε-NFA
          </Button>
          <Button size="sm" variant="ghost" onClick={() => load(EMPTY_AUTOMATON)}>
            Empty
          </Button>
        </span>
      </div>

      <div
        className="h-80 overflow-hidden rounded-md border border-line bg-surface"
        role="group"
        aria-label="Automaton canvas. Drag from a state's ring to draw an edge. The form below does the same without dragging."
      >
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          connectionMode={ConnectionMode.Loose}
          colorMode={resolveTheme(settings.theme, prefersDark)}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          minZoom={0.3}
          maxZoom={2}
          deleteKeyCode={['Delete', 'Backspace']}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {selectedNode ? (
        <div className="flex flex-wrap items-end gap-3 rounded-md bg-surface-2 p-3">
          <div>
            <label htmlFor={labelFieldId} className="mb-1 block text-sm font-medium">
              State name
            </label>
            <Input
              id={labelFieldId}
              className="w-28 font-mono"
              value={selectedNode.data.label}
              maxLength={6}
              onChange={(event) =>
                setNodes((all) =>
                  all.map((node) =>
                    node.id === selectedNode.id
                      ? { ...node, data: { ...node.data, label: event.target.value } }
                      : node,
                  ),
                )
              }
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selectedNode.data.accepting}
              onChange={(event) =>
                setNodes((all) =>
                  all.map((node) =>
                    node.id === selectedNode.id
                      ? { ...node, data: { ...node.data, accepting: event.target.checked } }
                      : node,
                  ),
                )
              }
            />
            Accepting
          </label>
          <Button
            size="sm"
            disabled={startId === selectedNode.id}
            onClick={() => setStartId(selectedNode.id)}
          >
            {startId === selectedNode.id ? 'This is the start state' : 'Make start state'}
          </Button>
        </div>
      ) : null}

      {selectedEdge ? (
        <div className="rounded-md bg-surface-2 p-3">
          <label htmlFor={labelFieldId} className="mb-1 block text-sm font-medium">
            Edge symbols
          </label>
          <Input
            id={labelFieldId}
            className="w-48 font-mono"
            value={selectedEdge.data?.label ?? ''}
            onChange={(event) =>
              setEdges((all) =>
                all.map((edge) =>
                  edge.id === selectedEdge.id
                    ? {
                        ...edge,
                        data: { label: event.target.value, hasReverse: false, obstacles: [] },
                      }
                    : edge,
                ),
              )
            }
          />
          <p className="mt-1 text-xs text-ink-muted">
            Separate symbols with commas. Use ε for an empty move, or a class like [0-9].
          </p>
        </div>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2"
        aria-label="Add a transition"
        onSubmit={(event) => {
          event.preventDefault();
          if (fromValue && toValue && newLabel.trim()) addEdge(fromValue, toValue, newLabel.trim());
        }}
      >
        <label className="flex items-center gap-1.5 text-sm font-medium">
          From
          <NativeSelect
            className="w-24"
            value={fromValue}
            onChange={(event) => setNewFrom(event.target.value)}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.data.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex items-center gap-1.5 text-sm font-medium">
          On
          <Input
            className="w-24 font-mono"
            value={newLabel}
            spellCheck={false}
            onChange={(event) => setNewLabel(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm font-medium">
          To
          <NativeSelect
            className="w-24"
            value={toValue}
            onChange={(event) => setNewTo(event.target.value)}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.data.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button size="sm" type="submit" disabled={nodes.length === 0}>
          Add transition
        </Button>
      </form>

      {built.ok ? (
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            This is
            <Badge tone="accent">
              {built.kind === 'DFA' && !built.complete
                ? 'a partial DFA'
                : `an ${built.kind}`.replace('an DFA', 'a DFA')}
            </Badge>
            <span className="text-ink-muted">
              {built.kind === 'DFA'
                ? built.complete
                  ? 'Exactly one move on every symbol, from every state.'
                  : 'At most one move on each symbol. A missing move rejects.'
                : built.kind === 'NFA'
                  ? 'Some state has more than one move on the same symbol.'
                  : 'It has moves that read no input.'}
            </span>
          </p>
          <TestRun
            automaton={settledAutomaton}
            nfa={built.nfa}
            onActive={setActive}
            onUsed={onUsed}
          />
          <CompareWithRegex nfa={built.nfa} />
        </div>
      ) : (
        <ul className="space-y-0.5 rounded-md border border-line-strong p-3 text-sm text-ink-muted">
          {built.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
