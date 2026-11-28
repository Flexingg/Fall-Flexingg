/**
 * Queries for the configurable rings, the day-stats screen and the light badge summary. Direct mode
 * (Android without a Gauntlet server) reads and saves the ring setup on the phone.
 */
import type { BadgeSummary, DayResponse, RingConfig } from '@gauntlet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { get, put } from './api';
import { session } from './session';

export const ringKeys = {
  rings: ['rings'] as const,
  day: (date: string) => ['day', date] as const,
  badgeSummary: ['badges', 'summary'] as const,
};

export const useRingConfig = () =>
  useQuery({
    queryKey: ringKeys.rings,
    queryFn: async (): Promise<RingConfig> =>
      session.direct
        ? session.direct.rings()
        : (await get<{ rings: RingConfig }>('/api/me/rings')).rings,
  });

/** One day's stats; `date` empty means today. */
export const useDay = (date: string) =>
  useQuery({
    queryKey: ringKeys.day(date),
    queryFn: () =>
      session.direct
        ? session.direct.day(date || undefined)
        : get<DayResponse>(`/api/me/day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

/** Level, XP and newest badge: cheap, and only on a server (direct mode has no badges). */
export const useBadgeSummary = (enabled = true) =>
  useQuery({
    queryKey: ringKeys.badgeSummary,
    enabled: enabled && !session.direct,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: () => get<BadgeSummary>('/api/badges/summary'),
  });

/** Saves the rings, then refreshes Today, the day screen and (through Today) the widget. */
export function useSaveRings() {
  const qc = useQueryClient();
  return useCallback(
    async (rings: RingConfig): Promise<RingConfig> => {
      const saved = session.direct
        ? await session.direct.saveRings(rings)
        : (await put<{ rings: RingConfig }>('/api/me/rings', { rings })).rings;
      qc.setQueryData(ringKeys.rings, saved);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['today'] }),
        qc.invalidateQueries({ queryKey: ['day'] }),
      ]);
      return saved;
    },
    [qc],
  );
}
