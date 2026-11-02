import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useModules() {
  return useQuery({ queryKey: ['modules'], queryFn: api.modules, staleTime: Infinity });
}

export function useSystemStatus() {
  return useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus, staleTime: 60_000 });
}

/** Polls the local server so the shell can say so when it stops. */
export function useServerHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    retry: false,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
}
