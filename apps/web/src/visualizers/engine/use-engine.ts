import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { runEngineJob } from './client';
import type { JobInput, JobKind } from './jobs';

/** Waits for typing to pause, so each keystroke does not start a job. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** Results are cached by input, so going back to an earlier input is instant. */
export function useEngineJob<K extends JobKind>(kind: K, input: JobInput<K> | null) {
  return useQuery({
    queryKey: ['engine', kind, input],
    queryFn: () => runEngineJob(kind, input as JobInput<K>),
    enabled: input !== null,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}
