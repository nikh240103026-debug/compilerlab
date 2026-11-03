import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useLabExercises() {
  return useQuery({ queryKey: ['lab-exercises'], queryFn: api.labExercises, staleTime: Infinity });
}

export function useLabProgress() {
  return useQuery({ queryKey: ['lab-progress'], queryFn: api.labProgress });
}

/** The saved work for an exercise or free practice, or null if there is none yet. */
export function useSavedWorkspace(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['lab-workspace', id],
    enabled,
    queryFn: async () => (await api.labWorkspace(id)).workspace,
    // The page keeps the latest copy itself. A cached one could undo newer typing.
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
