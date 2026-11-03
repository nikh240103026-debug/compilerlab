import type {
  LabClientMessage,
  LabDiagnostic,
  LabEngine,
  LabEvent,
  LabGeneratedFile,
  LabOutcome,
  LabStream,
} from '@compilerlab/shared';
import { useCallback, useEffect, useReducer, useRef } from 'react';

export interface LabStepView {
  id: string;
  label: string;
  command: string;
  outcome: LabOutcome | null;
  exitCode: number | null;
  durationMs: number | null;
  message: string | null;
  output: string;
}

export interface LabRunState {
  status: 'idle' | 'running' | 'finished';
  engine: LabEngine | null;
  note: string | null;
  steps: LabStepView[];
  /** What the program itself printed, for the Output tab. */
  programOutput: { stream: LabStream; text: string }[];
  diagnostics: LabDiagnostic[];
  generated: LabGeneratedFile[];
  tokens: Extract<LabEvent, { type: 'tokens' }> | null;
  visual: Extract<LabEvent, { type: 'visual' }> | null;
  check: Extract<LabEvent, { type: 'check' }> | null;
  done: { outcome: LabOutcome; message: string } | null;
  error: { code: string; message: string; hint: string | null; fix: string[] } | null;
}

export const INITIAL_RUN: LabRunState = {
  status: 'idle',
  engine: null,
  note: null,
  steps: [],
  programOutput: [],
  diagnostics: [],
  generated: [],
  tokens: null,
  visual: null,
  check: null,
  done: null,
  error: null,
};

export type LabRunAction =
  { type: 'reset' } | { type: 'event'; event: LabEvent } | { type: 'disconnected' };

const DISCONNECTED = {
  code: 'disconnected',
  message: 'The connection to the local CompilerLab server closed before this job finished.',
  hint: 'Check that the terminal running npm start is still open, then try again.',
  fix: [],
};

function applyEvent(state: LabRunState, event: LabEvent): LabRunState {
  switch (event.type) {
    case 'started':
      return { ...state, engine: event.engine, note: event.note };
    case 'step':
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            id: event.id,
            label: event.label,
            command: event.command,
            outcome: null,
            exitCode: null,
            durationMs: null,
            message: null,
            output: '',
          },
        ],
      };
    case 'output': {
      const steps = state.steps.map((step) =>
        step.id === event.step ? { ...step, output: step.output + event.data } : step,
      );
      if (event.step !== 'run') return { ...state, steps };
      const last = state.programOutput.at(-1);
      const programOutput =
        last?.stream === event.stream
          ? [...state.programOutput.slice(0, -1), { ...last, text: last.text + event.data }]
          : [...state.programOutput, { stream: event.stream, text: event.data }];
      return { ...state, steps, programOutput };
    }
    case 'step-end':
      return {
        ...state,
        steps: state.steps.map((step) =>
          step.id === event.step
            ? {
                ...step,
                outcome: event.outcome,
                exitCode: event.exitCode,
                durationMs: event.durationMs,
                message: event.message,
              }
            : step,
        ),
      };
    case 'diagnostics':
      return { ...state, diagnostics: event.items };
    case 'generated':
      return { ...state, generated: event.files };
    case 'tokens':
      return { ...state, tokens: event };
    case 'visual':
      return { ...state, visual: event };
    case 'check':
      return { ...state, check: event };
    case 'done':
      return { ...state, status: 'finished', done: event };
    case 'error':
      return {
        ...state,
        status: 'finished',
        error: { code: event.code, message: event.message, hint: event.hint, fix: event.fix },
      };
  }
}

/** Every change to a run goes through here, which keeps it easy to test without a server. */
export function labRunReducer(state: LabRunState, action: LabRunAction): LabRunState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_RUN, status: 'running' };
    case 'event':
      return applyEvent(state, action.event);
    case 'disconnected':
      return state.status === 'running'
        ? { ...state, status: 'finished', error: DISCONNECTED }
        : state;
  }
}

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/lab/ws`;
}

/**
 * Runs one lab job at a time over its own WebSocket. Each event also goes to `onEvent`, because
 * the terminal is written to directly rather than through React state.
 */
export function useLabRun(onEvent: (event: LabEvent) => void) {
  const [state, dispatch] = useReducer(labRunReducer, INITIAL_RUN);
  const socket = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const close = useCallback(() => {
    const current = socket.current;
    socket.current = null;
    current?.close();
  }, []);

  const start = useCallback(
    (message: LabClientMessage) => {
      close();
      dispatch({ type: 'reset' });
      const next = new WebSocket(socketUrl());
      socket.current = next;
      next.addEventListener('open', () => next.send(JSON.stringify(message)));
      next.addEventListener('message', (incoming) => {
        if (socket.current !== next) return;
        const event = JSON.parse(String(incoming.data)) as LabEvent;
        dispatch({ type: 'event', event });
        onEventRef.current(event);
        if (event.type === 'done' || event.type === 'error') close();
      });
      next.addEventListener('close', () => {
        if (socket.current === next) {
          socket.current = null;
          dispatch({ type: 'disconnected' });
        }
      });
    },
    [close],
  );

  const stop = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'stop' } satisfies LabClientMessage));
    }
  }, []);

  // Closing the socket also stops the job on the server.
  useEffect(() => close, [close]);

  return { state, start, stop };
}
