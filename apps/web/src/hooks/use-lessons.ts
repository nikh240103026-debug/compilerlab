import type { TopicProgressPatch } from '@compilerlab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useLessons() {
  return useQuery({ queryKey: ['lessons'], queryFn: api.lessons, staleTime: 60_000 });
}

export function useTopicBank(topicId: string) {
  return useQuery({
    queryKey: ['bank', topicId],
    queryFn: () => api.topicBank(topicId),
    staleTime: 60_000,
    retry: false,
  });
}

export function useProgress() {
  return useQuery({ queryKey: ['progress'], queryFn: api.progress });
}

/** Failing to save progress never interrupts a student, so errors here stay quiet. */
export function useUpdateProgress(topicId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: TopicProgressPatch) => api.updateProgress(topicId, patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['progress'] }),
  });
}
