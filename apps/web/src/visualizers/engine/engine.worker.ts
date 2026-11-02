import { runJob, type JobKind } from './jobs';

self.onmessage = (event: MessageEvent<{ id: number; kind: JobKind; input: never }>) => {
  const { id, kind, input } = event.data;
  self.postMessage({ id, result: runJob(kind, input) });
};
