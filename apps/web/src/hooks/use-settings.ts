import type { Settings, SettingsPatch } from '@compilerlab/shared';
import { DEFAULT_SETTINGS } from '@compilerlab/shared/constants';
import { applySettingsPatch } from '@compilerlab/shared/settings-patch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { api, describeError } from '@/lib/api';
import { applySettings, SETTINGS_CACHE_KEY } from '@/lib/apply-settings';
import { readJson, writeJson } from '@/lib/storage';
import { toast } from '@/stores/toasts';
import { useMediaQuery } from './use-media-query';

const KEY = ['settings'];

function cachedSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(SETTINGS_CACHE_KEY) };
}

/** Always has a value: the server's when reachable, otherwise the last cached copy. */
export function useSettings() {
  const query = useQuery({ queryKey: KEY, queryFn: api.settings });
  return { ...query, settings: query.data ?? cachedSettings() };
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: KEY,
    // Saves run one at a time, so the last change a student makes is the one that is kept.
    scope: { id: 'settings' },
    mutationFn: api.updateSettings,
    onMutate: async (patch: SettingsPatch) => {
      await client.cancelQueries({ queryKey: KEY });
      const previous = client.getQueryData<Settings>(KEY);
      client.setQueryData(KEY, applySettingsPatch(previous ?? cachedSettings(), patch));
      return { previous };
    },
    onError: (error, _patch, context) => {
      client.setQueryData(KEY, context?.previous);
      toast({
        tone: 'danger',
        title: 'That setting could not be saved',
        description: describeError(error),
      });
    },
    onSuccess: (saved, patch) => {
      // While a newer change is still saving, this older reply would undo it on screen.
      if (client.isMutating({ mutationKey: KEY }) === 1) client.setQueryData(KEY, saved);
      if (patch.toolPaths || patch.geminiModel !== undefined) {
        void client.invalidateQueries({ queryKey: ['system-status'] });
      }
    },
  });
}

export function useResetSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.resetSettings,
    onError: (error) =>
      toast({
        tone: 'danger',
        title: 'Settings could not be restored',
        description: describeError(error),
      }),
    onSuccess: (saved) => {
      client.setQueryData(KEY, saved);
      void client.invalidateQueries({ queryKey: ['system-status'] });
      toast({ tone: 'success', title: 'Default settings restored' });
    },
  });
}

/** For sliders: applies each change immediately and saves once the value settles. */
export function useDebouncedSettingsSave(delayMs = 250) {
  const client = useQueryClient();
  const { mutate } = useUpdateSettings();
  const pending = useRef<SettingsPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (Object.keys(pending.current).length > 0) mutate(pending.current);
    pending.current = {};
  }, [mutate]);

  useEffect(() => flush, [flush]);

  return useCallback(
    (patch: SettingsPatch) => {
      client.setQueryData<Settings>(KEY, (current) =>
        applySettingsPatch(current ?? cachedSettings(), patch),
      );
      pending.current = { ...pending.current, ...patch };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [client, delayMs, flush],
  );
}

/** Keeps the document in sync with the saved settings and the OS theme. */
export function useApplySettings(): void {
  const { settings } = useSettings();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const { theme, fontSize, animationSpeed } = settings;

  useEffect(() => {
    applySettings({ theme, fontSize, animationSpeed }, prefersDark);
    writeJson(SETTINGS_CACHE_KEY, { theme, fontSize, animationSpeed });
  }, [theme, fontSize, animationSpeed, prefersDark]);
}
