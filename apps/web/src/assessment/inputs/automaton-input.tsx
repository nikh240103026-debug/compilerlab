import type { DrawnAutomaton } from '@compilerlab/shared';
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useSettings } from '@/hooks/use-settings';
import { resolveTheme } from '@/lib/apply-settings';
import {
  displayEdges,
  displayNodes,
  EDGE_TYPES,
  fromFlow,
  NODE_TYPES,
  toFlowEdges,
  toFlowNodes,
  type StateFlowNode,
  type TransitionFlowEdge,
} from '@/visualizers/automaton-flow';
import { useDebouncedValue } from '@/visualizers/engine/use-engine';
import { tableCellClass, tableHeaderClass, type AnswerInputProps } from './shared';

const EMPTY: DrawnAutomaton = { states: [], transitions: [], startId: null };

/**
 * Draw on the canvas with a mouse, or use the lists underneath, which do everything the canvas does.
 * Each is a full way to answer, so nobody needs to drag anything. This file is its own chunk,
 * because React Flow should only load for a question that draws.
 */
export default function AutomatonInput({
  question,
  value,
  onChange,
  disabled,
}: AnswerInputProps<'automaton'>) {
  const [start] = useState(() => value?.drawing ?? EMPTY);
  const [nodes, setNodes] = useState<StateFlowNode[]>(() => toFlowNodes(start));
  const [edges, setEdges] = useState<TransitionFlowEdge[]>(() => toFlowEdges(start));
  const [startId, setStartId] = useState<string | null>(start.startId);
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [newLabel, setNewLabel] = useState('a');
  const groupName = useId();

  const { settings } = useSettings();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  const drawing = useMemo(() => fromFlow(nodes, edges, startId), [nodes, edges, startId]);
  const settled = useDebouncedValue(drawing, 200);

  // Only a real change counts as an answer, so opening a question does not mark it answered.
  const reported = useRef(JSON.stringify(start));
  const report = useRef(onChange);
  report.current = onChange;
  useEffect(() => {
    if (disabled) return;
    const text = JSON.stringify(settled);
    if (text === reported.current) return;
    reported.current = text;
    report.current({ type: 'automaton', drawing: settled });
  }, [settled, disabled]);

  const shownNodes = useMemo(() => displayNodes(nodes, startId), [nodes, startId]);
  const shownEdges = useMemo(() => displayEdges(nodes, edges), [nodes, edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StateFlowNode>[]) => setNodes((all) => applyNodeChanges(changes, all)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<TransitionFlowEdge>[]) =>
      setEdges((all) => applyEdgeChanges(changes, all)),
    [],
  );

  const addEdge = useCallback((from: string, to: string, label: string) => {
    setEdges((all) => {
      const existing = all.find((edge) => edge.source === from && edge.target === to);
      if (existing) {
        const current = existing.data?.label ?? '';
        const parts = current.split(',').map((part) => part.trim());
        if (parts.includes(label)) return all;
        return all.map((edge) =>
          edge.id === existing.id
            ? {
                ...edge,
                data: { label: `${current}, ${label}`, hasReverse: false, obstacles: [] },
              }
            : edge,
        );
      }
      return [
        ...all,
        {
          id: `e${Date.now()}${Math.round(Math.random() * 1000)}`,
          type: 'transition' as const,
          source: from,
          target: to,
          data: { label, hasReverse: false, obstacles: [] },
        },
      ];
    });
  }, []);

  const onConnect = useCallback(
    ({ source, target }: Connection) => addEdge(source, target, newLabel.trim() || 'a'),
    [addEdge, newLabel],
  );

  const addState = () => {
    const used = new Set(nodes.map((node) => node.data.label));
    let number = 0;
    while (used.has(`q${number}`)) number++;
    const id = `q${number}-${Date.now()}`;
    setNodes((all) => [
      ...all,
      {
        id,
        type: 'state' as const,
        position: {
          x: 40 + (all.length % 5) * 110,
          y: 60 + Math.floor(all.length / 5) * 110,
        },
        dragHandle: '.state-drag',
        data: { label: `q${number}`, accepting: false, start: false, active: false },
      },
    ]);
    if (startId === null) setStartId(id);
  };

  const changeState = (id: string, change: { label?: string; accepting?: boolean }) =>
    setNodes((all) =>
      all.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...change } } : node)),
    );

  const removeState = (id: string) => {
    setNodes((all) => all.filter((node) => node.id !== id));
    setEdges((all) => all.filter((edge) => edge.source !== id && edge.target !== id));
    if (startId === id) setStartId(null);
  };

  const changeEdgeLabel = (id: string, label: string) =>
    setEdges((all) =>
      all.map((edge) =>
        edge.id === id ? { ...edge, data: { label, hasReverse: false, obstacles: [] } } : edge,
      ),
    );

  const nameOf = (id: string) => nodes.find((node) => node.id === id)?.data.label ?? id;
  const fromValue = nodes.some((node) => node.id === newFrom) ? newFrom : (nodes[0]?.id ?? '');
  const toValue = nodes.some((node) => node.id === newTo) ? newTo : (nodes[0]?.id ?? '');

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Draw a{question.machine === 'dfa' ? ' DFA' : 'n NFA'}
        {question.maxStates ? ` with at most ${question.maxStates} states` : ''}.
        {disabled
          ? ''
          : " On the canvas, drag from a ring to draw an edge. Separate an edge's symbols with commas, and use ε for an empty move."}
      </p>
      <div
        className="h-72 overflow-hidden rounded-md border border-line bg-surface"
        role="group"
        aria-label="Automaton canvas. The lists below do everything the canvas does, without dragging."
      >
        <ReactFlow
          nodes={shownNodes}
          edges={shownEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={disabled ? undefined : onNodesChange}
          onEdgesChange={disabled ? undefined : onEdgesChange}
          onConnect={disabled ? undefined : onConnect}
          connectionMode={ConnectionMode.Loose}
          colorMode={resolveTheme(settings.theme, prefersDark)}
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          elementsSelectable={!disabled}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          minZoom={0.3}
          maxZoom={2}
          deleteKeyCode={disabled ? null : ['Delete', 'Backspace']}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <fieldset disabled={disabled} className="space-y-3">
        <legend className="sr-only">The states and transitions of your automaton</legend>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">States</p>
            {!disabled ? (
              <Button size="sm" onClick={addState}>
                <Plus aria-hidden="true" />
                Add state
              </Button>
            ) : null}
          </div>
          {nodes.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">The states of your automaton</caption>
                <thead>
                  <tr>
                    {['Name', 'Start', 'Accepting', ''].map((header, index) => (
                      <th key={index} scope="col" className={tableHeaderClass}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => (
                    <tr key={node.id}>
                      <td className={tableCellClass}>
                        <Input
                          aria-label="State name"
                          className="h-8 w-24 font-mono text-[0.8125rem]"
                          maxLength={6}
                          value={node.data.label}
                          onChange={(event) => changeState(node.id, { label: event.target.value })}
                        />
                      </td>
                      <td className={`${tableCellClass} text-center`}>
                        <input
                          type="radio"
                          name={groupName}
                          aria-label={`${node.data.label} is the start state`}
                          checked={startId === node.id}
                          onChange={() => setStartId(node.id)}
                        />
                      </td>
                      <td className={`${tableCellClass} text-center`}>
                        <input
                          type="checkbox"
                          aria-label={`${node.data.label} is accepting`}
                          checked={node.data.accepting}
                          onChange={(event) =>
                            changeState(node.id, { accepting: event.target.checked })
                          }
                        />
                      </td>
                      <td className={`${tableCellClass} text-center`}>
                        {!disabled ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete state ${node.data.label}`}
                            onClick={() => removeState(node.id)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No states yet.</p>
          )}
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">Transitions</p>
          {edges.length > 0 ? (
            <ul className="mb-2 space-y-1">
              {edges.map((edge) => (
                <li key={edge.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{nameOf(edge.source)}</span>
                  <Input
                    aria-label={`Symbols from ${nameOf(edge.source)} to ${nameOf(edge.target)}`}
                    className="h-8 w-28 font-mono text-[0.8125rem]"
                    spellCheck={false}
                    value={edge.data?.label ?? ''}
                    onChange={(event) => changeEdgeLabel(edge.id, event.target.value)}
                  />
                  <span aria-hidden="true">→</span>
                  <span className="font-mono">{nameOf(edge.target)}</span>
                  {!disabled ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete the transition from ${nameOf(edge.source)} to ${nameOf(edge.target)}`}
                      onClick={() => setEdges((all) => all.filter((other) => other.id !== edge.id))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-sm text-ink-muted">No transitions yet.</p>
          )}
          {!disabled ? (
            <div
              role="group"
              aria-label="Add a transition"
              className="flex flex-wrap items-end gap-2"
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
              <Button
                size="sm"
                disabled={nodes.length === 0 || !newLabel.trim()}
                onClick={() => addEdge(fromValue, toValue, newLabel.trim())}
              >
                Add transition
              </Button>
            </div>
          ) : null}
        </div>
      </fieldset>
    </div>
  );
}
