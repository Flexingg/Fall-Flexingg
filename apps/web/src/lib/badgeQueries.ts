/** Queries for badges and levels (server only; direct mode has none). */
import type {
  BadgeCatalogResponse,
  BadgeDetailResponse,
  UnseenBadgesResponse,
} from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get } from './api';
import { session } from './session';

export const badgeKeys = {
  all: ['badges'] as const,
  catalog: (userId: string) => ['badges', 'catalog', userId] as const,
  detail: (key: string, userId: string) => ['badges', 'detail', key, userId] as const,
  unseen: ['badges', 'unseen'] as const,
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
