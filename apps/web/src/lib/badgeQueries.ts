/** Queries for badges and levels (server only; direct mode has none). */
import type {
  BadgeCatalogResponse,
  BadgeDetailResponse,
  BadgeTimelineResponse,
  UnseenBadgesResponse,
  XpRaceRange,
  XpRaceResponse,
} from '@gauntlet/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError, get } from './api';
import { session } from './session';

export const badgeKeys = {
  all: ['badges'] as const,
  catalog: (userId: string) => ['badges', 'catalog', userId] as const,
  detail: (key: string, userId: string) => ['badges', 'detail', key, userId] as const,
  unseen: ['badges', 'unseen'] as const,
  race: (range: XpRaceRange) => ['badges', 'race', range] as const,
  timeline: (userId: string) => ['badges', 'timeline', userId] as const,
};

/**
 * Someone's badges (or your own). Null, not an error, when the server says 404: they keep their
 * stats private, and the screens just show nothing.
 */
export const useBadgeCatalog = (userId: string, enabled = true) =>
  useQuery({
    queryKey: badgeKeys.catalog(userId),
    enabled: enabled && !!userId && !session.direct,
    // Working out progress for every badge is not free; screens that just look can reuse it.
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
    queryFn: async (): Promise<BadgeCatalogResponse | null> => {
      try {
        return await get<BadgeCatalogResponse>(`/api/users/${encodeURIComponent(userId)}/badges`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

export const useBadgeDetail = (key: string, userId: string) =>
  useQuery({
    queryKey: badgeKeys.detail(key, userId),
    enabled: !!key && !!userId && !session.direct,
    retry: false,
    queryFn: () =>
      get<BadgeDetailResponse>(
        `/api/badges/${encodeURIComponent(key)}?user=${encodeURIComponent(userId)}`,
      ),
  });

/** Newly earned badges that haven't been celebrated yet. */
export const useUnseenBadges = (enabled: boolean) =>
  useQuery({
    queryKey: badgeKeys.unseen,
    enabled: enabled && !session.direct,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
    queryFn: () => get<UnseenBadgesResponse>('/api/badges/unseen'),
  });

/** You and your friends' total XP over time, for the race chart. */
export const useXpRace = (range: XpRaceRange, enabled = true) =>
  useQuery({
    queryKey: badgeKeys.race(range),
    enabled: enabled && !session.direct,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => get<XpRaceResponse>(`/api/badges/race?range=${range}`),
  });

/**
 * Every badge tier someone earned, newest first, a page at a time. Null (not an error) when the
 * server says 404: they keep their stats private.
 */
export const useBadgeTimeline = (userId: string) =>
  useInfiniteQuery({
    queryKey: badgeKeys.timeline(userId),
    enabled: !!userId && !session.direct,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
    initialPageParam: null as string | null,
    getNextPageParam: (last: BadgeTimelineResponse | null) => last?.nextCursor ?? undefined,
    queryFn: async ({ pageParam }): Promise<BadgeTimelineResponse | null> => {
      const qs = pageParam ? `?before=${encodeURIComponent(pageParam)}` : '';
      try {
        return await get<BadgeTimelineResponse>(
          `/api/users/${encodeURIComponent(userId)}/badges/timeline${qs}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
