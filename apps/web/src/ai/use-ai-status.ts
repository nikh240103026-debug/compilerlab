import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const AI_STATUS_KEY = ['ai-status'];

/** Whether AI can answer right now, with the numbers behind the quota hint. */
export function useAiStatus() {
  return useQuery({
    queryKey: AI_STATUS_KEY,
    queryFn: api.aiStatus,
    staleTime: 15_000,
    retry: false,
    // A rate limit passes by itself, so the page notices without a reload.
    refetchInterval: (query) => (query.state.data?.state === 'rate_limited' ? 15_000 : false),
  });
}
